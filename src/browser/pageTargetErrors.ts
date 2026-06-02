import type { BrowserTargetState } from './types';

/**
 * Phase 3.3 — structured errors for page target lifecycle misuse.
 *
 * Invalid state transitions and unsafe refs surface as a typed `PageTargetError`
 * (a rejected promise), never as a silent state change and never as a runtime
 * checkpoint mutation — the coordinator owns lifecycle, the controller only owns
 * the browser-side page target. Keeping these codes in one union lets callers
 * branch on the failure without string-matching messages.
 */

export const PAGE_TARGET_ERROR_CODES = [
  'unknown-target',
  'invalid-transition',
  'target-stale',
  'target-closed',
  'unsafe-target-ref',
  'transport-unavailable',
] as const;

export type PageTargetErrorCode = (typeof PAGE_TARGET_ERROR_CODES)[number];

export type PageTargetErrorDetails = {
  pageTargetRef?: string;
  from?: BrowserTargetState;
  to?: BrowserTargetState;
  diagnostics?: Record<string, unknown>;
};

export class PageTargetError extends Error {
  readonly code: PageTargetErrorCode;
  readonly pageTargetRef?: string;
  readonly from?: BrowserTargetState;
  readonly to?: BrowserTargetState;
  readonly diagnostics?: Record<string, unknown>;

  constructor(code: PageTargetErrorCode, message: string, details: PageTargetErrorDetails = {}) {
    super(message);
    this.name = 'PageTargetError';
    this.code = code;
    this.pageTargetRef = details.pageTargetRef;
    this.from = details.from;
    this.to = details.to;
    this.diagnostics = details.diagnostics;
  }
}

export function isPageTargetError(value: unknown): value is PageTargetError {
  return value instanceof PageTargetError;
}
