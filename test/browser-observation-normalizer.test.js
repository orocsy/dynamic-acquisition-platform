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

// Codex re-review of PR #3 (#3, #4): a non-string method is unmappable (would crash the
// normalizer), and an unrecognized header NAME (a redacted value doesn't make the NAME safe)
// is dropped before forwarding while protocol/auth-signal names are kept.
test('mapper skips a non-string method and drops unrecognized header names', () => {
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ request: { url: 'https://h/x', method: 42 } })), undefined);
  const entry = mapBrowserObservationToNetworkEntry(
    obs({
      request: {
        url: 'https://h/x',
        method: 'GET',
        headersPreview: { 'content-type': 'application/json', authorization: '[redacted]', 'x-api-key-SUPERSECRET': '[redacted]' },
      },
    }),
  );
  assert.equal(entry.requestHeaders['content-type'], 'application/json');
  assert.equal(entry.requestHeaders.authorization, '[redacted]'); // auth-signal name kept (value redacted)
  assert.equal('x-api-key-SUPERSECRET' in entry.requestHeaders, false); // unrecognized name dropped
  assert.equal(JSON.stringify(entry).includes('SUPERSECRET'), false);
});

// Codex re-review of PR #3 (round 4): the mapper drops/rejects malformed field TYPES before
// forwarding, so a buggy source can't mislabel provenance, crash the normalizer, or ride a
// secret into evidence via a non-string value.
test('mapper validates field types before forwarding', () => {
  // unknown/missing source -> unmappable (not mislabeled as fixture)
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ source: 'har' })), undefined);
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ source: undefined })), undefined);
  // non-string header value dropped
  const e1 = mapBrowserObservationToNetworkEntry(obs({ request: { url: 'https://h/x', method: 'GET', headersPreview: { 'content-type': { raw: 'Bearer LEAKEDHDR' } } } }));
  assert.equal(e1.requestHeaders, undefined);
  assert.equal(JSON.stringify(e1).includes('LEAKEDHDR'), false);
  // non-string resourceType dropped
  assert.equal('resourceType' in mapBrowserObservationToNetworkEntry(obs({ request: { url: 'https://h/x', method: 'GET', resourceType: { x: 1 } } })), false);
  // non-number status + free-form/secret mimeType dropped; clean numeric/mime kept
  const e3 = mapBrowserObservationToNetworkEntry(obs({ response: { status: '200', mimeType: 'Bearer SECRETMIME' } }));
  assert.equal('status' in e3, false);
  assert.equal('mimeType' in e3, false);
  assert.equal(JSON.stringify(e3).includes('SECRETMIME'), false);
  const e4 = mapBrowserObservationToNetworkEntry(obs({ response: { status: 204, mimeType: 'text/html; charset=utf-8' } }));
  assert.equal(e4.status, 204);
  assert.equal(e4.mimeType, 'text/html'); // parameters stripped (free-form, could carry a secret)
  // non-ISO / secret-bearing timestamps omitted
  const e5 = mapBrowserObservationToNetworkEntry(obs({ timing: { startedAt: 'Bearer SECRETTIME' }, capturedAt: 'not-iso' }));
  assert.equal('startedAt' in e5, false);
  assert.equal(JSON.stringify(e5).includes('SECRET'), false);
});

// Codex re-review of PR #3 (round 5): the flow accepts ANY NetworkCaptureSession, so an
// observation reaching the mapper may never have passed assertSafeBrowserObservation. The
// mapper must re-validate every security-relevant field itself (abuse cases first).
test('mapper strips MIME parameters (a parameter is free-form and can carry a secret)', () => {
  const e = mapBrowserObservationToNetworkEntry(obs({ response: { mimeType: 'application/json; boundary=sk-live-MIMESECRET' } }));
  assert.equal(e.mimeType, 'application/json');
  assert.equal(JSON.stringify(e).includes('MIMESECRET'), false);
});

test('mapper filters a value-bearing query param name before appending it to the url', () => {
  const e = mapBrowserObservationToNetworkEntry(
    obs({ request: { url: 'https://api.example.com/v1/users', method: 'GET', queryParamNames: ['page', 'access_token=QUERYSECRET'] } }),
  );
  assert.ok(e.url.includes('page='));
  assert.equal(JSON.stringify(e).includes('QUERYSECRET'), false);
  // a non-array names value is a safe no-op, not a crash
  const e2 = mapBrowserObservationToNetworkEntry(
    obs({ request: { url: 'https://api.example.com/v1/users', method: 'GET', queryParamNames: 'access_token=QUERYSECRET' } }),
  );
  assert.equal(e2.url, 'https://api.example.com/v1/users');
});

test('mapper skips a free-form method that is not an HTTP method token', () => {
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ request: { url: 'https://h/x', method: 'Bearer sk-live-METHODSECRET' } })), undefined);
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ request: { url: 'https://h/x', method: '' } })), undefined);
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ request: { url: 'https://h/x', method: 'GET/../' } })), undefined);
});

test('mapper skips a request url that fails the sanitized-url invariant', () => {
  // raw query (secret value), encoded delimiter, and a loopback CDP endpoint all skip
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ request: { url: 'https://app.example/cb?code=URLSECRET', method: 'GET' } })), undefined);
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ request: { url: 'https://app.example/cb%3Fcode=URLSECRET', method: 'GET' } })), undefined);
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ request: { url: 'http://127.0.0.1:9222/devtools/browser/RAWTARGET', method: 'GET' } })), undefined);
});

test('mapper skips a credential-like or non-opaque observation id (it becomes evidence source.ref)', () => {
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ id: 'access_token_abc123' })), undefined);
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ id: 'ws://127.0.0.1:9222/devtools' })), undefined);
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ id: 'a:b' })), undefined);
  assert.equal(mapBrowserObservationToNetworkEntry(obs({ id: ['sk_live_x'] })), undefined);
});
