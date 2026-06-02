export const BROWSER_DAEMON_FAILURE_CODES = [
  'daemon-unavailable',
  'daemon-unhealthy',
  'daemon-start-failed',
  'daemon-response-invalid',
] as const;

export type BrowserDaemonFailureCode = (typeof BROWSER_DAEMON_FAILURE_CODES)[number];

export class BrowserDaemonError extends Error {
  readonly code: BrowserDaemonFailureCode;
  readonly diagnostics?: Record<string, unknown>;

  constructor(code: BrowserDaemonFailureCode, message: string, diagnostics?: Record<string, unknown>) {
    super(message);
    this.name = 'BrowserDaemonError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export function isBrowserDaemonError(value: unknown): value is BrowserDaemonError {
  return value instanceof BrowserDaemonError;
}
