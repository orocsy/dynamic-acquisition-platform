import { sanitizeUrlPreview } from './persistenceGuard';

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

export function isSafeToRecreateTarget(input: SafeRecreationInput): boolean {
  return input.hasOriginalIntentUrl && !input.sideEffectInProgress && input.policyAllowsRestart;
}
