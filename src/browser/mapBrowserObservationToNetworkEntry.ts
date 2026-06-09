import type { BrowserObservation, BrowserObservationSource } from './browserObservation';
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

function withQueryParamNames(url: string, names: readonly string[] | undefined): string {
  if (!names || names.length === 0) return url;
  const query = names.map((name) => `${encodeURIComponent(name)}=`).join('&');
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

function filterEvidenceHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (EVIDENCE_FORWARDABLE_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mapBrowserObservationToNetworkEntry(observation: BrowserObservation): RawNetworkEntry | undefined {
  const request = observation.request;
  // A url-less observation, or one whose url/method is not a non-empty string (malformed
  // daemon JSON), is unmappable -> undefined (a safe skip), never forwarded: a non-string
  // method would crash the normalizer's `.toUpperCase()` and abort the whole capture flow.
  if (
    !request ||
    typeof request.url !== 'string' ||
    request.url.length === 0 ||
    typeof request.method !== 'string' ||
    request.method.length === 0
  ) {
    return undefined;
  }

  const entry: RawNetworkEntry = {
    id: String(observation.id),
    url: withQueryParamNames(request.url, request.queryParamNames),
    method: request.method,
    source: SOURCE_MAP[observation.source] ?? 'fixture',
  };

  const requestHeaders = filterEvidenceHeaders(request.headersPreview);
  if (requestHeaders) entry.requestHeaders = requestHeaders;
  if (request.resourceType !== undefined) entry.resourceType = request.resourceType;

  const response = observation.response;
  if (response) {
    const responseHeaders = filterEvidenceHeaders(response.headersPreview);
    if (responseHeaders) entry.responseHeaders = responseHeaders;
    if (response.status !== undefined) entry.status = response.status;
    if (response.mimeType !== undefined) entry.mimeType = response.mimeType;
  }

  const startedAt = observation.timing?.startedAt ?? observation.capturedAt;
  if (startedAt !== undefined) entry.startedAt = startedAt;
  if (observation.timing?.durationMs !== undefined) entry.durationMs = observation.timing.durationMs;

  return entry;
}
