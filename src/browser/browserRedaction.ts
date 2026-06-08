import { isOpaqueBrowserRef } from './browserRef';

const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|pwd|secret|authorization|cookie|set-cookie|api[-_]?key|token|mfa|otp|captcha|credential|session|profile|user-data-dir|jwt|csrf|xsrf|signature|private[-_]?key|auth[-_]?code|bearer|client[-_]?secret|(?<![a-z0-9])pat(?![a-z0-9]))/i;
const BROWSER_REF_KEY_PATTERN = /(?:browserSessionRef|pageTargetRef|browserDaemonRef|browserObservationId|daemonId|targetRef|ref)$/i;
const PROFILE_LIKE_VALUE_PATTERN =
  /(?:^~\/|^[a-z]:[\\/]|^\/(?:Users|Applications|Volumes|private|tmp|var|Library)\b|[\\/](?:Library|Application Support|Google|Chrome|Chromium)[\\/]|user-data-dir|\bprofile\b|chrome:\/\/|devtools|ws:\/\/|wss:\/\/|file:\/\/)/i;

/**
 * An opaque / non-hierarchical URL scheme in free-form prose. These have no clean `//`
 * authority+path to sanitize in place — the payload after `:` is arbitrary (a data URI
 * body, a `javascript:` script, a `mailto:` query) and can carry a secret that no URL
 * parser delimits — so a diagnostic containing one is redacted wholesale.
 */
const OPAQUE_URL_SCHEME_PATTERN = /\b(?:data|javascript|vbscript|blob|filesystem|chrome-extension|mailto|file):[^\s]/i;

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
  /\b(?:authorization|password|passwd|pwd|secret|client[-_]?secret|private[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|jwt|api[-_]?key|apikey|x-api-key|otp|mfa|signature|sig|csrf|xsrf|auth[-_]?code|session[-_]?id|cookie|set-cookie)\b\s*[:=]\s*\S|(?<![a-z0-9])pat(?![a-z0-9])\s*[:=]\s*\S|\b(?:bearer|basic)\s+\S/i;

/**
 * Fold a string to a canonical denylist VIEW (the returned value is never this —
 * it only decides whether to redact). NFKD decomposes full-width / ligature forms
 * to ASCII and splits accented letters into base + combining mark; then invisible
 * format / default-ignorable chars AND combining marks (\p{M}) are stripped. So a
 * zero-width split (`to<ZWSP>ken`), a full-width keyword (`devtools`/`Bearer`), and a
 * combining-mark split (`to<acute>ken` / precomposed `se<accent>ret`) all collapse
 * to the bare keyword. NFKC alone missed marks (it recomposes accents); NFKD + \p{M}
 * closes the whole format/mark class by construction.
 */
function foldForDenylist(value: string): string {
  return value.normalize('NFKD').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}]/gu, '');
}

/**
 * A diagnostic value is "risky" if it embeds a URL or endpoint token: any `scheme://`,
 * a scheme-relative `//host`, or a relative path carrying a `?`/`#`/`;`/`&` delimiter (a
 * query, fragment, or matrix/path parameter -- the parts a secret rides in). A bare path
 * with no delimiter (a route like `/api/users`) and plain prose are NOT risky.
 */
const RISKY_DIAGNOSTIC_PATTERN = /:\/\/|(?:^|\s)\/\/[^\s"'<>]|(?:^|\s)\/[^\s"'<>]*[?#;&]/i;

/**
 * Aggressive defense-in-depth for a free-form diagnostic string. Sanitizing a URL or
 * endpoint IN PLACE is a long tail of edge cases -- a secret can ride in a query,
 * fragment, matrix/path parameter, userinfo, an opaque-scheme body (data:/javascript:/
 * mailto:), or a scheme-relative host -- so we do NOT try. Instead, if the value contains
 * ANY URL/endpoint token (RISKY_DIAGNOSTIC_PATTERN or an opaque scheme) OR a credential
 * assignment / auth-scheme value, the WHOLE string is redacted. Diagnostics are debug
 * context, not a data channel; losing a string to guarantee no secret ever surfaces is
 * the right trade. A bare path and plain prose are kept.
 */
function sanitizeStringForDiagnostics(value: string): string {
  if (RISKY_DIAGNOSTIC_PATTERN.test(value) || OPAQUE_URL_SCHEME_PATTERN.test(value)) {
    return REDACTED;
  }
  // A credential assignment / auth-scheme value in prose, folded to defeat full-width /
  // combining-mark smuggling -> redact wholesale; see CREDENTIAL_ASSIGNMENT_PATTERN.
  const denylistView = foldForDenylist(value);
  if (CREDENTIAL_ASSIGNMENT_PATTERN.test(denylistView)) {
    return REDACTED;
  }
  return value;
}

function shouldRedactKey(key: string): boolean {
  if (BROWSER_REF_KEY_PATTERN.test(key)) return false;
  // Fold the key name too (full-width / accented / combining-mark-split sensitive
  // keys), mirroring the value-side fold — otherwise a disguised sensitive key dodges
  // redaction and a keyword-free secret value leaks verbatim under it.
  return SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_KEY_PATTERN.test(foldForDenylist(key));
}

function redactValue(key: string, value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (BROWSER_REF_KEY_PATTERN.test(key)) {
      return isOpaqueBrowserRef(value) ? value : REDACTED;
    }
    // test a folded view too, so a full-width / accented `devtools`/`chrome://`/
    // `user-data-dir` endpoint or profile path cannot dodge the raw check (LEAK B).
    if (PROFILE_LIKE_VALUE_PATTERN.test(value) || PROFILE_LIKE_VALUE_PATTERN.test(foldForDenylist(value))) return REDACTED;
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
