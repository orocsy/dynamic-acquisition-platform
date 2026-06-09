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
    this.#active.delete(key);

    const raw = await this.#source.collect({ runId: input.runId, pageTargetRef: String(input.pageTargetRef) });
    const observations: BrowserObservation[] = [];
    const diagnostics: Record<string, unknown>[] = [];

    for (const observation of raw) {
      try {
        assertSafeBrowserObservation(observation);
        observations.push(observation);
      } catch (error) {
        // Drop the unsafe observation (never return/store it) and record a value-free
        // diagnostic: assertSafeBrowserObservation's messages name the field, never the value.
        diagnostics.push({
          level: 'warning',
          code: 'unsafe-observation-skipped',
          observationId: typeof observation?.id === 'string' ? observation.id : undefined,
          reason: error instanceof Error ? error.message : 'unsafe observation',
        });
      }
    }

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
