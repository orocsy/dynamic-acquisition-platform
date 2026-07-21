import type { BrowserObservation } from './browserObservation';
import type { BrowserNavigationResult, PageTargetController } from './pageTargetController';
import type { PageTargetRef } from './types';
import type { AuthBoundaryDetector } from './authBoundaryDetector';
import { ConservativeAuthBoundaryDetector } from './authBoundaryDetector';
import { guardSurrogateSessionId, guardPageTargetRef } from './persistenceGuard';

/**
 * Phase 3.6 (LLD §9.3): re-check the authenticated state of a browser session AFTER a human
 * intervention completed, before the run is allowed back into normal running. Replaces Phase
 * 2's deterministic recheck simulation with a browser-backed check, keeping the SAME runtime
 * transition semantics (resumeRun -> [recheck] -> confirmResumeAuthRecheck | markFailed).
 *
 * SECURITY SHAPE (same court as 3.2-3.5): a result is safe-by-construction. `message` on a
 * failure is a FIXED string per code (never source text / a raw URL / a ref); diagnostics
 * carry only enum codes and numbers; `pageTargetRef` on success is re-guarded to the
 * `page:<id>` shape. The rechecker never persists anything itself — the resume FLOW owns every
 * coordinator write.
 */

export type BrowserAuthRecheckInput = {
  runId: string;
  browserSessionRef: string;
  pageTargetRef?: PageTargetRef | string;
  targetUrl?: string;
  now?: string;
};

export type BrowserAuthRecheckFailureCode =
  | 'session-stale'
  | 'target-stale'
  | 'still-unauthorized'
  | 'recheck-timeout'
  | 'unsafe-target';

export type BrowserAuthRecheckResult =
  | {
      ok: true;
      confidence: number;
      pageTargetRef?: PageTargetRef | string;
      diagnostics: Record<string, unknown>[];
    }
  | {
      ok: false;
      code: BrowserAuthRecheckFailureCode;
      message: string;
      diagnostics: Record<string, unknown>[];
    };

export interface BrowserAuthRechecker {
  recheck(input: BrowserAuthRecheckInput): Promise<BrowserAuthRecheckResult>;
}

// FIXED per-code failure messages: a failure result must never carry source text, a raw URL,
// or a ref. The resume flow forwards only `code` + these into runtime diagnostics.
const FAILURE_MESSAGES: Record<BrowserAuthRecheckFailureCode, string> = {
  'session-stale': 'The browser session is no longer valid; a fresh sign-in is required.',
  'target-stale': 'The page target is stale; it must be recreated before the recheck can proceed.',
  'still-unauthorized': 'The page still shows an authentication boundary after the intervention.',
  'recheck-timeout': 'The authenticated-state recheck did not complete in time.',
  'unsafe-target': 'The recheck target is not safe to revisit.',
};

export function authRecheckFailure(
  code: BrowserAuthRecheckFailureCode,
  diagnostics: Record<string, unknown>[] = [],
): Extract<BrowserAuthRecheckResult, { ok: false }> {
  return { ok: false, code, message: FAILURE_MESSAGES[code], diagnostics };
}

// OWN-property check (the round-8/D1/F1 prototype-key lesson): a foreign rechecker's `code`
// is untrusted, so the resume flow re-derives the safe message from a VALIDATED code rather
// than trusting `result.message` (which a foreign rechecker could fill with secret text).
export function isBrowserAuthRecheckFailureCode(value: unknown): value is BrowserAuthRecheckFailureCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FAILURE_MESSAGES, value);
}

export function browserAuthRecheckMessage(code: BrowserAuthRecheckFailureCode): string {
  return FAILURE_MESSAGES[code];
}

function guardRecheckInput(input: BrowserAuthRecheckInput): void {
  // Reject a transparent/unsafe session ref WITHOUT echoing it (BrowserPersistenceError);
  // a stale/rogue pageTargetRef must be the page:<id> shape or absent.
  guardSurrogateSessionId('browserSessionRef', input.browserSessionRef);
  guardPageTargetRef('pageTargetRef', input.pageTargetRef === undefined ? undefined : String(input.pageTargetRef));
}

