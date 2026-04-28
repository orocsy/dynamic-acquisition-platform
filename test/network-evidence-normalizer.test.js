'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEvidence } = require('../dist/contracts');
const { normalizeNetworkEvidence } = require('../dist/discovery/network');

const basic = require('../src/fixtures/network/synthetic-har-basic.json');
const authenticated = require('../src/fixtures/network/synthetic-har-authenticated-api.json');
const staticAssets = require('../src/fixtures/network/synthetic-har-static-assets.json');
const graphql = require('../src/fixtures/network/synthetic-har-graphql.json');

test('normalizes a basic JSON API request into valid evidence', () => {
  const result = normalizeNetworkEvidence({ entries: basic.entries, targetUrl: 'https://example.com/resource/123', runId: 'run_01' });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(validateEvidence(result.evidence[0]).ok, true);
  assert.equal(result.evidence[0].observations[0].data.category, 'api-json');
  assert.equal(result.evidence[0].observations[0].data.method, 'GET');
  assert.equal(result.evidence[0].observations[0].data.status, 200);
  assert.equal(result.evidence[0].observations[0].data.responseContentType, 'application/json');
});

test('skips static assets', () => {
  const result = normalizeNetworkEvidence({ entries: staticAssets.entries });

  assert.equal(result.evidence.length, 0);
  assert.deepEqual(result.skipped.map((item) => item.reason), ['static-asset', 'static-asset']);
});

test('detects auth headers without storing raw secrets', () => {
  const result = normalizeNetworkEvidence({ entries: authenticated.entries });

  assert.equal(result.evidence.length, 1);
  const serialized = JSON.stringify(result.evidence);
  assert.equal(serialized.includes('redacted-value'), false);

  const data = result.evidence[0].observations[0].data;
  assert.deepEqual(data.authSignals, ['authorization-header-present', 'cookie-present']);
  assert.deepEqual(data.safeRequestHeaderNames, ['accept']);
  assert.deepEqual(data.paginationHints, ['json-next-field']);
});

test('classifies GraphQL-shaped requests', () => {
  const result = normalizeNetworkEvidence({ entries: graphql.entries });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].observations[0].data.category, 'graphql');
  assert.equal(result.evidence[0].strategySignals[0].kind, 'request-replay-candidate');
});
