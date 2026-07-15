import type { BrowserObservationId, PageTargetRef } from './types';
import { isOpaqueBrowserRef, isPageTargetRef, isSafeBrowserRefPart } from './browserRef';
import { isLoopbackHost } from './daemonClient';

export type BrowserObservationSource = 'cdp' | 'playwright' | 'daemon-fixture';

export type BrowserObservationBodyShape =
  | 'json-object'
  | 'json-array'
  | 'form-like'
  | 'text-preview'
  | 'unknown';

export type BrowserResponseBodyShape =
  | 'json-list'
  | 'json-object'
  | 'json'
  | 'html-document'
  | 'downloadable-pdf'
  | 'text-preview'
  | 'unknown';

export type BrowserObservation = {
  id: BrowserObservationId | string;
  runId: string;
  source: BrowserObservationSource;
  capturedAt: string;
  pageTargetRef?: PageTargetRef | string;
  request?: {
    url: string;
    method: string;
    headersPreview?: Record<string, string>;
    resourceType?: string;
    bodyShape?: BrowserObservationBodyShape;
    // Query param NAMES only (the sanitized `url` strips the query string). Carried so the
    // network->evidence bridge preserves names without values; validated as value-less.
    queryParamNames?: string[];
  };
  response?: {
    status?: number;
    mimeType?: string;
    headersPreview?: Record<string, string>;
    bodyShape?: BrowserResponseBodyShape;
  };
  timing?: {
    startedAt?: string;
    durationMs?: number;
  };
};

const REDACTED = '[redacted]';
const SENSITIVE_HEADER_PATTERN = /(?:authorization|cookie|set-cookie|api[-_]?key|x-api-key|token|secret|session|mfa|otp|captcha)/i;

