import { isOpaqueBrowserRef } from './browserRef';

const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|pwd|secret|authorization|cookie|set-cookie|api[-_]?key|token|mfa|otp|captcha|credential|session|profile|user-data-dir|jwt|csrf|xsrf|signature|private[-_]?key|auth[-_]?code|bearer|client[-_]?secret|(?<![a-z0-9])pat(?![a-z0-9]))/i;
const BROWSER_REF_KEY_PATTERN = /(?:browserSessionRef|pageTargetRef|browserDaemonRef|browserObservationId|daemonId|targetRef|ref)$/i;
const PROFILE_LIKE_VALUE_PATTERN =
  /(?:^~\/|^[a-z]:[\\/]|^\/(?:Users|Applications|Volumes|private|tmp|var|Library)\b|[\\/](?:Library|Application Support|Google|Chrome|Chromium)[\\/]|user-data-dir|\bprofile\b|chrome:\/\/|devtools|ws:\/\/|wss:\/\/|file:\/\/)/i;

function sanitizeBrowserUrl(value: string): string {
  try {
    const parsed = new URL(value);
    // http(s)-only, uniform with sanitizeUrlPreview / sanitizeHeaderUrlValue: a
    // non-web scheme is a raw endpoint/path, not a page URL — drop it rather than
    // keep scheme+host+path. (ws/wss/chrome/devtools are already wholesale-redacted
    // upstream by PROFILE_LIKE_VALUE_PATTERN; this closes the ftp/other-scheme gap
    // and keeps every URL sanitizer on one policy.)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return REDACTED;
    }
    parsed.search = '';
    parsed.hash = '';
    // Strip userinfo too: `https://user:pass@host/...` must not retain `user:pass`.
    parsed.username = '';
    parsed.password = '';
    // ...and RFC-3986 path parameters (`;jsessionid=…`, stray `&…`): same path-param
    // strip as sanitizeUrlPreview / sanitizeHeaderUrlValue, so a redirect session id in
    // a diagnostic URL never surfaces (they live in pathname, not search).
    parsed.pathname = parsed.pathname.split(/[;&]/)[0];
    return parsed.toString();
  } catch {
    return value.split(/[?#;&]/, 1)[0] || value;
  }
}

/**
 * Matches an absolute URL *anywhere* inside a string, not only one that is the
 * whole string. A diagnostic like `"redirected to https://idp…?token=SECRET then
 * back"` carries its secret mid-sentence, so sanitizing only whole-string URLs
 * (the old `looksLikeUrl` gate) left that query in place. Each match is run
 * through `sanitizeBrowserUrl`, which strips query, fragment, and userinfo.
 */
const ABSOLUTE_URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>]+|\b(?:data|javascript|vbscript|blob|filesystem|chrome-extension):[^\s"'<>]+/gi;

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
  /\b(?:authorization|password|passwd|pwd|secret|client[-_]?secret|private[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|jwt|api[-_]?key|apikey|x-api-key|pat|otp|mfa|signature|sig|csrf|xsrf|auth[-_]?code|session[-_]?id|cookie|set-cookie)\b\s*[:=]\s*\S|\b(?:bearer|basic)\s+\S/i;

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
 * Strip secrets from a free-form diagnostic string. URLs are handled precisely
 * (they CAN be delimited): absolute URLs are sanitized in place wherever they
 * appear, and a whole-string relative/schemeless ref carrying a query/fragment is
 * trimmed at the first delimiter. After that, if a credential assignment or auth
 * scheme still survives in the prose, the string is redacted wholesale — see
 * `CREDENTIAL_ASSIGNMENT_PATTERN` for why surgical excision is unsafe there.
 */
function sanitizeStringForDiagnostics(value: string): string {
  let out = value.replace(ABSOLUTE_URL_PATTERN, (match) => sanitizeBrowserUrl(match));
  // Strip RFC-3986 path parameters (;jsessionid=..., stray &...) from ANY relative-path
  // token, whole-string OR embedded in prose -- a relative ref has no scheme for the
  // absolute-URL sanitizer, and jsessionid is not a credential-assignment keyword.
  out = out.replace(/(\/[^\s;&?#"'<>]*)[;&][^\s"'<>]*/g, '$1');
  if (out === value && !/\s/.test(out)) {
    // a whole-string scheme-relative `//host/...` can be a raw endpoint -> redact it.
    // (ws/devtools/chrome are already wholesale-redacted upstream by PROFILE_LIKE.)
    if (out.startsWith('//')) return REDACTED;
    out = out.split(/[?#;&]/, 1)[0] || out;
  }
  // denylist check ONLY (see foldForDenylist): NFKD + strip invisible/format AND
  // combining-mark chars, so zero-width / full-width / accent splits all collapse to
  // the bare keyword. The returned value stays the original `out`.
  const denylistView = foldForDenylist(out);
  if (CREDENTIAL_ASSIGNMENT_PATTERN.test(denylistView)) {
    return REDACTED;
  }
  return out;
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
