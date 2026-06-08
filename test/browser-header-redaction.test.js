'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toSafeHeaderPreview, assertSafeBrowserObservation } = require('../dist/browser');

test('toSafeHeaderPreview keeps allowlisted values and redacts everything else by construction', () => {
  const preview = toSafeHeaderPreview({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer raw-secret-token',
    Cookie: 'sid=raw-cookie',
    'X-Custom-Tracking': 'some-value',
  });

  // allowlisted header values survive (lowercased names)
  assert.equal(preview.accept, 'application/json');
  assert.equal(preview['content-type'], 'application/json');

  // non-allowlisted values are redacted regardless of sensitivity
  assert.equal(preview.authorization, '[redacted]');
  assert.equal(preview.cookie, '[redacted]');
  assert.equal(preview['x-custom-tracking'], '[redacted]');

  // raw secrets never appear in the serialized preview
  assert.equal(JSON.stringify(preview).includes('raw-secret-token'), false);
  assert.equal(JSON.stringify(preview).includes('raw-cookie'), false);
});

test('a construction-time preview always passes the observation invariant check', () => {
  const observation = {
    id: 'observation_constructed',
    runId: 'run_browser_001',
    source: 'cdp',
    capturedAt: '2026-05-24T00:00:00.000Z',
    request: {
      url: 'https://example.com/account',
      method: 'GET',
      headersPreview: toSafeHeaderPreview({
        Accept: 'application/json',
        Authorization: 'Bearer raw-secret-token',
      }),
    },
  };
  assert.doesNotThrow(() => assertSafeBrowserObservation(observation));
});

test('invariant check rejects a non-allowlisted header carrying a raw value', () => {
  assert.throws(
    () =>
      assertSafeBrowserObservation({
        id: 'observation_unsafe',
        runId: 'run_browser_001',
        source: 'cdp',
        capturedAt: '2026-05-24T00:00:00.000Z',
        request: {
          url: 'https://example.com/account',
          method: 'GET',
          headersPreview: { 'x-tracking-id': 'raw-value' },
        },
      }),
    /must be redacted/,
  );
});

// Review finding #1: URL/filename-bearing allowlisted headers must not preserve
// raw values, or an OAuth code in a Location redirect would persist.
test('toSafeHeaderPreview strips query secrets from a Location redirect', () => {
  const preview = toSafeHeaderPreview({
    Location: 'https://example.com/callback?code=raw-oauth-code&state=raw-state#frag',
  });

  assert.equal(preview.location, 'https://example.com/callback');
  assert.equal(JSON.stringify(preview).includes('raw-oauth-code'), false);
  assert.equal(JSON.stringify(preview).includes('raw-state'), false);
});

test('toSafeHeaderPreview redacts content-disposition filename and etag tokens', () => {
  const preview = toSafeHeaderPreview({
    'Content-Disposition': 'attachment; filename="signed-token-abc123.pdf"',
    ETag: '"opaque-resource-version-xyz"',
  });

  assert.equal(preview['content-disposition'], '[redacted]');
  assert.equal(preview.etag, '[redacted]');
  assert.equal(JSON.stringify(preview).includes('signed-token-abc123'), false);
  assert.equal(JSON.stringify(preview).includes('opaque-resource-version-xyz'), false);
});

test('invariant check rejects a Location value that still carries a query string', () => {
  assert.throws(
    () =>
      assertSafeBrowserObservation({
        id: 'observation_unsanitized_location',
        runId: 'run_browser_001',
        source: 'cdp',
        capturedAt: '2026-05-24T00:00:00.000Z',
        response: {
          status: 302,
          headersPreview: { location: 'https://example.com/callback?code=raw-oauth-code' },
        },
      }),
    /must be redacted/,
  );
});

test('a sanitized Location preview passes the invariant check', () => {
  const observation = {
    id: 'observation_sanitized_location',
    runId: 'run_browser_001',
    source: 'cdp',
    capturedAt: '2026-05-24T00:00:00.000Z',
    response: {
      status: 302,
      headersPreview: toSafeHeaderPreview({ Location: 'https://example.com/callback?code=raw-oauth-code' }),
    },
  };
  assert.doesNotThrow(() => assertSafeBrowserObservation(observation));
});

