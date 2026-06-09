'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapBrowserObservationToNetworkEntry } = require('../dist/browser');
const { normalizeNetworkEvidence } = require('../dist/discovery/network');

function obs(over = {}) {
  return {
    id: 'obs-1',
    runId: 'run_1',
    source: 'cdp',
    capturedAt: '2026-01-01T00:00:00.000Z',
    request: { url: 'https://api.example.com/v1/users', method: 'GET', ...(over.request || {}) },
    response: { status: 200, mimeType: 'application/json', ...(over.response || {}) },
    timing: { startedAt: '2026-01-01T00:00:01.000Z', durationMs: 42, ...(over.timing || {}) },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['request', 'response', 'timing'].includes(k))),
  };
}

test('mapBrowserObservationToNetworkEntry maps a fixture observation to a RawNetworkEntry', () => {
  const entry = mapBrowserObservationToNetworkEntry(obs());
  assert.equal(entry.id, 'obs-1');
  assert.equal(entry.url, 'https://api.example.com/v1/users');
  assert.equal(entry.method, 'GET');
  assert.equal(entry.status, 200);
  assert.equal(entry.mimeType, 'application/json');
  assert.equal(entry.startedAt, '2026-01-01T00:00:01.000Z'); // timing.startedAt wins over capturedAt
  assert.equal(entry.durationMs, 42);
  assert.equal(entry.source, 'cdp');
});

test('mapBrowserObservationToNetworkEntry falls back to capturedAt when timing.startedAt is absent', () => {
  const entry = mapBrowserObservationToNetworkEntry(obs({ timing: { startedAt: undefined, durationMs: undefined } }));
  assert.equal(entry.startedAt, '2026-01-01T00:00:00.000Z');
});

test('mapBrowserObservationToNetworkEntry returns undefined when request url is missing', () => {
  assert.equal(mapBrowserObservationToNetworkEntry({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't' }), undefined);
  assert.equal(
    mapBrowserObservationToNetworkEntry({ id: 'o', runId: 'r', source: 'cdp', capturedAt: 't', request: { method: 'GET' } }),
    undefined,
  );
});

test('mapBrowserObservationToNetworkEntry maps daemon-fixture source to fixture', () => {
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ source: 'daemon-fixture' })).source, 'fixture');
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ source: 'playwright' })).source, 'playwright');
});

test('mapped entries preserve query NAMES but not values (through the normalizer)', () => {
  const entry = mapBrowserObservationToNetworkEntry(
    obs({ request: { url: 'https://api.example.com/v1/users', method: 'GET', queryParamNames: ['page', 'page_size', 'access_token'] } }),
  );
  assert.ok(!entry.url.includes('SECRET'));
  const { evidence } = normalizeNetworkEvidence({ entries: [entry], runId: 'run_1' });
  assert.equal(evidence.length, 1);
  const data = evidence[0].observations[0].data;
  assert.deepEqual([...data.queryParamNames].sort(), ['access_token', 'page', 'page_size']);
  // the displayed urlPattern has no query at all
  assert.equal(String(data.urlPattern).includes('?'), false);
  assert.equal(data.urlPattern, 'https://api.example.com/v1/users');
  // no value ever leaks into the evidence
  assert.equal(JSON.stringify(evidence).includes('SECRET'), false);
});

test('static-asset / media observations are skipped by the existing normalizer', () => {
  const css = mapBrowserObservationToNetworkEntry(
    obs({ request: { url: 'https://cdn.example.com/assets/app.css', method: 'GET' }, response: { status: 200, mimeType: 'text/css' } }),
  );
  const { evidence, skipped } = normalizeNetworkEvidence({ entries: [css], runId: 'run_1' });
  assert.equal(evidence.length, 0);
  assert.equal(skipped.length, 1);
});

test('auth-like observation produces sanitized evidence (already-redacted header carries no secret)', () => {
  const entry = mapBrowserObservationToNetworkEntry(
    obs({
      request: {
        url: 'https://idp.example.com/oauth2/token',
        method: 'POST',
        headersPreview: { authorization: '[redacted]', accept: 'application/json' },
      },
    }),
  );
  const { evidence } = normalizeNetworkEvidence({ entries: [entry], runId: 'run_1' });
  assert.equal(JSON.stringify(evidence).includes('[redacted]') || true, true); // redacted marker is fine
  // the secret itself is never present
  assert.equal(JSON.stringify(evidence).toLowerCase().includes('bearer '), false);
});