// A persistence-safe URL field: a clean http(s) absolute URL (no userinfo, query,
// fragment, whitespace, control char, or backslash) OR a clean relative path (single
// leading slash, printable ASCII, no backslash — `/\\host` would smuggle a host that
// `new URL` resolves via `\\`==`/`). Shared by the header check and the request.url
// invariant so both enforce one policy.
const CLEAN_ABSOLUTE_URL = /^https?:\/\/[^@/?#;&\s\x5c\x00-\x1f]+(?:\/[^?#;&\s\x5c\x00-\x1f]*)?$/i;
// No `:` (0x3a) in a relative path: a colon lets a whole absolute URL hide inside it
// (`/http://127.0.0.1:9222/devtools/...`), smuggling a scheme/port/loopback endpoint past
// the absolute-URL checks by prefixing `/`. Rare legit colon segments (`/v1/users:batch`)
// are dropped as the cost of closing the class.
const CLEAN_RELATIVE_PATH = /^\/(?!\/)[\x21-\x22\x24-\x25\x27-\x39\x3c-\x3e\x40-\x5b\x5d-\x7e]*$/;
export function isSanitizedUrlField(value: string): boolean {
  // Reject any percent-encoded query/fragment/param/colon delimiter (`%3B`/`%26`/`%3F`/
  // `%23`/`%3A`) a consumer would decode into a secret -- `%3A` because a decoded colon
  // re-opens the relative-path scheme smuggle (`/http%3a//127.0.0.1%3a9222/...`).
  if (/%(?:3[abf]|26|23)/i.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return CLEAN_RELATIVE_PATH.test(value);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // A loopback host is the local daemon / a CDP debugger endpoint / an SSRF target, never a
  // public page; `new URL` canonicalizes octal/decimal/IPv6 spellings (`0177.0.0.1`,
  // `2130706433`, `[::1]`) so parsing here catches every form a raw regex would miss.
  if (isLoopbackHost(parsed.hostname)) return false;
  return CLEAN_ABSOLUTE_URL.test(value);
}

/**
 * Header names whose *values* are safe to retain verbatim. These carry only
 * low-cardinality protocol metadata — no URLs, filenames, or free-form text
 * that could embed a secret.
 */
const SAFE_RAW_HEADER_VALUE_ALLOWLIST = new Set<string>([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-type',
  'content-length',
  'content-encoding',
  'date',
  'last-modified',
  'server',
  'vary',
  'x-content-type-options',
  'x-frame-options',
]);

/**
 * Header names that are useful to keep but whose values are URL- or
 * filename-bearing and can therefore embed secrets (e.g. an OAuth `code` in a
 * `Location` redirect, or a signed token in a `content-disposition` filename).
 * Their values are sanitized — query/fragment stripped from URLs, filename
 * params dropped — rather than preserved raw. This closes the redaction hole
 * where allowlisting the header *name* implicitly trusted its *value*.
 */
const URL_BEARING_HEADER_ALLOWLIST = new Set<string>(['location', 'content-location', 'referer', 'origin']);

/**
 * Header names kept for cache/etag signal but whose values are opaque tokens we
 * do not want to retain verbatim; collapsed to `[redacted]`.
 */
const PRESENCE_ONLY_HEADER_ALLOWLIST = new Set<string>(['etag', 'content-disposition']);

function sanitizeHeaderUrlValue(value: string): string {
  try {
    const parsed = new URL(value);
    // Only http/https URL-bearing header values are kept. A non-web scheme
    // (ws/wss/chrome/devtools/file/…) is a raw endpoint/path, not a page URL —
    // drop it rather than keep the scheme with only the query stripped. Same
    // http(s)-only policy as persistenceGuard's sanitizeUrlPreview.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return REDACTED;
    }
    // A loopback host is the local daemon / a CDP debugger endpoint / an SSRF target, never a
    // page -> drop it (new URL canonicalizes octal/decimal/IPv6 host spellings).
    if (isLoopbackHost(parsed.hostname)) {
      return REDACTED;
    }
    parsed.search = '';
    parsed.hash = '';
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    // Drop RFC-3986 path parameters too (`;jsessionid=…`, stray `&…`) — they sit in
    // pathname, not search, so a session id in a redirect Location would survive.
    parsed.pathname = parsed.pathname.split(/[;&]|%3b|%26|%3f|%23/i)[0];
    return parsed.toString();
  } catch {
    // Keep ONLY a clean relative path; drop scheme-relative or whitespace/tab/control/
    // zero-width-smuggled host-bearing forms (a URL parser normalizes `/<tab>/host` to
    // `//host`). A relative path has no host:port to leak. See sanitizeUrlPreview.
    // a relative path with a percent-encoded query/fragment/param/colon delimiter would
    // survive (CLEAN_RELATIVE_PATH permits `%`) and a consumer would decode it -> redact it
    // (`%3A` re-opens the relative-path scheme smuggle).
    if (/%(?:3[abf]|26|23)/i.test(value)) return REDACTED;
    const path = value.split(/[?#;&]/, 1)[0];
    return CLEAN_RELATIVE_PATH.test(path) ? path : REDACTED;
  }
}

function assertJsonSafe(value: unknown, path: string): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`browser observation contains non-finite number at ${path}`);
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`browser observation contains non-JSON value at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSafe(child, `${path}.${key}`);
    }
  }
}

/**
 * Reduce a raw header map to a persistence-safe preview. Header *names* are
 * preserved (they carry useful strategy signal), but a header *value* is only
 * retained when the name is on the safe allowlist; everything else becomes
 * `[redacted]`. This is the construction-time companion to
 * `assertHeaderPreviewSafe`, which remains as a defensive invariant check.
 */
function safeHeaderValue(lowerName: string, value: string): string {
  if (value === REDACTED) return REDACTED;
  if (SAFE_RAW_HEADER_VALUE_ALLOWLIST.has(lowerName)) return value;
  if (URL_BEARING_HEADER_ALLOWLIST.has(lowerName)) return sanitizeHeaderUrlValue(value);
  // PRESENCE_ONLY headers and everything else: keep the name, drop the value.
  return REDACTED;
}

export function toSafeHeaderPreview(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const preview: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    preview[lowerName] = safeHeaderValue(lowerName, value);
  }
  return preview;
}

function assertHeaderPreviewSafe(headers: Record<string, string> | undefined, path: string): void {
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (value === REDACTED) continue;

    if (SENSITIVE_HEADER_PATTERN.test(lowerName)) {
      throw new Error(`browser observation header ${path}.${name} must be redacted`);
    }
    if (URL_BEARING_HEADER_ALLOWLIST.has(lowerName)) {
      // A URL-bearing header value must already be sanitized to EITHER a clean http(s)
      // absolute URL OR a clean relative path: no query/fragment/path-param/userinfo,
      // http(s) scheme only. Everything else is rejected — scheme-relative `//host`, an
      // opaque/non-http scheme (`javascript:`/`data:`/`ws:`), a tab/control/zero-width-
      // smuggled host, userinfo, or a `;jsessionid=` path param — any of which can carry
      // a raw endpoint or a secret. Checked BEFORE the generic sensitive-substring test
      // below so a legitimately sanitized path that merely CONTAINS `session`/`secret`
      // as a segment (e.g. `/api/v2/sessions`) is not falsely rejected; isSanitizedUrlField
      // already guarantees no secret-carrying structure survives. (Allow-list the safe
      // shapes; deny-listing missed smuggled variants.)
      if (!isSanitizedUrlField(value)) {
        throw new Error(`browser observation header ${path}.${name} must be redacted`);
      }
      continue;
    }
    if (SENSITIVE_HEADER_PATTERN.test(value)) {
      throw new Error(`browser observation header ${path}.${name} contains unsafe value`);
    }
    if (PRESENCE_ONLY_HEADER_ALLOWLIST.has(lowerName)) {
      throw new Error(`browser observation header ${path}.${name} must be redacted`);
    }
    if (!SAFE_RAW_HEADER_VALUE_ALLOWLIST.has(lowerName)) {
      throw new Error(`browser observation header ${path}.${name} must be redacted`);
    }
  }
}