// Review finding: a URL-bearing header with a non-http(s) scheme (a raw
// ws/devtools/chrome endpoint) was kept with only its query stripped, leaking the
// debugger URL. Now dropped at construction and rejected by the invariant — the
// same http(s)-only policy as sanitizeUrlPreview.
test('toSafeHeaderPreview drops a ws://devtools Location instead of keeping the endpoint', () => {
  const preview = toSafeHeaderPreview({
    Location: 'ws://127.0.0.1:9222/devtools/page/RAW?q=DROPME',
  });
  assert.equal(preview.location, '[redacted]');
  const blob = JSON.stringify(preview);
  assert.equal(blob.includes('ws://'), false);
  assert.equal(blob.includes('devtools'), false);
  assert.equal(blob.includes('DROPME'), false); // whole value dropped, query included
});

test('invariant rejects a Location with a non-http(s) scheme even after the query is stripped', () => {
  for (const loc of [
    'ws://127.0.0.1:9222/devtools/page/RAW',
    'wss://127.0.0.1:9222/devtools/browser/RAW',
    'chrome://version',
    'devtools://devtools/page/RAW',
  ]) {
    assert.throws(
      () =>
        assertSafeBrowserObservation({
          id: 'observation_nonhttp_location',
          runId: 'run_browser_001',
          source: 'cdp',
          capturedAt: '2026-05-24T00:00:00.000Z',
          response: { status: 302, headersPreview: { location: loc } },
        }),
      /must be redacted/,
      `expected ${loc} rejected`,
    );
  }
});

test('a relative or http(s) Location still passes the invariant', () => {
  for (const loc of ['/relative/path', 'https://example.com/ok']) {
    assert.doesNotThrow(() =>
      assertSafeBrowserObservation({
        id: 'observation_ok_location',
        runId: 'run_browser_001',
        source: 'cdp',
        capturedAt: '2026-05-24T00:00:00.000Z',
        response: { status: 302, headersPreview: { location: loc } },
      }),
    );
  }
});

// Codex review: the invariant's scheme check only matched `scheme://`, so opaque
// schemes (javascript:/data:/mailto:) and scheme-relative userinfo slipped past a
// prebuilt observation. Construction drops them; the invariant must too.
test('invariant rejects opaque/non-http, scheme-relative, and smuggled Locations', () => {
  const C = (n) => String.fromCharCode(n);
  const dt = '127.0.0.1:9222/devtools/browser/RAW';
  for (const loc of [
    'javascript:alert(1)',
    'data:text/html,raw',
    'mailto:a@b.com',
    '//x:y@host/path',
    '//' + dt, // scheme-relative devtools endpoint
    '/' + C(9) + '/' + dt, // tab-smuggled
    C(0) + '//' + dt, // NUL-smuggled
  ]) {
    assert.throws(
      () =>
        assertSafeBrowserObservation({
          id: 'observation_opaque_scheme',
          runId: 'run_browser_001',
          source: 'cdp',
          capturedAt: '2026-05-24T00:00:00.000Z',
          response: { status: 302, headersPreview: { location: loc } },
        }),
      /must be redacted/,
      `expected ${JSON.stringify(loc)} rejected`,
    );
  }
});

test('construction drops opaque-scheme, scheme-relative, and smuggled Locations', () => {
  const C = (n) => String.fromCharCode(n);
  const dt = '127.0.0.1:9222/devtools/browser/RAW';
  for (const loc of [
    'javascript:alert(1)',
    'data:text/html,raw',
    'mailto:a@b.com',
    '//x:y@host/path?q=1',
    '//' + dt,
    '/' + C(9) + '/' + dt, // tab-smuggled
    C(0x200b) + '//' + dt, // zero-width-smuggled
  ]) {
    assert.equal(toSafeHeaderPreview({ Location: loc }).location, '[redacted]', `expected redacted: ${JSON.stringify(loc)}`);
  }
});
