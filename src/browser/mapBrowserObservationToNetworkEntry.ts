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

export function mapBrowserObservationToNetworkEntry(observation: BrowserObservation): RawNetworkEntry | undefined {
  const request = observation.request;
  if (!request || !request.url) {
    // The caller records a skipped diagnostic; the normalizer would also skip a missing URL.
    return undefined;
  }

  const entry: RawNetworkEntry = {
    id: String(observation.id),
    url: withQueryParamNames(request.url, request.queryParamNames),
    method: request.method,
    source: SOURCE_MAP[observation.source] ?? 'fixture',
  };

  if (request.headersPreview) entry.requestHeaders = request.headersPreview;
  if (request.resourceType !== undefined) entry.resourceType = request.resourceType;

  const response = observation.response;
  if (response) {
    if (response.headersPreview) entry.responseHeaders = response.headersPreview;
    if (response.status !== undefined) entry.status = response.status;
    if (response.mimeType !== undefined) entry.mimeType = response.mimeType;
  }

  const startedAt = observation.timing?.startedAt ?? observation.capturedAt;
  if (startedAt !== undefined) entry.startedAt = startedAt;
  if (observation.timing?.durationMs !== undefined) entry.durationMs = observation.timing.durationMs;

  return entry;
}
