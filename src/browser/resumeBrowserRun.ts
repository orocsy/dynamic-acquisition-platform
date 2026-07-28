import type {
  RuntimeCoordinatorResumeRunInput,
  RuntimeCoordinatorTransitionInput,
  RuntimeCoordinatorFailureInput,
} from '../runtime';
import type { RunCheckpoint } from '../runtime';
import { guardPageTargetRef, guardSurrogateSessionId } from './persistenceGuard';
import { buildDaemonRef, daemonIdFromEndpoint, safeDaemonOrigin } from './daemonClient';
import { isSafeNavigationTarget } from './navigationPolicy';
import type { BrowserAuthRechecker, BrowserAuthRecheckResult } from './authRecheck';
import { browserAuthRecheckMessage, isBrowserAuthRecheckFailureCode } from './authRecheck';
import type { EvidenceRecordingCoordinator, BrowserNetworkCaptureFlowResult } from './browserCaptureFlow';
import { runBrowserNetworkCaptureFlow } from './browserCaptureFlow';
import type { NetworkCaptureSession } from './networkCaptureSession';
import type { NetworkEvidenceNormalizerInput, NetworkEvidenceNormalizerResult } from '../discovery/network/types';
import type { PageTargetController } from './pageTargetController';
import type { BrowserSessionRegistry } from './browserSessionRegistry';
import type { BrowserDaemonRef, PageTargetRef } from './types';

/**
 * Phase 3.6 (LLD §9.4): resume a run after a completed human intervention, gated on a
 * browser-backed auth recheck. Keeps Phase 2's transition semantics exactly:
 *
 *   resumeRun -> recheck -> (fail) markFailed
 *                        -> (ok)  confirmResumeAuthRecheck -> capture -> normalize ->
 *                                 recordNormalizedEvidence -> markCompleted
 *
 * INVARIANTS (LLD §9.7): evidence capture/normalization happens ONLY after a successful
 * recheck + confirmResumeAuthRecheck; a failed recheck goes straight to markFailed with NO
 * evidence work. The existing normalizer stays the only Evidence creator (this reuses the 3.4
 * capture flow). The rechecker is UNTRUSTED (any implementation): its `message` is never
 * forwarded (the safe message is re-derived from a validated `code`), its `pageTargetRef` is
 * re-validated to the page:<id> shape before it drives capture, and its `confidence` is clamped.
 */

export interface ResumeAuthCoordinator extends EvidenceRecordingCoordinator {
  resumeRun(input: RuntimeCoordinatorResumeRunInput): Promise<RunCheckpoint>;
  confirmResumeAuthRecheck(input: RuntimeCoordinatorTransitionInput): Promise<RunCheckpoint>;
  markFailed(input: RuntimeCoordinatorFailureInput): Promise<RunCheckpoint>;
  markCompleted(input: RuntimeCoordinatorTransitionInput): Promise<RunCheckpoint>;
}

/** Context a §9.5 safe-target-recreation policy decides on. Recreation is DENIED by default. */
export type SafeRecreationContext = {
  runId: string;
  targetUrl: string;
  /** True if a side-effecting submit/payment/mutation was already in progress (blocks restart). */
  sideEffectInProgress: boolean;
};

export type ResumeBrowserRunDeps = {
  coordinator: ResumeAuthCoordinator;
  rechecker: BrowserAuthRechecker;
  session: NetworkCaptureSession;
  normalize?: (input: NetworkEvidenceNormalizerInput) => NetworkEvidenceNormalizerResult;
  /** Optional; enables §9.5 stale-target recreation (createTarget, plus closeTarget so the
   *  DEAD stale target is actually closed once its replacement exists -- navigate() only
   *  marks a failed target stale, and without closeTarget repeated stale resumes accumulate
   *  live browser pages) and the post-recheck discovery navigation that generates
   *  fresh-window traffic before capture (navigate). Each method is used only if present. */
  pageTargets?: Partial<Pick<PageTargetController, 'createTarget' | 'navigate' | 'closeTarget'>>;
  /** §9.5: return true ONLY when it is safe to recreate a stale target and retry the recheck. */
  recreationPolicy?: (context: SafeRecreationContext) => boolean;
  /** REQUIRED authoritative binding: maps the session surrogate to its owning
   *  `{ daemonId, runId, pageTargetRef }`. The checkpoint binds only the session (it carries no
   *  page target), so without the registry there is nothing to authorize the supplied page
   *  target against -- the flow would drive any well-shaped `page:*` ref. `update` is used to
   *  REBIND the record after a successful stale-target recreation, so the next resume/
   *  intervention authorizes the recreated ref rather than the dead one. */
  sessionRegistry: Pick<BrowserSessionRegistry, 'get' | 'update'>;
};

