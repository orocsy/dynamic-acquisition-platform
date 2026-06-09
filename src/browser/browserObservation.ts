import type { BrowserObservationId, PageTargetRef } from './types';
import { isPageTargetRef } from './browserRef';
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
const CLEAN_RELATIVE_PATH = /^\/(?!\/)[\x21-\x22\x24-\x25\x27-\x3a\x3c-\x3e\x40-\x5b\x5d-\x7e]*$/;
function isSanitizedUrlField(value: string): boolean {
  // Reject any percent-encoded query/fragment/param delimiter (`%3B`/`%26`/`%3F`/`%23`) a
  // consumer would decode into a secret.
  if (/%(?:3[bf]|26|23)/i.test(value)) return false;
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
    // a relative path with a percent-encoded query/fragment/param delimiter would survive
    // (CLEAN_RELATIVE_PATH permits `%`) and a consumer would decode it -> redact it.
    if (/%(?:3[bf]|26|23)/i.test(value)) return REDACTED;
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

const CLEAN_QUERY_PARAM_NAME = /^[^\s%=&?#/\\\p{Cc}]+$/u;

function assertQueryParamNamesSafe(names: string[] | undefined): void {
  if (names === undefined) return;
  // Each must be a clean, value-LESS name token: non-empty, bounded, and free of the value
  // separator `=`, the param/url delimiters `&`/`?`/`#`, a slash/backslash, a percent (an
  // encoded delimiter), whitespace, and control chars -- so a name can never smuggle a value
  // or a URL delimiter into a persisted observation.
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 256 || !CLEAN_QUERY_PARAM_NAME.test(name)) {
      throw new Error('browser observation request.queryParamNames must be clean value-less name tokens');
    }
  }
}

export function assertSafeBrowserObservation(observation: BrowserObservation): void {
  assertJsonSafe(observation, 'observation');
  // request.url and pageTargetRef are persisted alongside the header previews, so the
  // invariant must validate them too: a prebuilt observation must not carry a raw
  // query/userinfo/endpoint in request.url, nor a non-page-shaped pageTargetRef.
  if (observation.request?.url !== undefined && !isSanitizedUrlField(observation.request.url)) {
    throw new Error('browser observation request.url must be a sanitized http(s) URL or relative path');
  }
  assertQueryParamNamesSafe(observation.request?.queryParamNames);
  if (observation.pageTargetRef !== undefined && !isPageTargetRef(observation.pageTargetRef)) {
    throw new Error('browser observation pageTargetRef must be an opaque page target ref (page:<id>)');
  }
  assertHeaderPreviewSafe(observation.request?.headersPreview, 'request.headersPreview');
  assertHeaderPreviewSafe(observation.response?.headersPreview, 'response.headersPreview');
}
