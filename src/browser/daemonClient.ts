import { isOpaqueBrowserRef } from './browserRef';
import type { BrowserDaemonFailureCode } from './daemonErrors';
import type { BrowserDaemonMode, BrowserDaemonRef } from './types';

/**
 * Phase 3.2 — daemon health and startup boundary.
 *
 * This module defines how browser integration verifies (or, later, starts) a
 * dedicated Chrome daemon, without letting daemon launch details bleed into
 * runtime semantics. The runtime coordinator never calls these methods; only
 * the (later) browser runtime adapter does, and a daemon failure surfaces as a
 * structured failure rather than a silent fallback to `profile=user`.
 *
 * Refinement #1: the real client speaks raw CDP over the daemon's HTTP
 * `/json/version` endpoint. Playwright remains a possible future implementation
 * behind this same interface, but is not built here.
 */

export const DEFAULT_DAEMON_ENDPOINT = 'http://127.0.0.1:9222';
const DEFAULT_HEALTH_PATH = '/json/version';
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

export type EnsureBrowserDaemonInput = {
  mode?: BrowserDaemonMode;
  /** Base endpoint, e.g. `http://127.0.0.1:9222`. */
  endpoint?: string;
  startIfMissing?: boolean;
  timeoutMs?: number;
  now?: string;
};

export type BrowserDaemonVersion = {
  browser: string;
  protocolVersion?: string;
};

export type BrowserDaemonHealth = {
  ok: true;
  daemonRef: BrowserDaemonRef;
  version: BrowserDaemonVersion;
  checkedAt: string;
};

export type BrowserDaemonFailure = {
  ok: false;
  code: BrowserDaemonFailureCode;
  message: string;
  checkedAt: string;
  diagnostics?: Record<string, unknown>;
};

export type BrowserDaemonHealthResult = BrowserDaemonHealth | BrowserDaemonFailure;

export interface BrowserDaemonClient {
  ensureHealthy(input?: EnsureBrowserDaemonInput): Promise<BrowserDaemonHealthResult>;
  getVersion(ref: BrowserDaemonRef): Promise<BrowserDaemonVersion>;
}

function defaultClock(): string {
  return new Date().toISOString();
}

/**
 * Derive a stable, opaque daemon id from an endpoint without leaking anything
 * beyond host:port. Never embeds debugger websocket URLs or profile details.
 */
export function daemonIdFromEndpoint(endpoint: string): string {
  let hostPort = endpoint;
  try {
    const parsed = new URL(endpoint);
    hostPort = `${parsed.hostname}_${parsed.port || '80'}`;
  } catch {
    hostPort = endpoint.replace(/[^a-z0-9]+/gi, '_');
  }
  const id = `daemon_local_${hostPort.replace(/[^a-z0-9]+/gi, '_')}`;
  return isOpaqueBrowserRef(id) ? id : 'daemon_local_unknown';
}

/**
 * Hosts the local dedicated-daemon adapter is allowed to talk to. The whole
 * Phase 3 design (`docs/stable-chrome-daemon.md`) is a *local* dedicated Chrome
 * daemon, so a `local-chrome-daemon` ref must point at loopback. This also
 * prevents the health check from being pointed at an arbitrary remote host.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export type SafeDaemonOriginOptions = {
  /** Require the endpoint host to be loopback (default true). */
  requireLoopback?: boolean;
};

/**
 * Reduce an endpoint to its safe origin (`scheme://host:port`), stripping any
 * userinfo, path, query, or fragment. Throws if the endpoint carries
 * credentials, is not a parseable absolute URL, or (by default) is not a
 * loopback host, so neither secrets nor a remote host can reach a public
 * `healthUrlPreview` or be silently treated as a local daemon.
 */
export function safeDaemonOrigin(endpoint: string, options: SafeDaemonOriginOptions = {}): string {
  const requireLoopback = options.requireLoopback ?? true;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('daemon endpoint must be an absolute URL (scheme://host:port)');
  }
  if (parsed.username || parsed.password) {
    throw new Error('daemon endpoint must not contain userinfo (credentials)');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`daemon endpoint scheme ${parsed.protocol} is not supported`);
  }
  if (requireLoopback && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`local-chrome-daemon endpoint must be a loopback host; got ${parsed.hostname}`);
  }
  return parsed.origin;
}

/**
 * Build a safe `BrowserDaemonRef`. Because this stamps
 * `kind: 'local-chrome-daemon'`, the endpoint must be a loopback host.
 * `healthUrlPreview` is the origin only (`scheme://host:port`) plus
 * `/json/version` — never userinfo, path, query, or a debugger websocket URL.
 */
