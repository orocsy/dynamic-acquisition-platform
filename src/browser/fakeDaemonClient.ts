import {
  buildDaemonRef,
  DEFAULT_DAEMON_ENDPOINT,
  type BrowserDaemonClient,
  type BrowserDaemonHealthResult,
  type BrowserDaemonVersion,
  type EnsureBrowserDaemonInput,
} from './daemonClient';
import type { BrowserDaemonFailureCode } from './daemonErrors';
import type { BrowserDaemonRef } from './types';

/**
 * Deterministic in-memory daemon client for unit and fixture tests. Makes no
 * network calls and never launches Chrome, so the daemon boundary can be tested
 * without a real browser. Supports failure injection so callers can exercise
 * every `BrowserDaemonFailureCode` path.
 */

export type FakeBrowserDaemonClientOptions = {
  endpoint?: string;
  version?: BrowserDaemonVersion;
  /** When set, `ensureHealthy` returns this failure instead of a healthy result. */
  failWith?: { code: BrowserDaemonFailureCode; message?: string; diagnostics?: Record<string, unknown> };
  clock?: () => string;
};

const DEFAULT_FAKE_VERSION: BrowserDaemonVersion = {
  browser: 'Chrome/0.0.0-fake',
  protocolVersion: '1.3',
};

function defaultClock(): string {
  return new Date().toISOString();
}

export class FakeBrowserDaemonClient implements BrowserDaemonClient {
  readonly #endpoint: string;
  readonly #version: BrowserDaemonVersion;
  readonly #clock: () => string;
  #failWith: FakeBrowserDaemonClientOptions['failWith'];

  constructor(options: FakeBrowserDaemonClientOptions = {}) {
    this.#endpoint = (options.endpoint ?? DEFAULT_DAEMON_ENDPOINT).replace(/\/+$/, '');
    this.#version = options.version ?? DEFAULT_FAKE_VERSION;
    this.#failWith = options.failWith;
    this.#clock = options.clock ?? defaultClock;
  }

  /** Flip the fake into a failing state (or clear it with `undefined`). */
  setFailure(failWith: FakeBrowserDaemonClientOptions['failWith']): void {
    this.#failWith = failWith;
  }

  async ensureHealthy(input: EnsureBrowserDaemonInput = {}): Promise<BrowserDaemonHealthResult> {
    const checkedAt = input.now ?? this.#clock();
    const mode = input.mode ?? 'dedicated-daemon';

    if (mode !== 'dedicated-daemon') {
      return {
        ok: false,
        code: 'daemon-unhealthy',
        message: `fake daemon only supports dedicated-daemon mode; got ${mode}`,
        checkedAt,
      };
    }

    // Mirror the real client: Phase 3.2 does not launch daemons.
    if (input.startIfMissing) {
      return {
        ok: false,
        code: 'daemon-start-failed',
        message: 'startIfMissing is not supported yet: daemon launch requires a startup adapter (later Phase 3 work)',
        checkedAt,
      };
    }

    if (this.#failWith) {
      return {
        ok: false,
        code: this.#failWith.code,
        message: this.#failWith.message ?? `fake daemon failure: ${this.#failWith.code}`,
        checkedAt,
        diagnostics: this.#failWith.diagnostics,
      };
    }

    let daemonRef;
    try {
      daemonRef = buildDaemonRef(input.endpoint ?? this.#endpoint, mode);
    } catch (error) {
      return {
        ok: false,
        code: 'daemon-response-invalid',
        message: error instanceof Error ? error.message : 'invalid daemon endpoint',
        checkedAt,
      };
    }

    return {
      ok: true,
      daemonRef,
      version: this.#version,
      checkedAt,
    };
  }

  async getVersion(_ref: BrowserDaemonRef): Promise<BrowserDaemonVersion> {
    if (this.#failWith) {
      throw new Error(`fake daemon failure: ${this.#failWith.code}`);
    }
    return this.#version;
  }
}
