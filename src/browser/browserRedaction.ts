import { isOpaqueBrowserRef } from './browserRef';

const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|pwd|secret|authorization|cookie|set-cookie|api[-_]?key|token|mfa|otp|captcha|credential|session|profile|user-data-dir)/i;
const BROWSER_REF_KEY_PATTERN = /(?:browserSessionRef|pageTargetRef|browserDaemonRef|browserObservationId|daemonId|targetRef|ref)$/i;
const PROFILE_LIKE_VALUE_PATTERN =
  /(?:^~\/|^[a-z]:[\\/]|^\/(?:Users|Applications|Volumes|private|tmp|var|Library)\b|[\\/](?:Library|Application Support|Google|Chrome|Chromium)[\\/]|user-data-dir|\bprofile\b|chrome:\/\/|devtools|ws:\/\/|wss:\/\/)/i;

function sanitizeBrowserUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    // Strip userinfo too: `https://user:pass@host/...` must not retain `user:pass`.
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] || value;
  }
}

/**
 * Matches an absolute URL *anywhere* inside a string, not only one that is the
 * whole string. A diagnostic like `"redirected to https://idp…?token=SECRET then
 * back"` carries its secret mid-sentence, so sanitizing only whole-string URLs
 * (the old `looksLikeUrl` gate) left that query in place. Each match is run
 * through `sanitizeBrowserUrl`, which strips query, fragment, and userinfo.
 */
const ABSOLUTE_URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>]+/gi;

/**
 * A credential *assignment* (`token=…`, `password: …`, `api_key=…`, …) or an auth
 * *scheme* value (`Bearer …`, `Basic …`) sitting in free-form text. Unlike a URL,
 * the end of such a value can't be reliably delimited — a cookie value is
 * `;`-separated and `Authorization: Scheme token` is multiple whitespace tokens —
 * so surgically excising "just the secret" is the exact partial fix that keeps
 * leaking a variant. When this matches, the whole diagnostic string is redacted.
 * A bare *mention* of a marker word with no adjacent value (`"token refresh
 * scheduled"`, `"authorization endpoint"`) does NOT match and is kept.
 */
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:authorization|password|passwd|pwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|token|api[-_]?key|apikey|x-api-key|otp|mfa|signature|sig|cookie|set-cookie)\b\s*[:=]\s*\S|\b(?:bearer|basic)\s+\S/i;

/**
 * Strip secrets from a free-form diagnostic string. URLs are handled precisely
 * (they CAN be delimited): absolute URLs are sanitized in place wherever they
 * appear, and a whole-string relative/schemeless ref carrying a query/fragment is
 * trimmed at the first delimiter. After that, if a credential assignment or auth
 * scheme still survives in the prose, the string is redacted wholesale — see
 * `CREDENTIAL_ASSIGNMENT_PATTERN` for why surgical excision is unsafe there.
 */
function sanitizeStringForDiagnostics(value: string): string {
  let out = value.replace(ABSOLUTE_URL_PATTERN, (match) => sanitizeBrowserUrl(match));
  if (out === value && !/\s/.test(out) && /[?#]/.test(out)) {
    out = out.split(/[?#]/, 1)[0] || out;
  }
  if (CREDENTIAL_ASSIGNMENT_PATTERN.test(out)) {
    return REDACTED;
  }
  return out;
}

function shouldRedactKey(key: string): boolean {
  if (BROWSER_REF_KEY_PATTERN.test(key)) return false;
  return SENSITIVE_KEY_PATTERN.test(key);
}

function redactValue(key: string, value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (BROWSER_REF_KEY_PATTERN.test(key)) {
      return isOpaqueBrowserRef(value) ? value : REDACTED;
    }
    if (PROFILE_LIKE_VALUE_PATTERN.test(value)) return REDACTED;
    return sanitizeStringForDiagnostics(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(key, item));
  }
  if (typeof value === 'object') {
    return redactBrowserDiagnosticData(value as Record<string, unknown>);
  }
  return REDACTED;
}

export function redactBrowserDiagnosticData<T extends Record<string, unknown>>(data: T): T {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    redacted[key] = shouldRedactKey(key) ? REDACTED : redactValue(key, value);
  }
  return redacted as T;
}

export function containsUnsafeBrowserData(data: Record<string, unknown>, unsafeValues: readonly string[]): boolean {
  const serialized = JSON.stringify(data);
  return unsafeValues.some((value) => value.length > 0 && serialized.includes(value));
}
