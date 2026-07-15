import type { BrowserObservation, BrowserObservationSource } from './browserObservation';
import { cleanMimeType, isHttpMethodToken, isSafeQueryParamName, isSanitizedUrlField } from './browserObservation';
import { isOpaqueBrowserRef, isSafeBrowserRefPart } from './browserRef';
import type { NetworkEntrySource, RawNetworkEntry } from '../discovery/network/types';

/**
 * Map a (validated) BrowserObservation into the existing network-discovery `RawNetworkEntry`
 * shape, so the Phase 3.4 capture flow can feed it to `normalizeNetworkEvidence` — the only
 * Evidence creator. This function never creates Evidence itself.
 *
 * Two deliberate translations:
 *  - `source`: the browser layer's `daemon-fixture` becomes the network layer's `fixture`
 *    (`cdp`/`playwright` pass through).
 *  - query NAMES: the observation's `request.url` is query-stripped by the security
 *    invariant, so the names live in `request.queryParamNames`. We reconstruct a values-LESS
 *    query (`?a=&b=`) on the entry URL so the normalizer's `queryParamNames` extracts the
 *    NAMES, while `sanitizeUrlForEvidence` still drops the query from the displayed pattern.
 *    Names are validated value-less by `assertSafeBrowserObservation`, so no value can ride
 *    along here.
 */
const SOURCE_MAP: Record<BrowserObservationSource, NetworkEntrySource> = {
  cdp: 'cdp',
  playwright: 'playwright',
  'daemon-fixture': 'fixture',
};

function withQueryParamNames(url: string, names: readonly unknown[] | undefined): string {
  if (!Array.isArray(names) || names.length === 0) return url;
  // Re-validate each NAME as value-less HERE too: the flow accepts any session, so a
  // source-controlled name must not smuggle a value (`access_token=SECRET`) that
  // `URLSearchParams` would later split back out into the normalizer's queryParamNames.
  const safe = names.filter(isSafeQueryParamName);
  if (safe.length === 0) return url;
  const query = safe.map((name) => `${encodeURIComponent(name)}=`).join('&');
  return url.includes('?') ? `${url}&${query}` : `${url}?${query}`;
}

// Header NAMES safe to forward into evidence: low-cardinality protocol headers (their names
// are useful signal) plus the auth-signal headers the normalizer keys on (their VALUE is
// already `[redacted]` at construction, and their name is excluded from persisted
// safeHeaderNames). Any OTHER name is dropped: the observation gate skips header-NAME checks
// when the value is `[redacted]`, so a source-controlled name like `x-api-key-<secret>` could
// otherwise reach persisted evidence via the normalizer's safeHeaderNames.
const EVIDENCE_FORWARDABLE_HEADERS = new Set<string>([
  'accept', 'accept-encoding', 'accept-language', 'cache-control', 'content-type',
  'content-length', 'content-encoding', 'content-disposition', 'content-location', 'date',
  'last-modified', 'server', 'vary', 'etag', 'location', 'referer', 'origin',
  'x-content-type-options', 'x-frame-options',
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-client-credential', 'x-auth-token',
]);

function filterEvidenceHeaders(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    // Forward a recognized name ONLY with a string value: a non-string JSON value
    // (e.g. `content-type: {raw: 'Bearer ...'}`) would be persisted by the normalizer
    // (including any nested secret fields), so drop it.
    if (EVIDENCE_FORWARDABLE_HEADERS.has(name.toLowerCase()) && typeof value === 'string') out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// MIME cleanup + HTTP-method token checks are shared with the observation gate/session store
// (browserObservation.ts) so the mapper and the session cannot drift apart -- the round-6
// review found exactly that asymmetry (mapper hardened, session path copying verbatim).

// Accept only an ISO-8601 timestamp; a non-ISO / secret-bearing string is rejected so it can't
// ride into evidence as `timestamp`.
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function isoTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 40 && ISO_TIMESTAMP_PATTERN.test(value) ? value : undefined;
}

export function mapBrowserObservationToNetworkEntry(observation: BrowserObservation): RawNetworkEntry | undefined {
  const request = observation.request;
  // The flow accepts ANY NetworkCaptureSession, so an observation reaching the mapper may NOT
  // have passed assertSafeBrowserObservation. Re-validate every security-relevant field here;
  // anything malformed/unsafe -> undefined (a safe skip), never forwarded into evidence:
  //  - url: re-apply the sanitized-URL invariant (no query/encoded-delimiter/endpoint secrets)
  //  - method: a valid HTTP method token only (free-form text could carry creds + crash .toUpperCase())
  //  - id: an opaque, credential-free token (it becomes evidence `source.ref`/`entryId`)
  if (
    !request ||
    typeof request.url !== 'string' ||
    !isSanitizedUrlField(request.url) ||
    !isHttpMethodToken(request.method) ||
    typeof observation.id !== 'string' ||
    !isSafeBrowserRefPart(observation.id) ||
    !isOpaqueBrowserRef(observation.id)
  ) {
    return undefined;
  }

  // Reject an unknown/missing source instead of mislabeling real traffic as `fixture`.
  const source = SOURCE_MAP[observation.source];
  if (!source) {
    return undefined;
  }

  const entry: RawNetworkEntry = {
    id: observation.id,
    url: withQueryParamNames(request.url, request.queryParamNames),
    method: request.method,
    source,
  };

  const requestHeaders = filterEvidenceHeaders(request.headersPreview);
  if (requestHeaders) entry.requestHeaders = requestHeaders;
  if (typeof request.resourceType === 'string') entry.resourceType = request.resourceType;

  const response = observation.response;
  if (response) {
    const responseHeaders = filterEvidenceHeaders(response.headersPreview);
    if (responseHeaders) entry.responseHeaders = responseHeaders;
    // Only a numeric status / constrained MIME type reach evidence: a string status would
    // mislabel, and a free-form mimeType could carry a secret.
    if (typeof response.status === 'number' && Number.isInteger(response.status)) entry.status = response.status;
    const mimeType = cleanMimeType(response.mimeType);
    if (mimeType) entry.mimeType = mimeType;
  }

  // Forward only an ISO-8601 timestamp (entry.startedAt is optional); omit a non-ISO /
  // secret-bearing string so it cannot ride into evidence as `timestamp`.
  const startedAt = isoTimestamp(observation.timing?.startedAt) ?? isoTimestamp(observation.capturedAt);
  if (startedAt !== undefined) entry.startedAt = startedAt;
  if (typeof observation.timing?.durationMs === 'number' && Number.isFinite(observation.timing.durationMs)) {
    entry.durationMs = observation.timing.durationMs;
  }

  return entry;
}
