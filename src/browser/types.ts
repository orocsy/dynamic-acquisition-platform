export type BrowserRefBrand<TValue, TBrand extends string> = TValue & { readonly __browserBrand: TBrand };

export type BrowserDaemonId = BrowserRefBrand<string, 'BrowserDaemonId'>;
export type PageTargetRef = BrowserRefBrand<string, 'PageTargetRef'>;
export type BrowserObservationId = BrowserRefBrand<string, 'BrowserObservationId'>;

export type BrowserDaemonMode = 'dedicated-daemon' | 'manual-user-bridge';

export type BrowserDaemonRef = {
  id: BrowserDaemonId | string;
  kind: 'local-chrome-daemon';
  mode: BrowserDaemonMode;
  healthUrlPreview: string;
};

export type BrowserSessionRefParts = {
  daemonId: string;
  runId: string;
};

/**
 * The lifecycle state of a browser page target. Shared by the Phase 3.3
 * `PageTargetController` (state machine) and any later slice that summarizes a
 * target. `BrowserNavigationResult`, the auth-boundary signal, and runtime
 * diagnostics are defined by their owning slices (3.3 / 3.5), not here, so each
 * shape has a single source of truth.
 */
export type BrowserTargetState = 'created' | 'navigating' | 'ready' | 'stale' | 'closed';
