import type { BrowserObservation } from './browserObservation';
import { assertSafeBrowserObservation } from './browserObservation';
import type { PageTargetRef } from './types';

export type StartNetworkCaptureInput = {
  runId: string;
  pageTargetRef: PageTargetRef | string;
  now?: string;
};

export type StopNetworkCaptureInput = {
  runId: string;
  pageTargetRef: PageTargetRef | string;
  now?: string;
};

export type NetworkCaptureResult = {
  observations: BrowserObservation[];
  diagnostics: Record<string, unknown>[];
};

export interface NetworkCaptureSession {
  start(input: StartNetworkCaptureInput): Promise<void>;
  stop(input: StopNetworkCaptureInput): Promise<NetworkCaptureResult>;
  listObservations(runId: string): Promise<BrowserObservation[]>;
}

/**
 * DI seam (mirrors `CdpTargetTransport`): the upstream source of raw observations a
 * daemon/CDP transport captured for a page target between `start` and `stop`. A fake supplies
 * fixtures in tests; the real transport is out of scope for Phase 3.4.
 */
export interface NetworkObservationSource {
  collect(input: { runId: string; pageTargetRef: string }): Promise<readonly BrowserObservation[]>;
}

export class NotImplementedNetworkObservationSource implements NetworkObservationSource {
  async collect(): Promise<readonly BrowserObservation[]> {
    throw new Error('network observation source not implemented for this daemon transport');
  }
}

/**
 * Rebuild an observation from ONLY the whitelisted BrowserObservation fields. The
 * field-by-field invariant validates known URL/header/query/id fields but does not reject
 * EXTRA keys, so a raw source could attach `rawRequestHeaders`/`postData` (with credentials)
 * that would otherwise survive `stop()`/`listObservations()` and reach the normalizer. Run
 * this AFTER `assertSafeBrowserObservation`, on an already-validated observation.
 */
function pickSafeObservation(observation: BrowserObservation): BrowserObservation {
  const safe: BrowserObservation = {
    id: observation.id,
    runId: observation.runId,
    source: observation.source,
    capturedAt: observation.capturedAt,
  };
  if (observation.pageTargetRef !== undefined) safe.pageTargetRef = observation.pageTargetRef;
  if (observation.request) {
    const request = observation.request;
    safe.request = { url: request.url, method: request.method };
    if (request.headersPreview) safe.request.headersPreview = { ...request.headersPreview };
    if (request.resourceType !== undefined) safe.request.resourceType = request.resourceType;
    if (request.bodyShape !== undefined) safe.request.bodyShape = request.bodyShape;
    if (Array.isArray(request.queryParamNames)) safe.request.queryParamNames = [...request.queryParamNames];
  }
  if (observation.response) {
    const response = observation.response;
    safe.response = {};
    if (response.status !== undefined) safe.response.status = response.status;
    if (response.mimeType !== undefined) safe.response.mimeType = response.mimeType;
    if (response.headersPreview) safe.response.headersPreview = { ...response.headersPreview };
    if (response.bodyShape !== undefined) safe.response.bodyShape = response.bodyShape;
  }
  if (observation.timing) {
    const timing = observation.timing;
    safe.timing = {};
    if (timing.startedAt !== undefined) safe.timing.startedAt = timing.startedAt;
    if (timing.durationMs !== undefined) safe.timing.durationMs = timing.durationMs;
  }
  return safe;
}

/**
 * In-memory capture session. `start` marks a (runId, pageTargetRef) window active; `stop`
 * collects raw observations from the source, runs each through `assertSafeBrowserObservation`
 * as a fail-safe gate (an unsafe one is EXCLUDED — never returned or stored — with a
 * value-free diagnostic), stores the safe ones, and returns them. So only invariant-clean
 * observations can ever reach the evidence bridge.
 */
export class BrowserNetworkCaptureSession implements NetworkCaptureSession {
  readonly #source: NetworkObservationSource;
  readonly #active = new Set<string>();
  readonly #observations = new Map<string, BrowserObservation[]>();

  constructor(source: NetworkObservationSource = new NotImplementedNetworkObservationSource()) {
    this.#source = source;
  }

  async start(input: StartNetworkCaptureInput): Promise<void> {
    this.#active.add(this.#key(input.runId, input.pageTargetRef));
  }

  async stop(input: StopNetworkCaptureInput): Promise<NetworkCaptureResult> {
    const key = this.#key(input.runId, input.pageTargetRef);
    if (!this.#active.has(key)) {
      throw new Error('network capture stop requires a prior start for this run/pageTargetRef');
    }

    const expectedTarget = String(input.pageTargetRef);
    // Collect BEFORE clearing the active window, so a transient collect failure leaves the
    // capture retryable (stop() can be called again) instead of failing 'requires a prior
    // start' forever.
    const raw = await this.#source.collect({ runId: input.runId, pageTargetRef: expectedTarget });
    this.#active.delete(key);

    const observations: BrowserObservation[] = [];
    const diagnostics: Record<string, unknown>[] = [];

    raw.forEach((observation, index) => {
      // Accept ONLY observations stamped with THIS exact (runId, pageTargetRef) window. A
      // same-run entry MISSING pageTargetRef (or from another run/page) is buffered/stale and
      // would contaminate this page's evidence -> skip it. The diagnostic is positional only.
      const sameRun = observation?.runId === input.runId;
      const sameTarget =
        observation?.pageTargetRef !== undefined && String(observation.pageTargetRef) === expectedTarget;
      if (!sameRun || !sameTarget) {
        diagnostics.push({ level: 'warning', code: 'observation-window-mismatch-skipped', index });
        return;
      }
      try {
        assertSafeBrowserObservation(observation);
        // Store ONLY the whitelisted fields, so an extra source-controlled property can't
        // survive the gate (it validates known fields, not unknown keys).
        observations.push(pickSafeObservation(observation));
      } catch {
        // A rejected observation is source-controlled: do NOT echo its id or the assertion
        // message (which can name a header) -- a positional skip id leaks nothing.
        diagnostics.push({ level: 'warning', code: 'unsafe-observation-skipped', index });
      }
    });

    const existing = this.#observations.get(input.runId) ?? [];
    this.#observations.set(input.runId, [...existing, ...observations]);
    return { observations, diagnostics };
  }

  async listObservations(runId: string): Promise<BrowserObservation[]> {
    return [...(this.#observations.get(runId) ?? [])];
  }

  #key(runId: string, pageTargetRef: PageTargetRef | string): string {
    return JSON.stringify([runId, String(pageTargetRef)]);
  }
}
