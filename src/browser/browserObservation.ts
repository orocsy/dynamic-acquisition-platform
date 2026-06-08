import type { BrowserObservationId, PageTargetRef } from './types';

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
    parsed.search = '';
    parsed.hash = '';
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    // A scheme-relative `//host/...` carries a host:port (can be a raw
    // `//127.0.0.1:9222/devtools/...` endpoint) and isn't explicit http(s) — drop it.
    // A relative path (no host) is kept with its query stripped.
    if (value.startsWith('//')) return REDACTED;
    return value.split(/[?#]/, 1)[0] || REDACTED;
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
    if (SENSITIVE_HEADER_PATTERN.test(value)) {
      throw new Error(`browser observation header ${path}.${name} contains unsafe value`);
    }
    if (PRESENCE_ONLY_HEADER_ALLOWLIST.has(lowerName)) {
      throw new Error(`browser observation header ${path}.${name} must be redacted`);
    }
    if (URL_BEARING_HEADER_ALLOWLIST.has(lowerName)) {
      // A URL-bearing header value must already be sanitized: no query/fragment, no
      // userinfo (absolute OR scheme-relative `//user@host`), and any EXPLICIT
      // scheme must be http(s). An opaque scheme with no `//` (`javascript:`,
      // `data:`, `mailto:`) is rejected too — construction drops it; this catches a
      // prebuilt observation that bypassed construction.
      const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(value);
      const nonHttpScheme =
        schemeMatch !== null &&
        schemeMatch[1].toLowerCase() !== 'http' &&
        schemeMatch[1].toLowerCase() !== 'https';
      // Reject: query/fragment; a scheme-relative `//host/...` (carries a host:port
      // that may be a raw endpoint, and is not explicit http(s)); absolute userinfo;
      // or any explicit non-http(s) scheme (incl. opaque `javascript:`/`data:`).
      const absoluteUserinfo = /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(value);
      if (/[?#]/.test(value) || value.startsWith('//') || absoluteUserinfo || nonHttpScheme) {
        throw new Error(`browser observation header ${path}.${name} must be redacted`);
      }
      continue;
    }
    if (!SAFE_RAW_HEADER_VALUE_ALLOWLIST.has(lowerName)) {
      throw new Error(`browser observation header ${path}.${name} must be redacted`);
    }
  }
}

export function assertSafeBrowserObservation(observation: BrowserObservation): void {
  assertJsonSafe(observation, 'observation');
  assertHeaderPreviewSafe(observation.request?.headersPreview, 'request.headersPreview');
  assertHeaderPreviewSafe(observation.response?.headersPreview, 'response.headersPreview');
}
