import type {
  RuntimeCoordinatorResumeRunInput,
  RuntimeCoordinatorTransitionInput,
  RuntimeCoordinatorFailureInput,
} from '../runtime';
import type { RunCheckpoint } from '../runtime';
import { isPageTargetRef } from './browserRef';
import { guardPageTargetRef, guardSurrogateSessionId } from './persistenceGuard';
import type { BrowserAuthRechecker, BrowserAuthRecheckResult } from './authRecheck';
import { browserAuthRecheckMessage, isBrowserAuthRecheckFailureCode } from './authRecheck';
import type { EvidenceRecordingCoordinator, BrowserNetworkCaptureFlowResult } from './browserCaptureFlow';
import { runBrowserNetworkCaptureFlow } from './browserCaptureFlow';
import type { NetworkCaptureSession } from './networkCaptureSession';
import type { NetworkEvidenceNormalizerInput, NetworkEvidenceNormalizerResult } from '../discovery/network/types';
import type { PageTargetController } from './pageTargetController';
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
  /** Optional; enables §9.5 stale-target recreation when recreationPolicy also allows it. */
  pageTargets?: Pick<PageTargetController, 'createTarget'>;
  /** §9.5: return true ONLY when it is safe to recreate a stale target and retry the recheck. */
  recreationPolicy?: (context: SafeRecreationContext) => boolean;
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

function safePageTargetRef(candidate: unknown, fallback: PageTargetRef | string): PageTargetRef | string {
  // A foreign rechecker's returned ref must not drive capture unless it is the page:<id> shape.
  return typeof candidate === 'string' && isPageTargetRef(candidate) ? candidate : fallback;
}

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
  // Validate ref SHAPES BEFORE the resume transition: if a ref is malformed, throwing here (no
  // checkpoint change yet) lets the caller fix the input and retry. After resumeRun commits to
  // running_after_resume, a re-resume is rejected, so a late throw would strand the run.
  guardSurrogateSessionId('browserSessionRef', input.browserSessionRef);
  guardPageTargetRef('pageTargetRef', String(input.pageTargetRef));

  // A duplicate/stale resume is rejected by the coordinator here (RuntimeCoordinatorError
  // propagates to the caller) BEFORE any recheck or evidence work.
  const resumed = await deps.coordinator.resumeRun({
    runId: input.runId,
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    now: input.now,
  });

  // BIND the session to the resumed run: the authoritative ref is the one the checkpoint
  // carries from intervention time. A caller-supplied ref that differs is a cross-run mix
  // attempt -> fail terminally (we have already transitioned, so we cannot simply throw).
  const boundSessionRef = resumed.browserSessionRef;
  if (boundSessionRef !== undefined && boundSessionRef !== input.browserSessionRef) {
    const failed = await deps.coordinator.markFailed({
      runId: input.runId,
      expectedVersion: resumed.version,
      now: input.now,
      code: 'auth-recheck-session-mismatch',
      message: 'The supplied browser session does not match the run.',
      eventData: { stepId: 'auth_state_recheck', authRecheck: 'failed', recheckCode: 'session-mismatch' },
    });
    return { outcome: 'recheck-failed', checkpoint: failed, recheckOk: false, recheckCode: 'session-mismatch' };
  }
  const sessionRef = boundSessionRef ?? input.browserSessionRef;

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
    if (
      snapshot.ok === false &&
      snapshot.code === 'target-stale' &&
      deps.pageTargets &&
      deps.recreationPolicy &&
      typeof input.targetUrl === 'string' &&
      input.targetUrl.length > 0 &&
      input.daemonRef !== undefined &&
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
      const failed = await deps.coordinator.markFailed({
        runId: input.runId,
        expectedVersion: resumed.version,
        now: input.now,
        code: `auth-recheck-${code}`,
        message: browserAuthRecheckMessage(code),
        eventData: { stepId: 'auth_state_recheck', authRecheck: 'failed', recheckCode: code },
      });
      return { outcome: 'recheck-failed', checkpoint: failed, recheckOk: false, recheckCode: code };
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

    const captureTargetRef = safePageTargetRef(snapshot.pageTargetRef, activeTargetRef);
    // Open a FRESH capture window at the post-recheck boundary: `session.start` resets the
    // source's window (beginCapture), so discovery evidence begins strictly AFTER confirmation
    // -- human-login / recheck traffic is never folded into it -- and a recreated target (a new
    // ref the caller never started) is covered.
    await deps.session.start({ runId: input.runId, pageTargetRef: captureTargetRef, now: input.now });
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
        captureId: input.captureId,
      },
    );

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
  } catch (error) {
    // A post-transition failure (recheck/probe/controller throw, or a coordinator error other
    // than the initial resume) must not leave the run stranded in running_after_resume. Convert
    // it to a terminal markFailed. If markFailed itself fails, rethrow (nothing safe to do).
    const failed = await deps.coordinator.markFailed({
      runId: input.runId,
      expectedVersion: resumed.version,
      now: input.now,
      code: 'auth-recheck-error',
      message: 'The authenticated-state recheck could not be completed.',
      eventData: { stepId: 'auth_state_recheck', authRecheck: 'failed', recheckCode: 'recheck-error' },
    });
    return { outcome: 'recheck-failed', checkpoint: failed, recheckOk: false, recheckCode: 'recheck-error' };
  }
}
