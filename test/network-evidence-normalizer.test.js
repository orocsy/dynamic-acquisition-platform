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

test('removes query values from evidence URLs', () => {
  const tokenParam = ['access', 'token'].join('_');
  const result = normalizeNetworkEvidence({
    entries: [
      {
        id: 'signed-api',
        url: `https://example.com/api/resource?${tokenParam}=redacted-value&signature=redacted-value&session=redacted-value&code=redacted-value&key=redacted-value`,
        method: 'GET',
        responseHeaders: { 'content-type': 'application/json' },
        status: 200,
        source: 'fixture',
      },
    ],
    targetUrl: `https://example.com/resource?${tokenParam}=redacted-value`,
  });

  assert.equal(result.evidence.length, 1);
  const serialized = JSON.stringify(result.evidence);
  assert.equal(serialized.includes('redacted-value'), false);
  assert.equal(result.evidence[0].target.value, 'https://example.com/resource');
  assert.equal(result.evidence[0].observations[0].data.urlPattern, 'https://example.com/api/resource');
  assert.deepEqual(result.evidence[0].observations[0].data.queryParamNames, [tokenParam, 'code', 'key', 'session', 'signature']);
});

test('does not classify content URLs containing auth-like substrings as auth refresh', () => {
  const result = normalizeNetworkEvidence({
    entries: [
      {
        id: 'author-api',
        url: `https://example.com/api/author/123?${['access', 'token'].join('_')}=redacted-value`,
        method: 'GET',
        responseHeaders: { 'content-type': 'application/json' },
        status: 200,
        source: 'fixture',
      },
    ],
  });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].observations[0].data.category, 'api-json');
});

test('preserves query parameter names for relative URLs without values', () => {
  const tokenParam = ['access', 'token'].join('_');
  const result = normalizeNetworkEvidence({
    entries: [
      {
        id: 'relative-api',
        url: `/api/resource?${tokenParam}=redacted-value&signature=redacted-value`,
        method: 'GET',
        responseHeaders: { 'content-type': 'application/json' },
        status: 200,
        source: 'fixture',
      },
    ],
  });

  assert.equal(result.evidence.length, 1);
  const serialized = JSON.stringify(result.evidence);
  assert.equal(serialized.includes('redacted-value'), false);
  assert.equal(result.evidence[0].target.value, '/api/resource');
  assert.equal(result.evidence[0].observations[0].data.urlPattern, '/api/resource');
  assert.deepEqual(result.evidence[0].observations[0].data.queryParamNames, [tokenParam, 'signature']);
});

test('classifies GraphQL-shaped requests', () => {
  const result = normalizeNetworkEvidence({ entries: graphql.entries });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].observations[0].data.category, 'graphql');
  assert.equal(result.evidence[0].strategySignals[0].kind, 'request-replay-candidate');
});
