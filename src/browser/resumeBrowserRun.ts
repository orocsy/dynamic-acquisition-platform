import type {
  RuntimeCoordinatorResumeRunInput,
  RuntimeCoordinatorTransitionInput,
  RuntimeCoordinatorFailureInput,
} from '../runtime';
import type { RunCheckpoint } from '../runtime';
import { guardPageTargetRef, guardSurrogateSessionId } from './persistenceGuard';
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
  /** Optional; enables §9.5 stale-target recreation (createTarget) and the post-recheck
   *  discovery navigation that generates fresh-window traffic before capture (navigate). */
  pageTargets?: Pick<PageTargetController, 'createTarget' | 'navigate'>;
  /** §9.5: return true ONLY when it is safe to recreate a stale target and retry the recheck. */
  recreationPolicy?: (context: SafeRecreationContext) => boolean;
  /** Optional authoritative binding: maps the session surrogate to its owning
   *  `{ runId, pageTargetRef }`. When provided, the flow verifies the supplied run + page
   *  target belong to the session, closing cross-run target mixing (the checkpoint carries the
   *  session ref but not the page target ref). */
  sessionRegistry?: Pick<BrowserSessionRegistry, 'get'>;
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

export type ResumeBrowserRunOutcome = 'completed' | 'evidence-recorded' | 'recheck-failed' | 'evidence-not-recorded';

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
  // Validate ref SHAPES + OWNERSHIP BEFORE the resume transition: throwing here (no checkpoint
  // change yet) lets the caller fix the input and retry. After resumeRun commits to
  // running_after_resume, a re-resume is rejected, so a late throw would strand the run.
  guardSurrogateSessionId('browserSessionRef', input.browserSessionRef);
  guardPageTargetRef('pageTargetRef', String(input.pageTargetRef));

  // OWNERSHIP (I1/J1): the checkpoint carries only the session ref, so run + page-target
  // ownership is verified against the registry (session -> { daemonId, runId, pageTargetRef })
  // when one is provided. FAIL CLOSED: the record must exist, own this run, AND carry a page
  // target that EXACTLY equals the supplied one -- a record with no bound target does NOT
  // authorize an arbitrary target. Rejected BEFORE transitioning (retryable), like a malformed
  // ref. The record is captured for the recreation daemon check (J5) below.
  const sessionRecord = deps.sessionRegistry?.get(input.browserSessionRef);
  if (deps.sessionRegistry) {
    const ownsRun = sessionRecord !== undefined && sessionRecord.runId === input.runId;
    const ownsTarget =
      sessionRecord?.pageTargetRef !== undefined && String(sessionRecord.pageTargetRef) === String(input.pageTargetRef);
    if (!ownsRun || !ownsTarget) {
      throw new Error('browser session does not own this run / page target');
    }
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
  const failTerminally = async (
    code: string,
    recheckCode: string,
    message: string,
  ): Promise<ResumeBrowserRunResult> => {
    const failed = await deps.coordinator.markFailed({
      runId: input.runId,
      expectedVersion: latestVersion,
      now: input.now,
      code,
      message,
      eventData: { stepId: 'auth_state_recheck', authRecheck: 'failed', recheckCode },
    });
    return { outcome: 'recheck-failed', checkpoint: failed, recheckOk: false, recheckCode };
  };

  // BIND the session to the resumed run authoritatively (I3). The checkpoint MUST carry a
  // browserSessionRef (set at intervention time) and it must equal the supplied one -- absence
  // is NOT permission to adopt a caller-supplied session (that would let a generic completed
  // intervention be resumed with another run's session). A differing ref is a cross-run mix.
  const boundSessionRef = resumed.browserSessionRef;
  if (boundSessionRef === undefined || boundSessionRef !== input.browserSessionRef) {
    return failTerminally('auth-recheck-session-mismatch', 'session-mismatch', 'The supplied browser session is not bound to this run.');
  }
  const sessionRef = boundSessionRef;

  // Every post-transition step is wrapped: a thrown error (rechecker/probe/controller) must
  // become a TERMINAL failure, not a stranded running_after_resume checkpoint (§9.4).
  try {
    let activeTargetRef: PageTargetRef | string = input.pageTargetRef;
    let snapshot = snapshotRecheck(
      await deps.rechecker.recheck({
        runId: input.runId,
        browserSessionRef: sessionRef,
        pageTargetRef: input.pageTargetRef,
        targetUrl: input.targetUrl,
        now: input.now,
      }),
    );

    // §9.5 safe target recreation: ONLY on target-stale, ONLY when a policy explicitly allows
    // it, a recreation controller is present, an intent URL is available, AND the caller
    // asserts NO side effect was in progress (an omitted/unknown value is NOT safe). Once only.
    // The recreation daemon MUST be the session's own daemon (J5): the registry is required and
    // its `daemonId` must equal the supplied `daemonRef.id`, so recreation can't run browser
    // work on another session's daemon. Fail closed -- no registry / no match => no recreation.
    const recreationDaemonBound =
      sessionRecord !== undefined &&
      input.daemonRef !== undefined &&
      String(sessionRecord.daemonId) === String(input.daemonRef.id);
    if (
      snapshot.ok === false &&
      snapshot.code === 'target-stale' &&
      deps.pageTargets &&
      deps.recreationPolicy &&
      typeof input.targetUrl === 'string' &&
      input.targetUrl.length > 0 &&
      input.daemonRef !== undefined &&
      recreationDaemonBound &&
      input.sideEffectInProgress === false &&
      deps.recreationPolicy({ runId: input.runId, targetUrl: input.targetUrl, sideEffectInProgress: false })
    ) {
      const created = await deps.pageTargets.createTarget({
        daemonRef: input.daemonRef,
        runId: input.runId,
        targetUrl: input.targetUrl,
        now: input.now,
      });
      activeTargetRef = created.pageTargetRef;
      snapshot = snapshotRecheck(
        await deps.rechecker.recheck({
          runId: input.runId,
          browserSessionRef: sessionRef,
          pageTargetRef: created.pageTargetRef,
          targetUrl: input.targetUrl,
          now: input.now,
        }),
      );
    }

    if (snapshot.ok === false) {
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

    // Capture drives ONLY the already-authorized target (J2): `activeTargetRef` is either the
    // registry-verified input ref or the target we recreated ourselves. A rechecker-returned
    // `pageTargetRef` is NOT trusted to substitute a different (possibly foreign) page here.
    const captureTargetRef = activeTargetRef;
    // Open a FRESH capture window at the post-recheck boundary: `session.start` resets the
    // source's window (beginCapture), so discovery evidence begins strictly AFTER confirmation
    // -- human-login / recheck traffic is never folded into it -- and a recreated target (a new
    // ref the caller never started) is covered.
    await deps.session.start({ runId: input.runId, pageTargetRef: captureTargetRef, now: input.now });
    // Perform the discovery navigation INSIDE the fresh window (when a navigator + target URL
    // are available), so a real buffering source has deterministic post-recheck traffic to
    // capture -- otherwise start()'s reset would be immediately followed by stop() with nothing
    // in between. A fixture source (tests) needs no navigator; its collect() returns fixtures.
    // navigate() reports a NORMAL failure as `ok: false` (not a throw) and marks the target
    // stale, so an unchecked result would let a stale/zero-evidence run complete (J3): a failed
    // navigation fails the run terminally BEFORE any capture.
    if (deps.pageTargets?.navigate && typeof input.targetUrl === 'string' && input.targetUrl.length > 0) {
      const navResult = await deps.pageTargets.navigate({ pageTargetRef: captureTargetRef, url: input.targetUrl, now: input.now });
      if (!navResult || navResult.ok !== true) {
        return failTerminally('auth-recheck-discovery-nav-failed', 'discovery-nav-failed', 'The post-recheck discovery navigation did not succeed.');
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
        intentId: input.intentId,
        browserSessionRef: sessionRef,
        priorEvidenceRefs: confirmed.evidenceRefs,
        // Record that discovery is the last completed step so a multi-step executor resumes at
        // the right point (not back at auth_state_recheck) when the run stays active.
        lastCompletedStepId: 'discovering_network',
        captureId: input.captureId,
      },
    );
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
    return failTerminally('auth-recheck-error', 'recheck-error', 'The authenticated-state recheck could not be completed.');
  }
}
