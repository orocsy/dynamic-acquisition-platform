import type { BrowserObservation } from './browserObservation';
import type { BrowserNavigationResult } from './pageTargetController';
import { sanitizeUrlPreview } from './persistenceGuard';

/**
 * Phase 3.5 (LLD §8.3-§8.4): conservative auth-boundary detection.
 *
 * SECURITY SHAPE (same court as 3.2-3.4): every field of a produced signal is
 * safe-by-construction — `reason` comes from the fixed `KNOWN_AUTH_BOUNDARY_REASONS`
 * vocabulary (never source text), `urlPreview` is re-run through the persistence
 * guard's `sanitizeUrlPreview`, and `evidence`/diagnostics carry only enum codes and
 * numbers. Raw page text, headers, and URLs from the daemon are INPUTS only; no
 * character of them may reach an output field. Inputs are also BOUNDED before any
 * scan (page text slice, observation cap) so an untrusted huge input cannot create
 * CPU pressure (the round-8 method-length lesson).
 */

export type BrowserAuthBoundaryKind =
  | 'login-required'
  | 'mfa-required'
  | 'consent-required'
  | 'captcha-required'
  | 'decision-required';

export type BrowserAuthBoundarySignal = {
  kind: BrowserAuthBoundaryKind;
  /** 0..1; conservative rules emit >= 0.6, weak markers emit no signal at all. */
  confidence: number;
  source: 'network' | 'page-snapshot' | 'navigation' | 'manual-policy';
  /** Always one of KNOWN_AUTH_BOUNDARY_REASONS — a fixed code, never source text. */
  reason: string;
  urlPreview?: string;
  /** Value-free shape descriptors only (enum codes / numbers). */
  evidence?: Record<string, unknown>;
};

export type DetectAuthBoundaryInput = {
  navigation?: BrowserNavigationResult;
  observations?: BrowserObservation[];
  pageTextPreview?: string;
};

export type AuthBoundaryDetectionResult = {
  signal?: BrowserAuthBoundarySignal;
  diagnostics: Record<string, unknown>[];
};

export interface AuthBoundaryDetector {
  detect(input: DetectAuthBoundaryInput): AuthBoundaryDetectionResult;
}

/**
 * The full fixed vocabulary a signal `reason` may carry. The intervention bridge
 * (browserRuntimeAdapter) forwards a reason into the persisted intervention record
 * ONLY when it is in this set (the KNOWN_CAPTURE_CODES precedent from the 3.4 flow) —
 * an unknown reason from a foreign detector is dropped, not regex-sanitized.
 */
export const KNOWN_AUTH_BOUNDARY_REASONS = new Set<string>([
  'navigation-unauthorized-status',
  'network-unauthorized-status',
  'login-redirect-url',
  'mfa-page-marker',
  'captcha-page-marker',
  'consent-page-marker',
]);

// Bound every untrusted input before scanning.
const PAGE_TEXT_SCAN_LIMIT = 16_384;
const OBSERVATION_SCAN_LIMIT = 200;

const UNAUTHORIZED_STATUSES = new Set([401, 403]);

// Path markers on an already-sanitized preview URL that conservatively indicate a
// login redirect. Tested against the sanitized preview only (never the raw URL).
const LOGIN_PATH_PATTERN = /\/(?:log[-_]?in|sign[-_]?in|sso|authorize|auth|oauth2?)(?:\/|$)/i;

