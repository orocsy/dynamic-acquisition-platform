import { sanitizeUrlPreview } from './persistenceGuard';
import { isLoopbackHost } from './daemonClient';

/**
 * Phase 3.3 — navigation policy. Centralizes the knobs the LLD (§6.5) wants in
 * one place: default timeout, allowed wait modes, retry defaults, safe-restart
 * conditions, and URL preview sanitization. Controllers consult this module
 * instead of hardcoding limits, so policy can change without touching the state
 * machine.
 */

export type NavigationWaitMode = 'domcontentloaded' | 'load' | 'network-idle-ish';

export const ALLOWED_NAVIGATION_WAIT_MODES = ['domcontentloaded', 'load', 'network-idle-ish'] as const;
export const DEFAULT_NAVIGATION_WAIT_MODE: NavigationWaitMode = 'load';

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
export const MAX_NAVIGATION_TIMEOUT_MS = 120_000;

/** Default retries is 0: a navigation timeout is a diagnostic, not an auto-retry. */
export const DEFAULT_NAVIGATION_RETRIES = 0;

export function resolveNavigationWaitMode(mode?: string): NavigationWaitMode {
  if (mode === undefined) return DEFAULT_NAVIGATION_WAIT_MODE;
  if ((ALLOWED_NAVIGATION_WAIT_MODES as readonly string[]).includes(mode)) {
    return mode as NavigationWaitMode;
  }
  throw new Error(`unsupported navigation wait mode: ${mode}`);
}

export function resolveNavigationTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs === undefined) return DEFAULT_NAVIGATION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('navigation timeoutMs must be a positive finite number');
  }
  return Math.min(timeoutMs, MAX_NAVIGATION_TIMEOUT_MS);
}

/**
 * Canonical navigation URL preview sanitizer. Delegates to the persistence
 * guard's `sanitizeUrlPreview` so there is exactly one sanitizer, not a
 * divergent copy: query, fragment, and userinfo are stripped before any URL is
 * surfaced in a snapshot, navigation result, or diagnostic.
 */
export function sanitizeNavigationUrlPreview(url: string | undefined): string | undefined {
  return sanitizeUrlPreview(url);
}

/**
 * Conditions under which a stale target may be safely recreated and re-driven to
 * its original intent URL. Consumed by Phase 3.6 resume recreation; the policy
 * lives here so "is it safe to restart?" has a single answer. Defaults are
 * conservative — recreation is safe only for an explicit, side-effect-free
 * revisit that policy permits.
 */
export type SafeRecreationInput = {
  hasOriginalIntentUrl: boolean;
  sideEffectInProgress: boolean;
  policyAllowsRestart: boolean;
};

/**
 * Is this URL safe to point a REAL (possibly authenticated) browser at?
 *
 * Distinct from `sanitizeUrlPreview`, which decides what may be PERSISTED. This decides what
 * may be VISITED, and it is an allowlist: only absolute `http(s)` URLs, never `javascript:`,
 * `file:`, `data:`, `chrome:`, `devtools:`, `ws(s):` (script execution / local file read /
 * CDP control), never embedded credentials, and never a loopback host (the daemon's own CDP
 * endpoint / an SSRF target, never a public acquisition target).
 *
 * Needed because a run's `intentSnapshot` is stored as `unknown` and the Intent contract does
 * not constrain schemes: matching the recorded intent proves the URL is the AUTHORIZED one,
 * not that it is a SAFE one. Both properties have to be checked before any navigation.
 *
 * REDIRECT REQUIREMENT (binding on every real transport implementation): checking the entry
 * URL is necessary but NOT sufficient. An allowed public URL can redirect to
 * `http://127.0.0.1:9222`, `http://0.0.0.0:9222`, or another local service, and following
 * that redirect is the same unsafe request the entry check exists to prevent. A transport
 * implementing `CdpTargetTransport` or `AuthStateProbe` MUST re-apply this predicate to each
 * redirect destination BEFORE following it, and abort the navigation when it fails. The flow
 * cannot enforce this after the fact: `BasePageTargetController` sanitizes only the FINAL
 * url, and `sanitizeUrlPreview` deliberately drops loopback previews, so a followed redirect
 * is indistinguishable downstream from "no preview available". See
 * `docs/phase3.6-resume-auth-recheck.md` §8.
 */
export function isSafeNavigationTarget(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // relative / non-absolute is not a navigable acquisition target
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (isLoopbackHost(parsed.hostname) || isUnspecifiedHost(parsed.hostname)) return false;
  return true;
}

/**
 * The IPv4/IPv6 *unspecified* addresses (`0.0.0.0`, `::`). These are NOT loopback, so
 * `isLoopbackHost` lets them through, but as a DESTINATION they reach the local machine on
 * Linux — including services bound to `127.0.0.1` — so an authenticated probe pointed at
 * `http://0.0.0.0:9222` would still reach the daemon's own CDP endpoint or another local
 * service. `new URL` canonicalizes the alternate spellings (`0`, `0x0` -> `0.0.0.0`;
 * `[0:0:0:0:0:0:0:0]` -> `[::]`), so matching the canonical forms is sufficient; the
 * IPv4-mapped `::ffff:0:0` is covered explicitly.
 *
 * Deliberately NOT folded into `isLoopbackHost`: that predicate also gates
 * `safeDaemonOrigin({ requireLoopback: true })`, where treating `0.0.0.0` as loopback would
 * LOOSEN the daemon binding rather than tighten it.
 */
/**
 * Is a navigation RESULT usable evidence that the page actually loaded?
 *
 * Transport-level `ok` is not enough: a navigation can succeed at the wire level and still
 * land on a 500 error page or a target the controller already considers dead. An omitted
 * status stays acceptable (the field is optional), but a DEFINED status must be a finite
 * PRIMITIVE number in the 2xx/3xx range — `'401'`, `new Number(200)`, and `NaN` are all
 * defined-but-not-numeric and fail closed rather than reading as "no status supplied".
 *
 * Shared by the auth rechecker's usability rule and the post-recheck discovery navigation so
 * the two cannot drift apart.
 */
export function isUsableNavigationStatus(status: unknown): boolean {
  if (status === undefined) return true;
  return typeof status === 'number' && Number.isFinite(status) && status >= 200 && status < 400;
}

export function isUnspecifiedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '').replace(/^\[|\]$/g, '');
  return host === '0.0.0.0' || host === '::' || host === '::ffff:0:0' || host === '::ffff:0.0.0.0';
}

export function isSafeToRecreateTarget(input: SafeRecreationInput): boolean {
  return input.hasOriginalIntentUrl && !input.sideEffectInProgress && input.policyAllowsRestart;
}
