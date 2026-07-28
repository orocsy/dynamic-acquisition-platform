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

// Returns the CANONICAL refs produced during validation. Callers MUST use these snapshots
// instead of re-reading the input fields: a caller can pass an object whose stateful
// toString() yields the validated ref once and a different -- never-validated -- ref on a
// second conversion, silently swapping which session/page the recheck verdict binds to.
function guardRecheckInput(input: BrowserAuthRecheckInput): {
  browserSessionRef: string;
  pageTargetRef: string | undefined;
} {
  // Reject a transparent/unsafe session ref WITHOUT echoing it (BrowserPersistenceError);
  // a stale/rogue pageTargetRef must be the page:<id> shape or absent.
  const browserSessionRef = guardSurrogateSessionId('browserSessionRef', input.browserSessionRef);
  const pageTargetRef = input.pageTargetRef === undefined ? undefined : String(input.pageTargetRef);
  guardPageTargetRef('pageTargetRef', pageTargetRef);
  return { browserSessionRef, pageTargetRef };
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
 *
 * `signal` is the CANCELLATION hook: when the rechecker's deadline expires it aborts the
 * signal, and a real transport MUST tear down its in-flight navigation/listeners/socket rather
 * than leaking them for the rest of the process (a timed-out recheck otherwise fails the run
 * while its CDP work stays live). A fixture probe may ignore it.
 */
export type AuthStateProbeInput = {
  runId: string;
  browserSessionRef: string;
  pageTargetRef?: string;
  targetUrl?: string;
  signal?: AbortSignal;
};

export interface AuthStateProbe {
  probe(input: AuthStateProbeInput): Promise<{
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

export const DEFAULT_AUTH_RECHECK_TIMEOUT_MS = 30_000;

/** Node's setTimeout silently clamps any delay above this (2^31-1 ms) to 1ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// The fixed set of boundary kinds the detector may legitimately report. Used to allow-list the
// value before it reaches a public recheck diagnostic (the AuthBoundaryDetector is injectable,
// so a foreign one is untrusted — a secret-bearing `kind` must never be echoed).
const KNOWN_AUTH_BOUNDARY_KINDS: ReadonlySet<string> = new Set<string>([
  'login-required',
  'mfa-required',
  'consent-required',
  'captcha-required',
  'decision-required',
]);

const PROBE_TIMEOUT = Symbol('auth-recheck-probe-timeout');

// Map a thrown probe error to a recheck failure code. A page-target `target-stale` error must
// stay `target-stale` so the resume flow's safe-recreation path can run; everything else is a
// generic `session-stale`. The error's own message is NEVER surfaced (only the mapped code).
function probeErrorCode(error: unknown): BrowserAuthRecheckFailureCode {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'target-stale' ? 'target-stale' : 'session-stale';
}

/**
 * Real-shaped rechecker that REUSES the Phase 3.5 detector as the auth-signal oracle: it
 * probes the target, then runs the detector over the probe output. Success requires BOTH no
 * auth-boundary signal AND positive evidence the page is reachable/usable (a navigation that
 * succeeded with a non-error status) — absence of login markers alone is not enough (a 500 /
 * empty probe must not be reported as authenticated). The probe's browser wire is the deferred
 * piece; the classification logic is real and tested. Composition, not a second copy of rules.
 */
export class DetectorBackedAuthRechecker implements BrowserAuthRechecker {
  readonly #probe: AuthStateProbe;
  readonly #detector: AuthBoundaryDetector;
  readonly #timeoutMs: number;

  constructor(
    probe: AuthStateProbe = new NotImplementedAuthStateProbe(),
    detector: AuthBoundaryDetector = new ConservativeAuthBoundaryDetector(),
    timeoutMs: number = DEFAULT_AUTH_RECHECK_TIMEOUT_MS,
  ) {
    this.#probe = probe;
    this.#detector = detector;
    // The deadline must be a POSITIVE, FINITE value inside Node's timer range. `Infinity` or
    // anything above MAX_TIMER_DELAY_MS is silently clamped by setTimeout to ~1ms, which would
    // turn a "no timeout" configuration into an instant `recheck-timeout` on every healthy
    // recheck -- the exact opposite of the intent. Anything invalid falls back to the default.
    this.#timeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMER_DELAY_MS
        ? timeoutMs
        : DEFAULT_AUTH_RECHECK_TIMEOUT_MS;
  }

  async recheck(input: BrowserAuthRecheckInput): Promise<BrowserAuthRecheckResult> {
    // Both refs are the guard's OWN canonical snapshots -- resolved once, during validation.
    // Re-reading the input fields here would be a second conversion, and a stateful
    // toString() could make the probe check (and pass) a substituted session or page.
    const { browserSessionRef, pageTargetRef: requestedTargetRef } = guardRecheckInput(input);

    // Enforce a deadline: a transport promise that never settles must not hang the API after
    // the checkpoint has entered running_after_resume — it becomes a structured recheck-timeout.
    // The probe is also ABORTED on timeout so a real transport tears its work down instead of
    // leaking an in-flight navigation/socket for the rest of the process.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let observed: Awaited<ReturnType<AuthStateProbe['probe']>>;
    try {
      const probing = this.#probe.probe({
        runId: input.runId,
        browserSessionRef,
        pageTargetRef: requestedTargetRef,
        targetUrl: input.targetUrl,
        signal: controller.signal,
      });
      // Never let the losing probe promise surface as an unhandled rejection after the race.
      probing.catch(() => {});
      const timeout = new Promise<typeof PROBE_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(PROBE_TIMEOUT), this.#timeoutMs);
      });
      const raced = await Promise.race([probing, timeout]);
      if (raced === PROBE_TIMEOUT) {
        controller.abort();
        return authRecheckFailure('recheck-timeout', [{ level: 'warning', code: 'auth-recheck-probe-timeout' }]);
      }
      observed = raced;
    } catch (error) {
      // A probe transport failure is not an auth verdict; map a known target-stale error so the
      // flow's recreation path stays reachable, else fail safe as session-stale (value-free).
      controller.abort();
      return authRecheckFailure(probeErrorCode(error), [{ level: 'warning', code: 'auth-recheck-probe-failed' }]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // SNAPSHOT the probe output ONCE. The probe is injectable, so `navigation` (and friends)
    // could be getters that return different values on each read: feeding the detector an
    // empty navigation (no boundary signal) and then a successful one to the usability /
    // target-binding checks would yield `ok: true` even though NO single probe result ever
    // established both "no auth boundary" AND "reachable". Every check below reads these.
    // Copy the navigation's SCALAR FIELDS, not just its object reference: snapshotting only
    // the reference still lets per-field getters be evaluated separately by the detector and
    // the usability check (a `status` getter could answer `undefined` to the "is this a 401?"
    // scan and `200` to the usability test, assembling a passing verdict from observations
    // that never formed one stable result).
    const rawNavigation = observed?.navigation;
    let navigation: BrowserNavigationResult | undefined;
    if (rawNavigation !== null && rawNavigation !== undefined) {
      // Read EACH field exactly once into a local before building the snapshot: a
      // `field === undefined ? {} : { field }` ternary would read the getter TWICE and store
      // the SECOND value, which is precisely the mutation this snapshot exists to defeat.
      const status = rawNavigation.status;
      const finalUrlPreview = rawNavigation.finalUrlPreview;
      const durationMs = rawNavigation.durationMs;
      const diagnostics = rawNavigation.diagnostics;
      navigation = {
        ok: rawNavigation.ok,
        pageTargetRef: String(rawNavigation.pageTargetRef),
        state: rawNavigation.state,
        ...(status === undefined ? {} : { status }),
        ...(finalUrlPreview === undefined ? {} : { finalUrlPreview }),
        ...(durationMs === undefined ? {} : { durationMs }),
        diagnostics: Array.isArray(diagnostics) ? [...diagnostics] : [],
      };
    }
    const rawObservations = observed?.observations;
    const observations = Array.isArray(rawObservations) ? [...rawObservations] : rawObservations;
    const pageTextPreview = observed?.pageTextPreview;

    const detection = this.#detector.detect({ navigation, observations, pageTextPreview });
    if (detection.signal) {
      // The page still presents an auth boundary. Report a value-free diagnostic: the boundary
      // KIND is copied ONLY when it is one of the fixed known kinds (the detector is injectable,
      // so a foreign one could return a secret-bearing kind); otherwise the field is omitted.
      const kind = detection.signal.kind;
      return authRecheckFailure('still-unauthorized', [
        {
          level: 'info',
          code: 'auth-recheck-boundary-persists',
          ...(KNOWN_AUTH_BOUNDARY_KINDS.has(kind) ? { boundaryKind: kind } : {}),
        },
      ]);
    }

    // Positive usability evidence: a navigation that actually loaded a non-error page. No such
    // evidence -> do NOT report success (an unrecognized-but-broken page must not pass). This
    // is the SAME `navigation` value the detector saw (snapshotted above).
    // A DEFINED status must be a FINITE PRIMITIVE number in the success range. Treating a
    // non-numeric status ('401', new Number(401), NaN) as "absent optional" let a malformed or
    // hostile probe skip both the detector's unauthorized-status rule and this check and still
    // be reported as authenticated. Absent stays acceptable; anything defined-but-not-a-number
    // fails closed.
    const status: unknown = navigation?.status;
    const statusUsable =
      status === undefined
        ? true
        : typeof status === 'number' && Number.isFinite(status) && status >= 200 && status < 400;
    const usable = navigation !== undefined && navigation.ok === true && statusUsable;
    if (!usable || navigation === undefined) {
      return authRecheckFailure('still-unauthorized', [{ level: 'info', code: 'auth-recheck-target-not-usable' }]);
    }

    // BIND the verdict to the page we were asked about: a probe that mixes results across
    // concurrent pages could return an ok navigation for a DIFFERENT target, which would
    // authenticate a page that was never actually rechecked. The observed navigation's target
    // must equal the requested one (when a target was requested).
    if (requestedTargetRef !== undefined && String(navigation.pageTargetRef) !== requestedTargetRef) {
      return authRecheckFailure('still-unauthorized', [{ level: 'info', code: 'auth-recheck-target-not-observed' }]);
    }

    return { ok: true, confidence: 0.9, ...(requestedTargetRef !== undefined ? { pageTargetRef: requestedTargetRef } : {}), diagnostics: [] };
  }
}
