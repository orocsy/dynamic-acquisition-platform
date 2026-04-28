'use strict';

const { validateEvidence } = require('../../contracts');
const { classifyNetworkEntry } = require('./classifyNetworkEntry');
const { extractRequestSignals } = require('./extractRequestSignals');
const { extractResponseSignals } = require('./extractResponseSignals');

function stableId(prefix, index) {
  return `${prefix}_${String(index + 1).padStart(3, '0')}`;
}

function urlPattern(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function strategySignalFor(category) {
  if (category === 'api-json' || category === 'graphql') return 'request-replay-candidate';
  if (category === 'document-html') return 'browser-render-candidate';
  if (category === 'auth-token-refresh') return 'auth-session-signal';
  return 'unknown-network-signal';
}

function normalizeNetworkEvidence(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const evidence = [];
  const diagnostics = [];
  const skipped = [];

  entries.forEach((entry, index) => {
    if (!entry || !entry.url) {
      skipped.push({ index, reason: 'missing-url' });
      return;
    }

    const classification = classifyNetworkEntry(entry);
    if (classification.category === 'static-asset' || classification.category === 'media') {
      skipped.push({ index, id: entry.id, url: entry.url, reason: classification.category });
      return;
    }

    const request = extractRequestSignals(entry);
    const response = extractResponseSignals(entry);
    const observationId = stableId('obs', evidence.length);
    const evidenceId = stableId('evidence', evidence.length);

    const candidate = {
      version: '0.1',
      evidenceId,
      intentId: input.intentId,
      target: {
        kind: 'url',
        value: input.targetUrl || entry.url,
      },
      observations: [
        {
          id: observationId,
          kind: 'network-request',
          summary: `Observed ${classification.category} network entry`,
          source: {
            kind: entry.source || 'fixture',
            ref: entry.id || `entry-${index}`,
          },
          data: {
            category: classification.category,
            method: request.method,
            urlPattern: urlPattern(entry.url),
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
          urlPattern: urlPattern(entry.url),
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

    const validation = validateEvidence(candidate);
    if (!validation.ok) {
      diagnostics.push({ level: 'error', code: 'INVALID_EVIDENCE', entryId: entry.id, errors: validation.errors });
      skipped.push({ index, id: entry.id, url: entry.url, reason: 'invalid-evidence' });
      return;
    }

    diagnostics.push({ level: 'info', code: 'EVIDENCE_EMITTED', entryId: entry.id, category: classification.category });
    evidence.push(candidate);
  });

  return { evidence, diagnostics, skipped };
}

module.exports = { normalizeNetworkEvidence };