export function buildDaemonRef(endpoint: string, mode: BrowserDaemonMode = 'dedicated-daemon'): BrowserDaemonRef {
  const origin = safeDaemonOrigin(endpoint, { requireLoopback: true });
  return {
    id: daemonIdFromEndpoint(origin),
    kind: 'local-chrome-daemon',
    mode,
    healthUrlPreview: `${origin}${DEFAULT_HEALTH_PATH}`,
  };
}

function isValidVersionPayload(value: unknown): value is { Browser?: unknown; 'Protocol-Version'?: unknown } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseVersionPayload(payload: unknown): BrowserDaemonVersion | undefined {
  if (!isValidVersionPayload(payload)) return undefined;
  const browser = (payload as Record<string, unknown>).Browser;
  if (typeof browser !== 'string' || browser.trim().length === 0) return undefined;
  const protocolVersion = (payload as Record<string, unknown>)['Protocol-Version'];
  return {
    browser,
    protocolVersion: typeof protocolVersion === 'string' ? protocolVersion : undefined,
  };
}

export type ChromeDaemonClientOptions = {
  endpoint?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  clock?: () => string;
  timeoutMs?: number;
};

/**
 * Real local Chrome daemon adapter. Talks to the CDP HTTP `/json/version`
 * endpoint over plain fetch. Returns sanitized health results and never exposes
 * the raw `webSocketDebuggerUrl` field that Chrome includes in the payload.
 */
export class ChromeDaemonClient implements BrowserDaemonClient {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #clock: () => string;
  readonly #timeoutMs: number;

  constructor(options: ChromeDaemonClientOptions = {}) {
    this.#endpoint = (options.endpoint ?? DEFAULT_DAEMON_ENDPOINT).replace(/\/+$/, '');
    const resolvedFetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof resolvedFetch !== 'function') {
      throw new Error('ChromeDaemonClient requires a fetch implementation');
    }
    this.#fetch = resolvedFetch;
    this.#clock = options.clock ?? defaultClock;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  }

  async ensureHealthy(input: EnsureBrowserDaemonInput = {}): Promise<BrowserDaemonHealthResult> {
    const mode = input.mode ?? 'dedicated-daemon';
    const checkedAt = input.now ?? this.#clock();

    if (mode !== 'dedicated-daemon') {
      return {
        ok: false,
        code: 'daemon-unhealthy',
        message: `ChromeDaemonClient only supports dedicated-daemon mode by default; got ${mode}`,
        checkedAt,
      };
    }

    // Phase 3.2 implements the health boundary only. Daemon launch lives behind
    // a narrow startup adapter that does not exist yet, so an explicit
    // startIfMissing request is rejected rather than silently ignored.
    if (input.startIfMissing) {
      return {
        ok: false,
        code: 'daemon-start-failed',
        message: 'startIfMissing is not supported yet: daemon launch requires a startup adapter (later Phase 3 work)',
        checkedAt,
      };
    }

    let origin: string;
    try {
      origin = safeDaemonOrigin(input.endpoint ?? this.#endpoint);
    } catch (error) {
      return {
        ok: false,
        code: 'daemon-response-invalid',
        message: error instanceof Error ? error.message : 'invalid daemon endpoint',
        checkedAt,
      };
    }

    const healthUrl = `${origin}${DEFAULT_HEALTH_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(healthUrl, { signal: controller.signal });
    } catch (error) {
      return {
        ok: false,
        code: 'daemon-unavailable',
        message: `daemon health request failed for ${healthUrl}`,
        checkedAt,
        diagnostics: { reason: error instanceof Error ? error.name : 'unknown' },
      };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return {
        ok: false,
        code: 'daemon-unhealthy',
        message: `daemon health endpoint returned status ${response.status}`,
        checkedAt,
        diagnostics: { status: response.status },
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        ok: false,
        code: 'daemon-response-invalid',
        message: 'daemon health response was not valid JSON',
        checkedAt,
      };
    }

    const version = parseVersionPayload(payload);
    if (!version) {
      return {
        ok: false,
        code: 'daemon-response-invalid',
        message: 'daemon health response missing a usable Browser version field',
        checkedAt,
      };
    }

    return {
      ok: true,
      daemonRef: buildDaemonRef(origin, mode),
      version,
      checkedAt,
    };
  }

  async getVersion(ref: BrowserDaemonRef): Promise<BrowserDaemonVersion> {
    const base = ref.healthUrlPreview.replace(new RegExp(`${DEFAULT_HEALTH_PATH}$`), '');
    const result = await this.ensureHealthy({ endpoint: base, mode: ref.mode });
    if (!result.ok) {
      throw new Error(`failed to read daemon version: ${result.message}`);
    }
    return result.version;
  }
}
