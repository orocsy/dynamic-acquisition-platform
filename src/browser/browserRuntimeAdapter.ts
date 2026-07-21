import type {
  RuntimeCoordinatorRequestHumanInterventionInput,
  RuntimeCoordinatorRequestHumanInterventionResult,
} from '../runtime';
import type { HumanInterventionKind } from '../runtime';
import { DEFAULT_RESUME_ENTRY_STEP_ID } from '../runtime';
import type { BrowserAuthBoundaryKind, BrowserAuthBoundarySignal } from './authBoundaryDetector';
import { isKnownAuthBoundaryReason } from './authBoundaryDetector';
import type { PageTargetController } from './pageTargetController';
import { guardSurrogateSessionId, sanitizeUrlPreview } from './persistenceGuard';

/**
 * Phase 3.5 bridge (LLD §8.5): turn a browser auth-boundary signal into a Phase 2
 * human intervention request through the RuntimeCoordinator. The browser layer never
 * writes checkpoints itself and never waits for the human: the adapter records the
 * request and RETURNS — resumption is the Phase 2 resume path (and 3.6's recheck).
 *
 * SECURITY SHAPE: the signal may come from ANY detector, so nothing from it reaches a
 * persisted field unvalidated — the session ref must be an opaque surrogate (guarded,
 * never echoed on failure), the kind must be one of the fixed union (mapped through an
 * explicit table, not cast), the reason is forwarded only when it is in
 * KNOWN_AUTH_BOUNDARY_REASONS (unknown reasons are dropped, not sanitized), the url is
 * re-run through sanitizeUrlPreview, and instructions come from a fixed per-kind
 * template. The coordinator result (with its once-only raw resume token) is returned
 * verbatim and never stored, logged, or copied by this module.
 */

/** The slice of the runtime coordinator the bridge needs (mirrors the 3.4 flow's dep). */
export interface InterventionRequestingCoordinator {
  requestHumanIntervention(
    input: RuntimeCoordinatorRequestHumanInterventionInput,
  ): Promise<RuntimeCoordinatorRequestHumanInterventionResult>;
}

export type BrowserRuntimeAdapterDeps = {
  coordinator: InterventionRequestingCoordinator;
  /** Optional 3.3 controller slice used to stop active browser work after the request
   *  is recorded (LLD §8.5 step 5). */
  pageTargets?: Pick<PageTargetController, 'markStale'>;
};

export type RequestHumanInterventionFromBrowserInput = {
  runId: string;
  expectedVersion: number;
  signal: BrowserAuthBoundarySignal;
  browserSessionRef: string;
  /**
   * OPTIONAL. The runtime fixes the resume-entry step: `RuntimeCoordinator.resumeRun`
   * asserts the pending intervention's `nextStepId` equals `DEFAULT_RESUME_ENTRY_STEP_ID`
   * (`auth_state_recheck`) and otherwise permanently fails the run at resume. So the
   * bridge ALWAYS records that constant; a caller-supplied value is accepted only when
   * it equals it (any other value is rejected up front, so an un-resumable intervention
   * is never created).
   */
  nextStepId?: string;
  now?: string;
  /** When provided together with deps.pageTargets, the target is marked stale after
   *  the intervention is recorded. */
  pageTargetRef?: string;
};

// A foreign detector's urlPreview is untrusted; cap its length before `new URL` parses
// it and before it is persisted, so a multi-megabyte pathname can't force large parsing/
// allocation or land in a checkpoint (this slice's bounded-untrusted-input guarantee).
const MAX_URL_PREVIEW_LENGTH = 2048;

// Explicit table, not a cast: if either union changes shape, this is a type error
// here rather than a silently mislabeled intervention.
const KIND_MAP: Record<BrowserAuthBoundaryKind, HumanInterventionKind> = {
  'login-required': 'login-required',
  'mfa-required': 'mfa-required',
  'consent-required': 'consent-required',
  'captcha-required': 'captcha-required',
  'decision-required': 'decision-required',
};

const KIND_ACTION: Record<BrowserAuthBoundaryKind, string> = {
  'login-required': 'Complete the login',
  'mfa-required': 'Complete the multi-factor prompt',
  'consent-required': 'Review and answer the consent prompt',
  'captcha-required': 'Solve the captcha',
  'decision-required': 'Make the requested decision',
};