// Page-text markers. Deliberately narrow phrases; a lone generic word ("login",
// "verify") is treated as WEAK and produces a diagnostic, not a signal.
const MFA_TEXT_PATTERN = /(?:two[-\s]?factor|multi[-\s]?factor|verification code|one[-\s]?time (?:code|password)|authenticator app|\b2fa\b)/i;
const CAPTCHA_TEXT_PATTERN = /(?:captcha|i'?m not a robot|unusual traffic|verify you are human)/i;
const CONSENT_TEXT_PATTERN = /(?:consent required|accept (?:the )?terms to continue|review and accept)/i;
const WEAK_TEXT_PATTERN = /(?:\blog ?in\b|\bsign ?in\b|\bverify\b|\bpassword\b)/i;

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function signalFrom(
  kind: BrowserAuthBoundaryKind,
  confidence: number,
  source: BrowserAuthBoundarySignal['source'],
  reason: string,
  urlPreview: string | undefined,
  evidence: Record<string, unknown> | undefined,
): BrowserAuthBoundarySignal {
  const signal: BrowserAuthBoundarySignal = { kind, confidence: clampConfidence(confidence), source, reason };
  if (urlPreview !== undefined) signal.urlPreview = urlPreview;
  if (evidence !== undefined) signal.evidence = evidence;
  return signal;
}

/**
 * Conservative rule set, strongest first. Emits at most ONE signal; every weaker or
 * ambiguous match becomes a value-free diagnostic instead. Missing/malformed input
 * fields are skipped, never crashed on (the input is daemon/source-controlled).
 */
export class ConservativeAuthBoundaryDetector implements AuthBoundaryDetector {
  detect(input: DetectAuthBoundaryInput): AuthBoundaryDetectionResult {
    const diagnostics: Record<string, unknown>[] = [];

    // 1. Navigation ended on an unauthorized status.
    const navigation = input.navigation;
    const navPreview =
      navigation && typeof navigation.finalUrlPreview === 'string'
        ? sanitizeUrlPreview(navigation.finalUrlPreview)
        : undefined;
    if (navigation && typeof navigation.status === 'number' && UNAUTHORIZED_STATUSES.has(navigation.status)) {
      return {
        signal: signalFrom('login-required', 0.9, 'navigation', 'navigation-unauthorized-status', navPreview, {
          statusCode: navigation.status,
        }),
        diagnostics,
      };
    }

    // 2. A captured network observation carries an unauthorized response status.
    const observations = Array.isArray(input.observations) ? input.observations : [];
    if (observations.length > OBSERVATION_SCAN_LIMIT) {
      diagnostics.push({ level: 'info', code: 'auth-boundary-observations-truncated', scanned: OBSERVATION_SCAN_LIMIT });
    }
    for (const observation of observations.slice(0, OBSERVATION_SCAN_LIMIT)) {
      const status = observation?.response?.status;
      if (typeof status === 'number' && UNAUTHORIZED_STATUSES.has(status)) {
        const urlPreview =
          typeof observation.request?.url === 'string' ? sanitizeUrlPreview(observation.request.url) : undefined;
        return {
          signal: signalFrom('login-required', 0.8, 'network', 'network-unauthorized-status', urlPreview, {
            statusCode: status,
          }),
          diagnostics,
        };
      }
    }

    // 3. Navigation landed on a login-looking path (tested on the SANITIZED preview).
    if (navPreview !== undefined && LOGIN_PATH_PATTERN.test(navPreview)) {
      return {
        signal: signalFrom('login-required', 0.6, 'navigation', 'login-redirect-url', navPreview, undefined),
        diagnostics,
      };
    }

    // 4. Page-text markers (bounded slice; matched marker is reported as a CODE only).
    if (typeof input.pageTextPreview === 'string' && input.pageTextPreview.length > 0) {
      const text = input.pageTextPreview.slice(0, PAGE_TEXT_SCAN_LIMIT);
      if (input.pageTextPreview.length > PAGE_TEXT_SCAN_LIMIT) {
        diagnostics.push({ level: 'info', code: 'auth-boundary-page-text-truncated', scanned: PAGE_TEXT_SCAN_LIMIT });
      }
      if (MFA_TEXT_PATTERN.test(text)) {
        return { signal: signalFrom('mfa-required', 0.7, 'page-snapshot', 'mfa-page-marker', navPreview, undefined), diagnostics };
      }
      if (CAPTCHA_TEXT_PATTERN.test(text)) {
        return { signal: signalFrom('captcha-required', 0.7, 'page-snapshot', 'captcha-page-marker', navPreview, undefined), diagnostics };
      }
      if (CONSENT_TEXT_PATTERN.test(text)) {
        return { signal: signalFrom('consent-required', 0.6, 'page-snapshot', 'consent-page-marker', navPreview, undefined), diagnostics };
      }
      if (WEAK_TEXT_PATTERN.test(text)) {
        // A lone generic word is not enough to interrupt a run — record, don't signal.
        diagnostics.push({ level: 'info', code: 'auth-boundary-weak-marker' });
      }
    }

    return { diagnostics };
  }
}