/**
 * Deterministic fake for tests and for callers without a real CDP transport (mirrors the
 * FakeDaemonClient / FakePageTargetController pattern). The outcome is injected — a fixed
 * result or a per-call planner — and NO browser is touched. It still runs the same input
 * guard as the real rechecker, so an unsafe ref/target is rejected identically.
 */
export type FakeAuthRecheckPlanner = (input: BrowserAuthRecheckInput) => BrowserAuthRecheckResult;

export class FakeBrowserAuthRechecker implements BrowserAuthRechecker {
  readonly #plan: FakeAuthRecheckPlanner;

  constructor(outcome: BrowserAuthRecheckResult | FakeAuthRecheckPlanner = { ok: true, confidence: 1, diagnostics: [] }) {
    this.#plan = typeof outcome === 'function' ? outcome : () => outcome;
  }

  async recheck(input: BrowserAuthRecheckInput): Promise<BrowserAuthRecheckResult> {
    guardRecheckInput(input);
    return this.#plan(input);
  }
}

/**
 * The upstream port that supplies what a real recheck observes for a target (a navigation
 * result + captured observations + a page-text preview). The real CDP transport is DEFERRED
 * (exactly as in 3.2-3.4); a fake supplies fixtures in tests.
 */
export interface AuthStateProbe {
  probe(input: { runId: string; browserSessionRef: string; pageTargetRef?: string; targetUrl?: string }): Promise<{
    navigation?: BrowserNavigationResult;
    observations?: BrowserObservation[];
    pageTextPreview?: string;
  }>;
}

export class NotImplementedAuthStateProbe implements AuthStateProbe {
  async probe(): Promise<never> {
    throw new Error('auth state probe not implemented for this daemon transport');
  }
}

/**
 * Real-shaped rechecker that REUSES the Phase 3.5 detector as the auth-signal oracle: it
 * probes the target, then runs the detector over the probe output. Any auth-boundary signal
 * (login/mfa/consent/captcha) means the page is STILL gated -> `still-unauthorized`; no signal
 * -> `ok`. The probe's browser wire is the deferred piece; the classification logic is real
 * and tested. Composition, not a second copy of the signal rules.
 */
export class DetectorBackedAuthRechecker implements BrowserAuthRechecker {
  readonly #probe: AuthStateProbe;
  readonly #detector: AuthBoundaryDetector;

  constructor(probe: AuthStateProbe = new NotImplementedAuthStateProbe(), detector: AuthBoundaryDetector = new ConservativeAuthBoundaryDetector()) {
    this.#probe = probe;
    this.#detector = detector;
  }

  async recheck(input: BrowserAuthRecheckInput): Promise<BrowserAuthRecheckResult> {
    guardRecheckInput(input);
    let observed;
    try {
      observed = await this.#probe.probe({
        runId: input.runId,
        browserSessionRef: input.browserSessionRef,
        pageTargetRef: input.pageTargetRef === undefined ? undefined : String(input.pageTargetRef),
        targetUrl: input.targetUrl,
      });
    } catch {
      // A probe transport failure is not an auth verdict; surface it as a session-stale
      // recheck failure (value-free) so the flow fails safely rather than assuming success.
      return authRecheckFailure('session-stale', [{ level: 'warning', code: 'auth-recheck-probe-failed' }]);
    }

    const detection = this.#detector.detect({
      navigation: observed?.navigation,
      observations: observed?.observations,
      pageTextPreview: observed?.pageTextPreview,
    });
    if (detection.signal) {
      // The page still presents an auth boundary. Report a value-free diagnostic (the signal
      // KIND only, never its urlPreview/reason detail).
      return authRecheckFailure('still-unauthorized', [
        { level: 'info', code: 'auth-recheck-boundary-persists', boundaryKind: detection.signal.kind },
      ]);
    }
    return { ok: true, confidence: 0.9, ...(input.pageTargetRef !== undefined ? { pageTargetRef: input.pageTargetRef } : {}), diagnostics: [] };
  }
}