// A FIXED allow-list of HTTP methods, not a shape check: an all-letter token (`SecretToken`)
// would satisfy any alphabetic pattern, and the point of this gate is to keep
// source-controlled free-form text out of persisted observations. Exact known values only
// (the round-9 ref-key allow-list precedent); extend deliberately if a capture source ever
// legitimately emits more (e.g. WebDAV). Case-insensitive: CDP reports canonical uppercase,
// fixtures may not. Shared by the observation gate (so an unsafe method never survives
// stop()/listObservations()) and the mapper (defense for observations that bypassed the gate).
const HTTP_METHOD_ALLOWLIST = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'CONNECT']);
export function isHttpMethodToken(value: unknown): value is string {
  return typeof value === 'string' && HTTP_METHOD_ALLOWLIST.has(value.toUpperCase());
}

// The base `type/subtype` of a MIME type, with any parameters (`; charset=...`) STRIPPED: a
// parameter is free-form and could carry a secret. SANITIZE disposal (lossy preview), not
// REJECT: the base is informational, so dropping the parameters is fine. Shared by the
// session store (construction) and the mapper (defense for un-gated observations).
const MIME_TYPE_BASE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
export function cleanMimeType(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 256) return undefined;
  const base = value.split(';', 1)[0].trim();
  return MIME_TYPE_BASE_PATTERN.test(base) ? base : undefined;
}

const CLEAN_QUERY_PARAM_NAME = /^[^\s%=&?#/\\\p{Cc}]+$/u;

// A single value-less query param NAME token (exported so the bridge can re-validate
// source-controlled names from an untrusted session before forwarding them to evidence).
export function isSafeQueryParamName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 256 && CLEAN_QUERY_PARAM_NAME.test(name);
}

function assertQueryParamNamesSafe(names: unknown): void {
  if (names === undefined) return;
  // Must be an ARRAY of clean, value-LESS name tokens. A non-array (e.g. a bare string from
  // daemon JSON) would otherwise iterate per-character below, pass, and then make the mapper's
  // `names.map(...)` throw rather than producing a safe skip. Each name: non-empty, bounded,
  // and free of the value separator `=`, the param/url delimiters `&`/`?`/`#`, a slash/
  // backslash, a percent (encoded delimiter), whitespace, and control chars.
  if (!Array.isArray(names)) {
    throw new Error('browser observation request.queryParamNames must be an array of clean value-less name tokens');
  }
  for (const name of names) {
    if (!isSafeQueryParamName(name)) {
      throw new Error('browser observation request.queryParamNames must be clean value-less name tokens');
    }
  }
}

export function assertSafeBrowserObservation(observation: BrowserObservation): void {
  assertJsonSafe(observation, 'observation');
  // The id is copied into the mapped entry id -> evidence `source.ref` and runtime
  // `entryId` diagnostics, so it must be an opaque STRING token, never a raw URL/endpoint/
  // secret a buggy source might supply. Require an actual string (not String()-coerced): a
  // non-string id (e.g. `["sk_live_..."]`) would pass a coerced check yet be stored/returned
  // verbatim by pickSafeObservation. Structural-only (descriptive ids OK).
  if (typeof observation.id !== 'string' || !isSafeBrowserRefPart(observation.id) || !isOpaqueBrowserRef(observation.id)) {
    throw new Error('browser observation id must be an opaque, credential-free string token');
  }
  // request.url and pageTargetRef are persisted alongside the header previews, so the
  // invariant must validate them too: a prebuilt observation must not carry a raw
  // query/userinfo/endpoint in request.url, nor a non-page-shaped pageTargetRef.
  if (observation.request?.url !== undefined && !isSanitizedUrlField(observation.request.url)) {
    throw new Error('browser observation request.url must be a sanitized http(s) URL or relative path');
  }
  // A non-string method (malformed daemon JSON) would crash the normalizer's `.toUpperCase()`
  // downstream, and a free-form method string could carry credential text into
  // stop()/listObservations() results (pickSafeObservation copies it verbatim) -- so the gate
  // requires a real HTTP method TOKEN, not merely a non-empty string.
  if (observation.request !== undefined && !isHttpMethodToken(observation.request.method)) {
    throw new Error('browser observation request.method must be a valid HTTP method token');
  }
  assertQueryParamNamesSafe(observation.request?.queryParamNames);
  if (observation.pageTargetRef !== undefined && !isPageTargetRef(observation.pageTargetRef)) {
    throw new Error('browser observation pageTargetRef must be an opaque page target ref (page:<id>)');
  }
  assertHeaderPreviewSafe(observation.request?.headersPreview, 'request.headersPreview');
  assertHeaderPreviewSafe(observation.response?.headersPreview, 'response.headersPreview');
}