export type ResumeBrowserRunInput = {
  runId: string;
  expectedVersion: number;
  requestId: string;
  browserSessionRef: string;
  pageTargetRef: PageTargetRef | string;
  targetUrl?: string;
  intentId?: string;
  now?: string;
  /** For §9.5 recreation only (with deps.pageTargets + recreationPolicy). Recreation ALSO
   *  requires `sideEffectInProgress === false` (an omitted/unknown value blocks it). */
  daemonRef?: BrowserDaemonRef;
  sideEffectInProgress?: boolean;
  captureId?: string;
  /** When true, the run is marked COMPLETED after evidence is recorded (a terminal, one-shot
   *  capture). Default false: the run stays `running` after recording so a multi-step plan can
   *  continue — a terminal transition here cannot be undone (LLD §9.4 "markCompleted OR
   *  continue next plan step"), so completion is an explicit caller decision. */
  completeRun?: boolean;
};

export type ResumeBrowserRunOutcome =
  | 'completed'
  | 'evidence-recorded'
  | 'recheck-failed'
  /** Auth WAS confirmed (an `auth.rechecked` event is committed); the run failed afterwards on
   *  discovery work. Kept distinct from `recheck-failed` so consumers don't read an ordinary
   *  navigation failure as another login failure. */
  | 'discovery-failed'
  | 'evidence-not-recorded';

export type ResumeBrowserRunResult = {
  outcome: ResumeBrowserRunOutcome;
  checkpoint: RunCheckpoint;
  recheckOk: boolean;
  recheckCode?: string;
  capture?: BrowserNetworkCaptureFlowResult;
};

function clampConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Snapshot the discriminated fields of an UNTRUSTED recheck result ONCE, requiring a LITERAL
 * boolean `ok`. A foreign result could use getters that flip between the check and the use, or
 * a truthy non-boolean `ok` (`'false'`), so we read each field a single time and treat anything
 * other than `ok === true`/`ok === false` as a failure. `code` is snapshotted for the flow to
 * validate; `message`/`diagnostics` are deliberately NOT read (never forwarded).
 */
type RecheckSnapshot =
  | { ok: true; confidence: number; pageTargetRef: unknown }
  | { ok: false; code: unknown };

function snapshotRecheck(result: BrowserAuthRecheckResult): RecheckSnapshot {
  const ok = (result as { ok?: unknown } | null | undefined)?.ok;
  if (ok === true) {
    const r = result as Extract<BrowserAuthRecheckResult, { ok: true }>;
    return { ok: true, confidence: clampConfidence(r.confidence), pageTargetRef: r.pageTargetRef };
  }
  // Anything that is not the literal `true` discriminator is a failure (incl. `'false'`,
  // undefined, or a getter-flipped value). Snapshot the code for validation downstream.
  return { ok: false, code: (result as { code?: unknown } | null | undefined)?.code };
}