const SIGNAL_SOURCES = new Set<BrowserAuthBoundarySignal['source']>([
  'network',
  'page-snapshot',
  'navigation',
  'manual-policy',
]);

/** Fixed instruction template (LLD §8.6) — specific to the kind, safe by construction. */
export function buildHumanInstructions(kind: BrowserAuthBoundaryKind): string[] {
  return [
    `${KIND_ACTION[kind]} in the dedicated browser daemon window.`,
    'Do not share credentials with the agent.',
    'Return only when the page shows the expected authenticated content.',
    'Cancel if the target looks unsafe or unexpected.',
  ];
}

export async function requestHumanInterventionFromBrowser(
  deps: BrowserRuntimeAdapterDeps,
  input: RequestHumanInterventionFromBrowserInput,
): Promise<RuntimeCoordinatorRequestHumanInterventionResult> {
  const signal = input.signal;
  const kind = KIND_MAP[signal?.kind as BrowserAuthBoundaryKind];
  if (!kind) {
    // A foreign detector's unknown kind must not be echoed (it could carry anything).
    throw new Error('browser auth boundary signal kind is not a known intervention kind');
  }
  // This is a trust boundary (any detector): reject a non-string ref with a clean error
  // rather than the incidental TypeError guardSurrogateSessionId's opacity check would
  // throw on a non-string. Neither echoes the value.
  if (typeof input.browserSessionRef !== 'string') {
    throw new Error('browserSessionRef must be a string');
  }
  // Throws BrowserPersistenceError (without echoing the value) on a transparent
  // daemon:...:session:... ref, a raw endpoint, or a credential-marker ref.
  const browserSessionRef = guardSurrogateSessionId('browserSessionRef', input.browserSessionRef);

  // The runtime fixes the resume-entry step; record the constant and reject any other
  // supplied value (see the field doc) so the intervention is always resumable.
  if (input.nextStepId !== undefined && input.nextStepId !== DEFAULT_RESUME_ENTRY_STEP_ID) {
    throw new Error(`nextStepId must be ${DEFAULT_RESUME_ENTRY_STEP_ID} (the runtime's fixed resume-entry step)`);
  }
  const nextStepId = DEFAULT_RESUME_ENTRY_STEP_ID;

  // Reason: fixed composition + the detector's code ONLY when it is a known one.
  const reason = isKnownAuthBoundaryReason(signal.reason)
    ? `Browser auth boundary (${kind}): ${signal.reason}`
    : `Browser auth boundary (${kind})`;

  // Url: bound the untrusted preview length, then re-sanitize; anything unsafe or
  // overlong is dropped, not fixed.
  const url =
    typeof signal.urlPreview === 'string' && signal.urlPreview.length <= MAX_URL_PREVIEW_LENGTH
      ? sanitizeUrlPreview(signal.urlPreview)
      : undefined;

  const source = SIGNAL_SOURCES.has(signal.source) ? signal.source : 'manual-policy';
  const confidence =
    typeof signal.confidence === 'number' && Number.isFinite(signal.confidence)
      ? Math.min(1, Math.max(0, signal.confidence))
      : 0;

  const result = await deps.coordinator.requestHumanIntervention({
    runId: input.runId,
    expectedVersion: input.expectedVersion,
    kind,
    reason,
    instructions: buildHumanInstructions(signal.kind),
    nextStepId,
    browserSessionRef,
    ...(url !== undefined ? { url } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    eventData: {
      authSignalKind: kind,
      authSignalSource: source,
      authSignalConfidence: confidence,
    },
  });

  // LLD §8.5 step 5: stop active browser work AFTER the request is recorded. A stale-
  // marking failure is deliberately swallowed: the coordinator state (and the returned
  // once-only resume token) is authoritative, and failing here would lose that token —
  // the target is re-validated/recreated on resume (Phase 3.6) regardless.
  if (deps.pageTargets && typeof input.pageTargetRef === 'string' && input.pageTargetRef.length > 0) {
    try {
      await deps.pageTargets.markStale(input.pageTargetRef, 'auth-boundary-intervention');
    } catch {
      // Intentionally ignored — see above.
    }
  }

  return result;
}
