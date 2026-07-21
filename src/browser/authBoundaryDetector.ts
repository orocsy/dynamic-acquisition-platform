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
 *
 * The set is module-PRIVATE and reached only through `isKnownAuthBoundaryReason`.
 * Exporting the mutable Set would let a consumer `KNOWN_AUTH_BOUNDARY_REASONS.add(...)`
 * an untrusted reason before calling the bridge, defeating the fixed-vocabulary
 * boundary (Object.freeze does NOT stop Set.add) — so we expose only a read predicate.
 */
const KNOWN_AUTH_BOUNDARY_REASON_SET: ReadonlySet<string> = new Set<string>([
  'navigation-unauthorized-status',
  'network-unauthorized-status',
  'login-redirect-url',
  'login-form-markers',
  'mfa-page-marker',
  'captcha-page-marker',
  'consent-page-marker',
]);

export function isKnownAuthBoundaryReason(value: unknown): value is string {
  return typeof value === 'string' && KNOWN_AUTH_BOUNDARY_REASON_SET.has(value);
}

// Bound every untrusted input before scanning.
const PAGE_TEXT_SCAN_LIMIT = 16_384;
const OBSERVATION_SCAN_LIMIT = 200;
// Bound a URL BEFORE `new URL`/sanitize/regex: a multi-megabyte path would otherwise be
// parsed, returned in the signal, and scanned by the login-path regex — breaking this
// slice's bounded-input guarantee (the adapter's later cap is defense in depth, not the
// primary gate). An over-limit URL is dropped (undefined), never truncated into a new value.
const URL_PREVIEW_LIMIT = 2048;

function boundedSanitizeUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= URL_PREVIEW_LIMIT ? sanitizeUrlPreview(value) : undefined;
}

const UNAUTHORIZED_STATUSES = new Set([401, 403]);

// Path markers indicating a login redirect. Tested against the PATHNAME only (never the
// host): a single-label host that is itself a marker word (`https://auth/dashboard`,
// `https://login/account`) otherwise makes the full-URL regex match `//auth/`|`//login/`
// and falsely pause a run on an intranet host.
// Terminator accepts a `/`, the end of the pathname, OR a bounded web-page extension so a
// file-style login route (`/login.html`, `/signin.php`, `/auth.aspx`) is not missed. The
// extension list is deliberately page-only (not `.json`/`.js`) to avoid flagging auth APIs.
const LOGIN_PATH_PATTERN =
  /\/(?:log[-_]?in|sign[-_]?in|sso|authorize|auth|oauth2?)(?:\/|\.(?:html?|php|aspx?|jspx?|do|cgi|action)\b|$)/i;

function pathnameOf(preview: string): string {
  // navPreview is already sanitized to `https://host/path` OR a `/relative` path. For an
  // absolute URL, test the pathname only; a relative path has no host to confuse the match.
  try {
    return new URL(preview).pathname;
  } catch {
    return preview;
  }
}

