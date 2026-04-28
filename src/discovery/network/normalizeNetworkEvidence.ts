import { validateEvidence } from '../../contracts';
import { classifyNetworkEntry } from './classifyNetworkEntry';
import { extractRequestSignals } from './extractRequestSignals';
import { extractResponseSignals } from './extractResponseSignals';
import { sanitizeUrlForEvidence } from './sanitizeUrlForEvidence';
import type {
  Diagnostic,
  Evidence,
  NetworkEntryCategory,
  NetworkEvidenceNormalizerInput,
  NetworkEvidenceNormalizerResult,
  RawNetworkEntry,
  SkippedEntry,
} from './types';

type ValidationResult = { ok: boolean; errors: string[] };

function stableId(prefix: string, index: number): string {
  return `${prefix}_${String(index + 1).padStart(3, '0')}`;
}

function strategySignalFor(category: NetworkEntryCategory): string {
  if (category === 'api-json' || category === 'graphql') return 'request-replay-candidate';
  if (category === 'document-html') return 'browser-render-candidate';
  if (category === 'auth-token-refresh') return 'auth-session-signal';
  return 'unknown-network-signal';
}

function sourceKind(entry: RawNetworkEntry): RawNetworkEntry['source'] {
  return entry.source || 'fixture';
}

export function normalizeNetworkEvidence(input: NetworkEvidenceNormalizerInput = { entries: [] }): NetworkEvidenceNormalizerResult {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const evidence: Evidence[] = [];
  const diagnostics: Diagnostic[] = [];
  const skipped: SkippedEntry[] = [];

  entries.forEach((entry, index) => {
    if (!entry || !entry.url) {
      skipped.push({ index, reason: 'missing-url' });
      return;
    }

    const classification = classifyNetworkEntry(entry);
    if (classification.category === 'static-asset' || classification.category === 'media') {
      skipped.push({ index, id: entry.id, url: sanitizeUrlForEvidence(entry.url), reason: classification.category });
      return;
    }

    const request = extractRequestSignals(entry);
    const response = extractResponseSignals(entry);
    const observationId = stableId('obs', evidence.length);
    const evidenceId = stableId('evidence', evidence.length);

    const candidate: Evidence = {
      version: '0.1',
      evidenceId,
      intentId: input.intentId,
      target: {
        kind: 'url',
        value: sanitizeUrlForEvidence(input.targetUrl || entry.url),
      },
      observations: [
        {
          id: observationId,
          kind: 'network-request',
          summary: `Observed ${classification.category} network entry`,
          source: {
            kind: sourceKind(entry),
            ref: entry.id || `entry-${index}`,
          },
          data: {
            category: classification.category,
            method: request.method,
            urlPattern: sanitizeUrlForEvidence(entry.url),
            pathname: request.pathname,
            queryParamNames: request.queryParamNames,
            status: response.status,
            requestContentType: request.contentType,
            responseContentType: response.contentType,
            requestBodyShape: request.bodyShape,
            responseBodyShape: response.bodyShape,
            paginationHints: response.paginationHints,
            safeRequestHeaderNames: request.safeHeaderNames,
            authSignals: request.authSignals,
          },
          confidence: classification.confidence,
          timestamp: entry.startedAt,
        },
      ],
      requestFamilies: [
        {
          id: stableId('request_family', evidence.length),
          purpose: classification.category === 'document-html' ? 'document-load' : 'content-fetch',
          method: request.method,
          urlPattern: sanitizeUrlForEvidence(entry.url),
          authSignals: request.authSignals,
          sources: [observationId],
          confidence: classification.confidence,
        },
      ],
      strategySignals: [
        {
          kind: strategySignalFor(classification.category),
          strength: classification.confidence,
          sources: [observationId],
        },
      ],
      gaps: [],
      provenance: [
        {
          kind: 'network-normalization',
          tool: 'dynamic-acquisition-platform',
          runId: input.runId,
          timestamp: new Date(0).toISOString(),
        },
      ],
    };

    const validation = validateEvidence(candidate) as ValidationResult;
    if (!validation.ok) {
      diagnostics.push({ level: 'error', code: 'INVALID_EVIDENCE', entryId: entry.id, errors: validation.errors });
      skipped.push({ index, id: entry.id, url: sanitizeUrlForEvidence(entry.url), reason: 'invalid-evidence' });
      return;
    }

    diagnostics.push({ level: 'info', code: 'EVIDENCE_EMITTED', entryId: entry.id, category: classification.category });
    evidence.push(candidate);
  });

  return { evidence, diagnostics, skipped };
}