export async function resumeBrowserRun(
  deps: ResumeBrowserRunDeps,
  input: ResumeBrowserRunInput,
): Promise<ResumeBrowserRunResult> {
  // SNAPSHOT the whole input FIRST -- every caller-controlled field is read exactly once,
  // before any validation or browser work. Without this, a JS caller can back a field (e.g.
  // `targetUrl`) with a stateful getter that returns the run's original intent URL to the
  // §9.5 comparison below and a substituted destination to the later policy / createTarget /
  // navigate reads -- passing every check while the browser opens somewhere else. The spread
  // invokes each own getter a single time and yields plain data properties, so all subsequent
  // `input.*` reads are stable. (Object-valued refs are additionally canonicalized to strings
  // by the guards below -- K8; a prototype-hosted getter is simply not copied, which fails
  // closed to `undefined`.)
  input = { ...input };
  // Same discipline one level down: daemonRef.id is compared against the registry's daemon
  // (J5) and later read again inside createTarget/the transport -- a stateful `id` getter OR
  // an object-valued id with a stateful toString() could satisfy the comparison and then
  // recreate the target on a foreign daemon. Copy the ref to data properties (each getter
  // read once) and then CANONICALIZE the captured id to a string primitive in the copy, so
  // its toString() also runs exactly once and every later read -- the J5 comparison, the
  // policy, the controller, the transport -- sees that same immutable value.
  if (input.daemonRef !== undefined && input.daemonRef !== null) {
    const daemonRef = { ...input.daemonRef };
    daemonRef.id = String(daemonRef.id);
    input.daemonRef = daemonRef;
  }

  // Validate ref SHAPES + OWNERSHIP BEFORE the resume transition: throwing here (no checkpoint
  // change yet) lets the caller fix the input and retry. After resumeRun commits to
  // running_after_resume, a re-resume is rejected, so a late throw would strand the run.
  //
  // The guards RETURN the canonical strings and those are the ONLY values used from here on
  // (K8): a caller could pass an object whose stateful `toString()` yields the authorized ref
  // during validation and a foreign one once browser work starts, so the raw input refs are
  // never re-read.
  const sessionRef = guardSurrogateSessionId('browserSessionRef', input.browserSessionRef);
  const inputTargetRef = guardPageTargetRef('pageTargetRef', String(input.pageTargetRef)) as string;

  // OWNERSHIP (I1/J1/K1): the checkpoint carries only the session ref, so run + page-target
  // ownership is verified against the registry (session -> { daemonId, runId, pageTargetRef }).
  // The registry is REQUIRED -- without it nothing authorizes the supplied target and any
  // well-shaped `page:*` ref would drive recheck/navigation/capture. FAIL CLOSED: the record
  // must exist, own this run, AND carry a page target that EXACTLY equals the supplied one.
  // Rejected BEFORE transitioning (retryable), like a malformed ref. The record is also used
  // for the recreation daemon check (J5) below.
  if (!deps.sessionRegistry || typeof deps.sessionRegistry.get !== 'function') {
    throw new Error('a browser session registry is required to authorize the resume page target');
  }
  const sessionRecord = deps.sessionRegistry.get(sessionRef);
  const ownsRun = sessionRecord !== undefined && sessionRecord.runId === input.runId;
  const ownsTarget = sessionRecord?.pageTargetRef !== undefined && String(sessionRecord.pageTargetRef) === inputTargetRef;
  if (!ownsRun || !ownsTarget) {
    throw new Error('browser session does not own this run / page target');
  }

  // A duplicate/stale resume is rejected by the coordinator here (RuntimeCoordinatorError
  // propagates to the caller) BEFORE any recheck or evidence work.
  const resumed = await deps.coordinator.resumeRun({
    runId: input.runId,
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    now: input.now,
  });

  // Track the LATEST committed checkpoint version so a terminal markFailed always targets the
  // current version (each successful transition advances it) -- otherwise a throw after
  // confirm/record would markFailed with a stale version, get rejected, and strand the run.
  let latestVersion = resumed.version;
  /**
   * Terminal failure. `phase` distinguishes a failure BEFORE the auth verdict (`auth`, the
   * classic recheck failure) from one AFTER auth was already confirmed (`discovery`): the
   * latter must not be recorded as `authRecheck: 'failed'` or reported as `recheck-failed`,
   * because an `auth.rechecked` (passed) event is already committed and consumers would
   * otherwise read an ordinary discovery failure as another login failure (K6).
   */
  const failTerminally = async (
    code: string,
    failureCode: string,
    message: string,
    phase: 'auth' | 'discovery' = 'auth',
  ): Promise<ResumeBrowserRunResult> => {
    const failed = await deps.coordinator.markFailed({
      runId: input.runId,
      expectedVersion: latestVersion,
      now: input.now,
      code,
      message,
      eventData:
        phase === 'auth'
          ? { stepId: 'auth_state_recheck', authRecheck: 'failed', recheckCode: failureCode }
          : { stepId: 'discovering_network', authRecheck: 'passed', discoveryFailureCode: failureCode },
    });
    return {
      outcome: phase === 'auth' ? 'recheck-failed' : 'discovery-failed',
      checkpoint: failed,
      recheckOk: phase !== 'auth',
      recheckCode: failureCode,
    };
  };

  // BIND the session to the resumed run authoritatively (I3). The checkpoint MUST carry a
  // browserSessionRef (set at intervention time) and it must equal the supplied one -- absence
  // is NOT permission to adopt a caller-supplied session (that would let a generic completed
  // intervention be resumed with another run's session). A differing ref is a cross-run mix.
  const boundSessionRef = resumed.browserSessionRef;
  if (boundSessionRef === undefined || boundSessionRef !== sessionRef) {
    return failTerminally('auth-recheck-session-mismatch', 'session-mismatch', 'The supplied browser session is not bound to this run.');
  }

  // Close an opened capture window even on a session WITHOUT the optional abort() (K4): a
  // buffering transport must not keep accumulating for a terminal run just because the
  // injected session predates abort. stop() also ends the window; every caller of this helper
  // deliberately DISCARDS its result -- nothing collected here is ever recorded as evidence.
  const teardownWindow = async (ref: string): Promise<void> => {
    if (deps.session.abort) {
      await deps.session.abort({ runId: input.runId, pageTargetRef: ref, now: input.now });
    } else {
      await deps.session.stop({ runId: input.runId, pageTargetRef: ref, now: input.now });
    }
  };

  // Best-effort close of a target this flow itself created (§9.5 replacement). Used on every
  // terminal path after recreation: the ORIGINAL stale target is closed at creation time, but
  // if the retry recheck then fails (or anything later throws) the replacement would stay
  // live, so repeated failed recreations would still accumulate browser pages.
  const closeTargetQuietly = async (ref: string | undefined): Promise<void> => {
    if (ref === undefined || !deps.pageTargets?.closeTarget) return;
    try {
      await deps.pageTargets.closeTarget(ref);
    } catch {
      // best-effort only -- never mask the terminal transition we are about to make
    }
  };

  // Set once confirmResumeAuthRecheck has COMMITTED the passed auth event: any later throw
  // must be classified as a DISCOVERY failure (K6) -- emitting `authRecheck: 'failed'` /
  // `recheck-failed` after that point would contradict the already-committed event stream.
  let authConfirmed = false;
  // The capture window opened by session.start, tracked until the capture flow's entry stop()
  // closes it (or it is aborted): a throw while this is set must abort the window (K4), else a
  // buffering transport keeps accumulating traffic for a run that is already terminal.
  let openWindowRef: string | undefined;
  // Set once §9.5 recreation created a REPLACEMENT target; declared out here so the terminal
  // catch below can close it too.
  let recreatedTargetRef: string | undefined;

  // §9.5/§9.6 URL AUTHORITY, established BEFORE any browser work. The run's own
  // intentSnapshot (on the RESUMED checkpoint, fixed at createRun) is the only authority for
  // the URL this acquisition may visit; a caller-supplied targetUrl is otherwise unbound, so
  // ownership of the run/session/page refs alone must never decide a destination.
  //
  // This is enforced BEFORE the first recheck, not after it: a real rechecker
  // (DetectorBackedAuthRechecker) forwards targetUrl to its AuthStateProbe, which NAVIGATES
  // the authenticated page to establish reachability. Checking only the later discovery
  // navigation would leave that first navigation -- the unsafe browser action itself --
  // already performed. Every url-consuming step (probe, recreation, discovery navigation)
  // now sits behind this one gate. Fail closed when the intent target is missing/not a URL.
  const intentTarget = (resumed.intentSnapshot as { target?: { kind?: unknown; value?: unknown } } | null | undefined)?.target;
  const targetUrlIsOriginalIntent =
    intentTarget !== null &&
    intentTarget !== undefined &&
    intentTarget.kind === 'url' &&
    typeof intentTarget.value === 'string' &&
    intentTarget.value === input.targetUrl;
  // A DEFINED but non-primitive targetUrl (e.g. `new String(...)`, or an object with
  // toString()) would make the `typeof` comparison below false, skip the intent check
  // entirely, and still be forwarded to the rechecker's navigating probe, where a transport
  // coerces it to the substituted destination. Fail closed on the type itself.
  if (input.targetUrl !== undefined && typeof input.targetUrl !== 'string') {
    return failTerminally(
      'resume-url-unauthorized',
      'url-not-intent',
      'The supplied URL is not the acquisition intent URL.',
    );
  }
  if (typeof input.targetUrl === 'string' && input.targetUrl.length > 0 && !targetUrlIsOriginalIntent) {
    return failTerminally(
      'resume-url-unauthorized',
      'url-not-intent',
      'The supplied URL is not the acquisition intent URL.',
    );
  }
  // AUTHORIZED is not the same as SAFE. `intentSnapshot` is stored as `unknown` and the Intent
  // contract constrains no schemes, so a run could legitimately carry `javascript:`,
  // `file://`, `data:` or a credential-bearing URL as its recorded intent -- and an exactly
  // matching targetUrl would sail through the equality gate straight into the rechecker's
  // navigating probe (script execution / local file read / leaked credentials). Allowlist the
  // destination itself before ANY browser work.
  if (typeof input.targetUrl === 'string' && input.targetUrl.length > 0 && !isSafeNavigationTarget(input.targetUrl)) {
    return failTerminally(
      'resume-url-unsafe',
      'unsafe-target',
      browserAuthRecheckMessage('unsafe-target'),
    );
  }

  // EVIDENCE ATTRIBUTION: the run's own intentSnapshot carries the authoritative intentId and
  // the normalizer copies whatever it is given straight onto every Evidence item. A caller
  // passing another acquisition's intentId would pass every run/session/target/URL ownership
  // check and still mis-attribute this run's discovery evidence, so the authoritative value
  // WINS and a mismatching supplied value is refused outright.
  const snapshotIntentId = (resumed.intentSnapshot as { intentId?: unknown } | null | undefined)?.intentId;
  const authoritativeIntentId = typeof snapshotIntentId === 'string' && snapshotIntentId.length > 0 ? snapshotIntentId : undefined;
  if (input.intentId !== undefined && input.intentId !== authoritativeIntentId) {
    return failTerminally(
      'resume-intent-mismatch',
      'intent-mismatch',
      'The supplied intent does not match the acquisition being resumed.',
    );
  }
  const effectiveIntentId = authoritativeIntentId;

  // Every post-transition step is wrapped: a thrown error (rechecker/probe/controller) must
  // become a TERMINAL failure, not a stranded running_after_resume checkpoint (§9.4).
  try {
    // The canonical, guard-returned string (K8) -- never the raw caller value.
    let activeTargetRef: string = inputTargetRef;
    let snapshot = snapshotRecheck(
      await deps.rechecker.recheck({
        runId: input.runId,
        browserSessionRef: sessionRef,
        pageTargetRef: activeTargetRef,
        targetUrl: input.targetUrl,
        now: input.now,
      }),
    );

    // §9.5 safe target recreation: ONLY on target-stale, ONLY when a policy explicitly allows
    // it, a recreation controller is present, an intent URL is available, AND the caller
    // asserts NO side effect was in progress (an omitted/unknown value is NOT safe). Once only.
    // The recreation daemon MUST be the session's own daemon (J5). Checking only `id` was not
    // enough: the whole caller-supplied ref is handed to createTarget and on to the transport,
    // so a caller could keep the registry-approved id while swapping `healthUrlPreview` to a
    // DIFFERENT (even loopback) endpoint or changing `mode`, and recreation would run against
    // a daemon the registry never authorized. Bind every transport-relevant field:
    //   - `kind` must be the only supported literal;
    //   - `mode` must equal the registry record's mode;
    //   - `healthUrlPreview` must be a safe loopback origin AND must DERIVE the registry's
    //     daemonId (`daemonIdFromEndpoint` is how 3.2 mints ids), which is what actually ties
    //     the endpoint to the approved daemon rather than trusting the id string alone.
    // Fail closed -- no registry / any mismatch / an unparseable endpoint => no recreation.
    const recreationDaemonBound = (():
      | { ok: true; daemonRef: BrowserDaemonRef }
      | { ok: false } => {
      const supplied = input.daemonRef;
      if (sessionRecord === undefined || supplied === undefined) return { ok: false };
      const recordDaemonId = String(sessionRecord.daemonId);
      if (String(supplied.id) !== recordDaemonId) return { ok: false };
      if (supplied.kind !== 'local-chrome-daemon') return { ok: false };
      if (String(supplied.mode) !== String(sessionRecord.mode)) return { ok: false };
      let origin: string;
      try {
        origin = safeDaemonOrigin(String(supplied.healthUrlPreview), { requireLoopback: true });
      } catch {
        return { ok: false };
      }
      // `daemonIdFromEndpoint` derives from host:port ONLY, so an approved
      // `http://127.0.0.1:9222` record would equally accept a caller-supplied
      // `https://127.0.0.1:9222` and that caller-chosen scheme would ride through to the
      // transport. A local-chrome-daemon's CDP endpoint is plain http on loopback (see
      // docs/stable-chrome-daemon.md and DEFAULT_DAEMON_ENDPOINT), so pin the scheme rather
      // than leaving one transport-relevant field unbound.
      if (!origin.startsWith('http://')) return { ok: false };
      if (daemonIdFromEndpoint(origin) !== recordDaemonId) return { ok: false };
      // Rebuild a CANONICAL ref from the validated origin + registry-approved mode, so no
      // extra caller-controlled property reaches the controller/transport.
      return { ok: true, daemonRef: buildDaemonRef(origin, sessionRecord.mode) };
    })();
    if (
      snapshot.ok === false &&
      snapshot.code === 'target-stale' &&
      deps.pageTargets?.createTarget &&
      deps.recreationPolicy &&
      typeof input.targetUrl === 'string' &&
      input.targetUrl.length > 0 &&
      targetUrlIsOriginalIntent &&
      recreationDaemonBound.ok &&
      input.sideEffectInProgress === false &&
      deps.recreationPolicy({ runId: input.runId, targetUrl: input.targetUrl, sideEffectInProgress: false })
    ) {
      const created = await deps.pageTargets.createTarget({
        // the canonical, registry-bound ref -- never the caller's object
        daemonRef: recreationDaemonBound.daemonRef,
        runId: input.runId,
        targetUrl: input.targetUrl,
        now: input.now,
      });
      // The recreated ref must itself be a well-formed page ref before anything uses it.
      const createdRef = guardPageTargetRef('recreatedPageTargetRef', String(created.pageTargetRef)) as string;
      // Track it BEFORE the state check: a target that came back in an unusable state was
      // still CREATED, and the controller releases its transport resources only via
      // closeTarget -- failing without recording the ref would leak the raw browser page.
      recreatedTargetRef = createdRef;
      // The returned SNAPSHOT must also be usable. `createTarget` can legitimately resolve
      // with a `stale`/`closed` snapshot when a concurrent lifecycle op changes the reserved
      // target while the transport create is in flight; rebinding the authoritative session
      // to that target (and closing the old one) would strand the session on a dead page.
      // Require the expected `created` state before ANY rebind or close.
      if (created.state !== 'created') {
        await closeTargetQuietly(createdRef);
        return failTerminally(
          'auth-recheck-target-recreation-unusable',
          'target-stale',
          browserAuthRecheckMessage('target-stale'),
        );
      }
      activeTargetRef = createdRef;
      // REBIND the registry to the recreated target (K3): the record still points at the dead
      // stale ref, so a later resume/intervention would be rejected by the exact-ownership check
      // while the registry-approved old target is unusable. The registry stays authoritative.
      deps.sessionRegistry.update({ sessionId: sessionRef, pageTargetRef: activeTargetRef, now: input.now });
      // CLOSE the dead stale target now that its replacement exists and is registry-bound:
      // navigate() only marks a failed target `stale`, so without an explicit close the raw
      // browser page (and its controller mapping) stays live and repeated stale resumes
      // accumulate targets. Best-effort: a close failure must not fail the resume that just
      // recovered -- the replacement is already authoritative.
      if (deps.pageTargets.closeTarget) {
        try {
          await deps.pageTargets.closeTarget(inputTargetRef);
        } catch {
          // best-effort only -- the stale target is already unusable and unregistered
        }
      }
      snapshot = snapshotRecheck(
        await deps.rechecker.recheck({
          runId: input.runId,
          browserSessionRef: sessionRef,
          pageTargetRef: activeTargetRef,
          targetUrl: input.targetUrl,
          now: input.now,
        }),
      );
    }

    if (snapshot.ok === false) {
      // A replacement we created is now orphaned (the retry recheck failed) -- close it.
      await closeTargetQuietly(recreatedTargetRef);
      // Re-derive a SAFE code + message from the VALIDATED failure code; never forward the
      // rechecker's own `message`/`diagnostics` (a foreign rechecker could put secrets there).
      const code = isBrowserAuthRecheckFailureCode(snapshot.code) ? snapshot.code : 'still-unauthorized';
      return failTerminally(`auth-recheck-${code}`, code, browserAuthRecheckMessage(code));
    }

    // Recheck passed -> transition back into normal running. Only now may evidence be captured.
    const confirmed = await deps.coordinator.confirmResumeAuthRecheck({
      runId: input.runId,
      expectedVersion: resumed.version,
      now: input.now,
      phase: 'discovering_network',
      browserSessionRef: sessionRef,
      eventData: { authRecheck: 'passed', recheckConfidence: snapshot.confidence },
    });
    latestVersion = confirmed.version;
    authConfirmed = true;

    // Capture drives ONLY the already-authorized target (J2): `activeTargetRef` is either the
    // registry-verified input ref or the target we recreated ourselves. A rechecker-returned
    // `pageTargetRef` is NOT trusted to substitute a different (possibly foreign) page here.
    const captureTargetRef = activeTargetRef;
    // Open a FRESH capture window at the post-recheck boundary: `session.start` resets the
    // source's window (beginCapture), so discovery evidence begins strictly AFTER confirmation
    // -- human-login / recheck traffic is never folded into it -- and a recreated target (a new
    // ref the caller never started) is covered.
    await deps.session.start({ runId: input.runId, pageTargetRef: captureTargetRef, now: input.now });
    openWindowRef = captureTargetRef;
    // Perform the discovery navigation INSIDE the fresh window (when a navigator + target URL
    // are available), so a real buffering source has deterministic post-recheck traffic to
    // capture -- otherwise start()'s reset would be immediately followed by stop() with nothing
    // in between. A fixture source (tests) needs no navigator; its collect() returns fixtures.
    // navigate() reports a NORMAL failure as `ok: false` (not a throw) and marks the target
    // stale, so an unchecked result would let a stale/zero-evidence run complete (J3). A
    // REJECTED navigate() (target became stale/unknown after recheck) takes the SAME path --
    // surfacing it to the generic catch would otherwise skip the abort below (K4). Success is
    // additionally BOUND to the requested target (K9): an implementation mixing results across
    // concurrent pages could answer ok for a DIFFERENT page, and capture would then run against
    // a target that was never navigated, normalizing unrelated buffered traffic as evidence.
    if (deps.pageTargets?.navigate && typeof input.targetUrl === 'string' && input.targetUrl.length > 0) {
      let navigated = false;
      try {
        const navResult = await deps.pageTargets.navigate({ pageTargetRef: captureTargetRef, url: input.targetUrl, now: input.now });
        navigated = !!navResult && navResult.ok === true && String(navResult.pageTargetRef) === captureTargetRef;
      } catch {
        navigated = false;
      }
      if (!navigated) {
        // TEAR DOWN the window we just opened (K4): the run is terminal, so leaving it active
        // would keep a buffering transport accumulating traffic and expose stale observations
        // to a later stop(). Then fail in the DISCOVERY phase (K6) -- auth already passed.
        await teardownWindow(captureTargetRef);
        openWindowRef = undefined;
        // A replacement target this flow created is orphaned by this terminal failure too --
        // navigate() only marks it stale, so the raw page would stay live.
        await closeTargetQuietly(recreatedTargetRef);
        return failTerminally(
          'discovery-navigation-failed',
          'discovery-nav-failed',
          'The post-recheck discovery navigation did not succeed.',
          'discovery',
        );
      }
    }
    const capture = await runBrowserNetworkCaptureFlow(
      { session: deps.session, coordinator: deps.coordinator, normalize: deps.normalize },
      {
        runId: input.runId,
        pageTargetRef: captureTargetRef,
        expectedVersion: confirmed.version,
        now: input.now,
        targetUrl: input.targetUrl,
        intentId: effectiveIntentId,
        browserSessionRef: sessionRef,
        priorEvidenceRefs: confirmed.evidenceRefs,
        // Record that discovery is the last completed step so a multi-step executor resumes at
        // the right point (not back at auth_state_recheck) when the run stays active.
        lastCompletedStepId: 'discovering_network',
        captureId: input.captureId,
      },
    );
    // The flow's entry stop() has closed the window; from here teardown is no longer owed.
    openWindowRef = undefined;
    if (capture.recorded && capture.checkpoint) {
      latestVersion = capture.checkpoint.version;
    }

    // An error-level normalizer diagnostic stops the capture flow before any transition; the run
    // stays at running for a later step / retry.
    if (!capture.recorded || !capture.checkpoint) {
      return { outcome: 'evidence-not-recorded', checkpoint: confirmed, recheckOk: true, capture };
    }

    // Completion is an EXPLICIT caller decision (§9.4): a terminal transition cannot be undone,
    // so a multi-step run stays `running` after recording unless completeRun was requested.
    if (input.completeRun !== true) {
      return { outcome: 'evidence-recorded', checkpoint: capture.checkpoint, recheckOk: true, capture };
    }
    // A capture can be `recorded` yet carry NO evidence (collect returned nothing, or every
    // observation was mismatched/unsafe/unmappable/normalized away) -- an empty normalization
    // has no error diagnostic. Completing an acquisition that produced zero discovery evidence
    // would be a false success, so require at least one evidence item before the terminal
    // transition (K5); otherwise the run stays active for a retry / next step.
    if (capture.evidenceCount < 1) {
      return { outcome: 'evidence-not-recorded', checkpoint: capture.checkpoint, recheckOk: true, capture };
    }
    const final = await deps.coordinator.markCompleted({
      runId: input.runId,
      expectedVersion: capture.checkpoint.version,
      now: input.now,
      evidenceRefs: capture.evidenceRefs,
      lastCompletedStepId: 'normalizing_evidence',
      eventData: { evidenceRefCount: capture.evidenceRefs.length },
    });
    return { outcome: 'completed', checkpoint: final, recheckOk: true, capture };
  } catch {
    // A post-transition failure (recheck/probe/controller/session throw, or a coordinator error
    // other than the initial resume) must not leave the run stranded. Convert it to a terminal
    // markFailed from the LATEST committed version (updated after confirm/record) -- using a
    // stale version here would itself be rejected. If markFailed still fails, it rethrows
    // (nothing safe remains).
    //
    // A window still open here (start succeeded but the capture flow's stop() never completed)
    // is torn down BEST-EFFORT first (K4) so a buffering transport stops accumulating; a
    // teardown failure must never mask the markFailed below.
    if (openWindowRef !== undefined) {
      try {
        await teardownWindow(openWindowRef);
      } catch {
        // best-effort only -- the terminal markFailed still runs
      }
    }
    // Likewise a replacement target this flow created: the run is about to go terminal, so
    // leaving it open would leak a live browser page.
    await closeTargetQuietly(recreatedTargetRef);
    // Once auth was CONFIRMED the failure belongs to the DISCOVERY phase (K6): the passed
    // auth.rechecked event is committed, so reporting `recheck-failed` here would contradict it
    // and consumers would misread an ordinary discovery failure as another login failure.
    return authConfirmed
      ? failTerminally('discovery-error', 'discovery-error', 'The post-recheck network discovery could not be completed.', 'discovery')
      : failTerminally('auth-recheck-error', 'recheck-error', 'The authenticated-state recheck could not be completed.');
  }
}
