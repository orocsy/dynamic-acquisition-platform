export type NetworkEntrySource = 'har' | 'playwright' | 'cdp' | 'fixture';

export type NetworkEntryCategory =
  | 'api-json'
  | 'document-html'
  | 'static-asset'
  | 'media'
  | 'graphql'
  | 'auth-token-refresh'
  | 'unknown';

export type HeaderMap = Record<string, string>;

export type RawNetworkEntry = {
  id?: string;
  url: string;
  method: string;
  requestHeaders?: HeaderMap;
  responseHeaders?: HeaderMap;
  status?: number;
  mimeType?: string;
  resourceType?: string;
  requestBodyPreview?: string;
  responseBodyPreview?: string;
  startedAt?: string;
  durationMs?: number;
  source: NetworkEntrySource;
};

export type NetworkEvidenceNormalizerInput = {
  entries: RawNetworkEntry[];
  targetUrl?: string;
  intentId?: string;
  runId?: string;
};

export type NetworkEntryClassification = {
  category: NetworkEntryCategory;
  confidence: number;
  reasons: string[];
};

export type RequestSignals = {
  method: string;
  url: string;
  origin?: string;
  pathname: string;
  queryParamNames: string[];
  contentType?: string;
  safeHeaderNames: string[];
  authSignals: string[];
  bodyShape?: 'json-object' | 'json-array' | 'form-like' | 'text-preview';
};

export type ResponseSignals = {
  status?: number;
  contentType?: string;
  bodyShape?: 'json-list' | 'json-object' | 'json' | 'html-document' | 'downloadable-pdf' | 'text-preview';
  paginationHints: string[];
  durationMs?: number;
};

export type Diagnostic = {
  level: 'info' | 'warning' | 'error';
  code: string;
  entryId?: string;
  category?: NetworkEntryCategory;
  errors?: string[];
};

export type SkippedEntry = {
  index: number;
  id?: string;
  url?: string;
  reason: string;
};

export type EvidenceObservation = {
  id: string;
  kind: 'network-request';
  summary: string;
  source: {
    kind: NetworkEntrySource;
    ref: string;
  };
  data: Record<string, unknown>;
  confidence: number;
  timestamp?: string;
};

export type Evidence = {
  version: '0.1';
  evidenceId: string;
  intentId?: string;
  target: {
    kind: 'url';
    value: string;
  };
  observations: EvidenceObservation[];
  requestFamilies: Array<Record<string, unknown>>;
  strategySignals: Array<Record<string, unknown>>;
  gaps: unknown[];
  provenance: Array<Record<string, unknown>>;
};

export type NetworkEvidenceNormalizerResult = {
  evidence: Evidence[];
  diagnostics: Diagnostic[];
  skipped: SkippedEntry[];
};
