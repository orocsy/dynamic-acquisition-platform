import type {
  RuntimeCoordinatorResumeRunInput,
  RuntimeCoordinatorTransitionInput,
  RuntimeCoordinatorFailureInput,
} from '../runtime';
import type { RunCheckpoint } from '../runtime';
import { isPageTargetRef } from './browserRef';
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
  /** For §9.5 recreation only (with deps.pageTargets + recreationPolicy). */
  daemonRef?: BrowserDaemonRef;
  sideEffectInProgress?: boolean;
  captureId?: string;
};

export type ResumeBrowserRunOutcome = 'completed' | 'recheck-failed' | 'evidence-not-recorded';

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

export async function resumeBrowserRun(
  deps: ResumeBrowserRunDeps,
  input: ResumeBrowserRunInput,
): Promise<ResumeBrowserRunResult> {
  // A duplicate/stale resume is rejected by the coordinator here (RuntimeCoordinatorError
  // propagates to the caller) BEFORE any recheck or evidence work.
  const resumed = await deps.coordinator.resumeRun({
    runId: input.runId,
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    now: input.now,
  });

  let activeTargetRef: PageTargetRef | string = input.pageTargetRef;
  let result = await deps.rechecker.recheck({
    runId: input.runId,
    browserSessionRef: input.browserSessionRef,
    pageTargetRef: input.pageTargetRef,
    targetUrl: input.targetUrl,
    now: input.now,
  });

  // §9.5 safe target recreation: ONLY on target-stale, ONLY when a policy explicitly allows it,
  // a recreation controller is present, an intent URL is available, and no side effect was in
  // progress. Otherwise fall through to a safe failure. Retried at most ONCE.
  if (
    !result.ok &&
    result.code === 'target-stale' &&
    deps.pageTargets &&
    deps.recreationPolicy &&
    typeof input.targetUrl === 'string' &&
    input.targetUrl.length > 0 &&
    input.daemonRef !== undefined &&
    input.sideEffectInProgress !== true &&
    deps.recreationPolicy({ runId: input.runId, targetUrl: input.targetUrl, sideEffectInProgress: false })
  ) {
    const snapshot = await deps.pageTargets.createTarget({
      daemonRef: input.daemonRef,
      runId: input.runId,
      targetUrl: input.targetUrl,
      now: input.now,
    });
    activeTargetRef = snapshot.pageTargetRef;
    result = await deps.rechecker.recheck({
      runId: input.runId,
      browserSessionRef: input.browserSessionRef,
      pageTargetRef: snapshot.pageTargetRef,
      targetUrl: input.targetUrl,
      now: input.now,
    });
  }

  if (!result.ok) {
    // Re-derive a SAFE code + message from the (validated) failure code; never forward the
    // rechecker's own `message` or `diagnostics` (a foreign rechecker could put secrets there).
    const code = isBrowserAuthRecheckFailureCode(result.code) ? result.code : 'still-unauthorized';
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
  const confidence = clampConfidence((result as Extract<BrowserAuthRecheckResult, { ok: true }>).confidence);
  const confirmed = await deps.coordinator.confirmResumeAuthRecheck({
    runId: input.runId,
    expectedVersion: resumed.version,
    now: input.now,
    phase: 'discovering_network',
    browserSessionRef: input.browserSessionRef,
    eventData: { authRecheck: 'passed', recheckConfidence: confidence },
  });

  const captureTargetRef = safePageTargetRef(
    (result as Extract<BrowserAuthRecheckResult, { ok: true }>).pageTargetRef,
    activeTargetRef,
  );
  // The resume flow owns the capture window for the (possibly recreated) target: `start` is
  // idempotent, so a caller that already opened the original window is harmless, and a target
  // recreated during recheck (a NEW ref the caller never started) is covered.
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
      browserSessionRef: input.browserSessionRef,
      priorEvidenceRefs: confirmed.evidenceRefs,
      captureId: input.captureId,
    },
  );

  // An error-level normalizer diagnostic stops the capture flow before any transition; do NOT
  // complete the run in that case (it stays at running for a later step / retry).
  if (!capture.recorded || !capture.checkpoint) {
    return { outcome: 'evidence-not-recorded', checkpoint: confirmed, recheckOk: true, capture };
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
}