// Page-text markers. Deliberately narrow phrases; a lone generic word ("login",
// "verify") is treated as WEAK and produces a diagnostic, not a signal. Includes the bare
// `OTP`/`MFA` acronyms (bounded) alongside `2FA` — common on real prompts ("Enter OTP").
const MFA_TEXT_PATTERN = /(?:two[-\s]?factor|multi[-\s]?factor|verification code|one[-\s]?time (?:code|password)|authenticator app|\b2fa\b|\botp\b|\bmfa\b)/i;
const CAPTCHA_TEXT_PATTERN = /(?:captcha|i'?m not a robot|unusual traffic|verify you are human)/i;
const CONSENT_TEXT_PATTERN = /(?:consent required|accept (?:the )?terms to continue|review and accept)/i;

// A login FORM (not a lone word): DISTINCT, NON-OVERLAPPING corroborating markers, one per
// form element. A single one is WEAK (diagnostic only); TWO OR MORE distinct ones on a page
// are a conservative login signal — this catches a login page that returns 200 on a non-login
// URL, which the redirect/status rules miss (breakdown §3.5 "login-form signal"). The markers
// must not overlap: an earlier version let `forgot your password` also match the standalone
// `password` marker, so a help article's lone "Forgot your password?" scored 2 and falsely
// signalled. The persistence marker therefore excludes password phrasing.
const LOGIN_FORM_MARKERS: readonly RegExp[] = [
  /\b(?:sign[-\s]?in|log[-\s]?in)\b/i, // the sign-in verb / link
  /\bpassword\b/i, // a password field (covers "forgot your password" as ONE marker)
  /\b(?:e-?mail|username)\b/i, // an identifier field
  /\b(?:remember me|keep me signed in)\b/i, // the persistence checkbox (no password phrasing)
];

// Ambiguous single markers that are NOT login-form elements but still warrant an
// observability diagnostic (never a signal): the Phase 3.5 contract requires weak/ambiguous
// evidence to surface. Restores the `verify`-family coverage the login-form rewrite dropped.
const AMBIGUOUS_TEXT_PATTERN = /\bverif(?:y|ication)\b|\bauthenticate\b|\baccess denied\b/i;

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
    const navigation = input.navigation;
    const navPreview = navigation ? boundedSanitizeUrl(navigation.finalUrlPreview) : undefined;

    // Bounded page-text slice, computed once and shared by every text rule below.
    let text: string | undefined;
    if (typeof input.pageTextPreview === 'string' && input.pageTextPreview.length > 0) {
      text = input.pageTextPreview.slice(0, PAGE_TEXT_SCAN_LIMIT);
      if (input.pageTextPreview.length > PAGE_TEXT_SCAN_LIMIT) {
        diagnostics.push({ level: 'info', code: 'auth-boundary-page-text-truncated', scanned: PAGE_TEXT_SCAN_LIMIT });
      }
    }

    // 1. EXPLICIT page-challenge text wins over a generic 401/403 or a login-looking path: an
    //    anti-bot CAPTCHA / MFA / consent screen commonly rides on those (a consent prompt on
    //    `/oauth2/authorize`, a captcha behind a 403), and classifying it as `login-required`
    //    would tell the human to log in instead of answering the visible prompt. CAPTCHA is
    //    checked before MFA because "enter the captcha verification code" matches the generic
    //    `verification code` MFA phrase too, and the specific kind must win.
    if (text !== undefined) {
      if (CAPTCHA_TEXT_PATTERN.test(text)) {
        return { signal: signalFrom('captcha-required', 0.75, 'page-snapshot', 'captcha-page-marker', navPreview, undefined), diagnostics };
      }
      if (MFA_TEXT_PATTERN.test(text)) {
        return { signal: signalFrom('mfa-required', 0.75, 'page-snapshot', 'mfa-page-marker', navPreview, undefined), diagnostics };
      }
      if (CONSENT_TEXT_PATTERN.test(text)) {
        return { signal: signalFrom('consent-required', 0.7, 'page-snapshot', 'consent-page-marker', navPreview, undefined), diagnostics };
      }
    }

    // 2. Navigation ended on an unauthorized status.
    if (navigation && typeof navigation.status === 'number' && UNAUTHORIZED_STATUSES.has(navigation.status)) {
      return {
        signal: signalFrom('login-required', 0.9, 'navigation', 'navigation-unauthorized-status', navPreview, {
          statusCode: navigation.status,
        }),
        diagnostics,
      };
    }

    // 3. A captured network observation carries an unauthorized response status.
    const observations = Array.isArray(input.observations) ? input.observations : [];
    if (observations.length > OBSERVATION_SCAN_LIMIT) {
      diagnostics.push({ level: 'info', code: 'auth-boundary-observations-truncated', scanned: OBSERVATION_SCAN_LIMIT });
    }
    for (const observation of observations.slice(0, OBSERVATION_SCAN_LIMIT)) {
      const status = observation?.response?.status;
      if (typeof status === 'number' && UNAUTHORIZED_STATUSES.has(status)) {
        const urlPreview = boundedSanitizeUrl(observation.request?.url);
        return {
          signal: signalFrom('login-required', 0.8, 'network', 'network-unauthorized-status', urlPreview, {
            statusCode: status,
          }),
          diagnostics,
        };
      }
    }

    // 4. Navigation landed on a login-looking PATH (pathname only — see LOGIN_PATH_PATTERN).
    if (navPreview !== undefined && LOGIN_PATH_PATTERN.test(pathnameOf(navPreview))) {
      return {
        signal: signalFrom('login-required', 0.6, 'navigation', 'login-redirect-url', navPreview, undefined),
        diagnostics,
      };
    }

    // 5. Remaining page-text rules: a corroborated login FORM, then weak markers. (CAPTCHA/
    //    MFA/consent were already evaluated in block 1, ahead of the generic status rules.)
    if (text !== undefined) {
      // Login FORM: count DISTINCT markers. >= 2 is a conservative login signal; exactly
      // 1 is a lone generic word -> record, don't interrupt the run.
      const loginMarkerCount = LOGIN_FORM_MARKERS.reduce((n, pattern) => (pattern.test(text as string) ? n + 1 : n), 0);
      if (loginMarkerCount >= 2) {
        return { signal: signalFrom('login-required', 0.6, 'page-snapshot', 'login-form-markers', navPreview, { markerCount: loginMarkerCount }), diagnostics };
      }
      // A single login-form marker OR an ambiguous verify-family marker: no signal, but the
      // uncertain auth boundary must still be observable (Phase 3.5 weak/ambiguous contract).
      if (loginMarkerCount === 1 || AMBIGUOUS_TEXT_PATTERN.test(text)) {
        diagnostics.push({ level: 'info', code: 'auth-boundary-weak-marker' });
      }
    }

    return { diagnostics };
  }
}
