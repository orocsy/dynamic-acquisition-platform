'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ChromeDaemonClient,
  FakeBrowserDaemonClient,
  buildDaemonRef,
  daemonIdFromEndpoint,
} = require('../dist/browser');

const FIXED_NOW = '2026-05-24T00:00:00.000Z';

test('fake healthy daemon returns ok with a safe daemon ref and version', async () => {
  const client = new FakeBrowserDaemonClient({ endpoint: 'http://127.0.0.1:9333' });
  const result = await client.ensureHealthy({ now: FIXED_NOW });

  assert.equal(result.ok, true);
  assert.equal(result.checkedAt, FIXED_NOW);
  assert.equal(result.daemonRef.kind, 'local-chrome-daemon');
  assert.equal(result.daemonRef.mode, 'dedicated-daemon');
  assert.equal(result.daemonRef.healthUrlPreview, 'http://127.0.0.1:9333/json/version');
  assert.equal(typeof result.version.browser, 'string');
});

test('fake unavailable daemon returns daemon-unavailable', async () => {
  const client = new FakeBrowserDaemonClient({ failWith: { code: 'daemon-unavailable' } });
  const result = await client.ensureHealthy({ now: FIXED_NOW });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'daemon-unavailable');
});

test('no fallback mode other than dedicated-daemon is accepted by default', async () => {
  const fake = new FakeBrowserDaemonClient();
  const fakeResult = await fake.ensureHealthy({ mode: 'manual-user-bridge', now: FIXED_NOW });
  assert.equal(fakeResult.ok, false);
  assert.equal(fakeResult.code, 'daemon-unhealthy');

  const chrome = new ChromeDaemonClient({ fetchImpl: async () => new Response('{}', { status: 200 }) });
  const chromeResult = await chrome.ensureHealthy({ mode: 'manual-user-bridge', now: FIXED_NOW });
  assert.equal(chromeResult.ok, false);
  assert.equal(chromeResult.code, 'daemon-unhealthy');
});

test('chrome daemon client parses a valid CDP version response', async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        Browser: 'Chrome/124.0.0.0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/raw-secret',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const client = new ChromeDaemonClient({ endpoint: 'http://127.0.0.1:9222', fetchImpl });
  const result = await client.ensureHealthy({ now: FIXED_NOW });

  assert.equal(result.ok, true);
  assert.equal(result.version.browser, 'Chrome/124.0.0.0');
  assert.equal(result.version.protocolVersion, '1.3');

  // public health result must not leak the raw debugger websocket URL
  assert.equal(JSON.stringify(result).includes('ws://'), false);
  assert.equal(JSON.stringify(result).includes('raw-secret'), false);
});

test('chrome daemon client reports daemon-response-invalid for a missing Browser field', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ 'Protocol-Version': '1.3' }), { status: 200 });
  const client = new ChromeDaemonClient({ fetchImpl });
  const result = await client.ensureHealthy({ now: FIXED_NOW });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'daemon-response-invalid');
});

test('chrome daemon client reports daemon-unavailable when the request throws', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const client = new ChromeDaemonClient({ fetchImpl });
  const result = await client.ensureHealthy({ now: FIXED_NOW });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'daemon-unavailable');
});

test('daemon ref helpers produce opaque ids without host paths or secrets', () => {
  const id = daemonIdFromEndpoint('http://127.0.0.1:9222');
  assert.match(id, /^daemon_local_/);

  const ref = buildDaemonRef('http://127.0.0.1:9222/');
  assert.equal(ref.healthUrlPreview, 'http://127.0.0.1:9222/json/version');
  assert.equal(ref.healthUrlPreview.includes('ws://'), false);
});

// Review finding #2: healthUrlPreview must be origin-only, never leaking
// userinfo/path/query from the endpoint.
test('healthUrlPreview strips userinfo, path, and query from the endpoint', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ Browser: 'Chrome/124.0.0.0' }), { status: 200 });
  const client = new ChromeDaemonClient({
    endpoint: 'http://user:s3cr3t@127.0.0.1:9222/devtools/path?token=raw-token',
    fetchImpl,
  });
  const result = await client.ensureHealthy({ now: FIXED_NOW });

  assert.equal(result.ok, false);
  // userinfo in the endpoint is rejected outright rather than silently dropped
  assert.equal(result.code, 'daemon-response-invalid');
  assert.equal(JSON.stringify(result).includes('s3cr3t'), false);
  assert.equal(JSON.stringify(result).includes('raw-token'), false);
});

test('healthUrlPreview from a clean endpoint with a path is reduced to origin', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ Browser: 'Chrome/124.0.0.0' }), { status: 200 });
  const client = new ChromeDaemonClient({ endpoint: 'http://127.0.0.1:9222/some/path?x=1', fetchImpl });
  const result = await client.ensureHealthy({ now: FIXED_NOW });

  assert.equal(result.ok, true);
  assert.equal(result.daemonRef.healthUrlPreview, 'http://127.0.0.1:9222/json/version');
  assert.equal(JSON.stringify(result).includes('x=1'), false);
});

// Review finding #5: startIfMissing must not be silently ignored.
test('startIfMissing is rejected with daemon-start-failed on both clients', async () => {
  const fake = new FakeBrowserDaemonClient();
  const fakeResult = await fake.ensureHealthy({ startIfMissing: true, now: FIXED_NOW });
  assert.equal(fakeResult.ok, false);
  assert.equal(fakeResult.code, 'daemon-start-failed');

  const chrome = new ChromeDaemonClient({ fetchImpl: async () => new Response('{}', { status: 200 }) });
  const chromeResult = await chrome.ensureHealthy({ startIfMissing: true, now: FIXED_NOW });
  assert.equal(chromeResult.ok, false);
  assert.equal(chromeResult.code, 'daemon-start-failed');
});

// Second-review finding #2: a local-chrome-daemon ref must point at loopback;
// a remote endpoint must not be accepted while claiming kind local-chrome-daemon.
test('remote (non-loopback) endpoint is rejected for local-chrome-daemon', async () => {
  let threw = false;
  try {
    buildDaemonRef('https://example.com:9443');
  } catch {
    threw = true;
  }
  assert.equal(threw, true);

  const fetchImpl = async () => new Response(JSON.stringify({ Browser: 'Chrome/124.0.0.0' }), { status: 200 });
  const client = new ChromeDaemonClient({ endpoint: 'https://example.com:9443', fetchImpl });
  const result = await client.ensureHealthy({ now: FIXED_NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'daemon-response-invalid');
  assert.match(result.message, /loopback/);
});

test('loopback variants (localhost, 127.x, ::1) are accepted', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ Browser: 'Chrome/124.0.0.0' }), { status: 200 });
  for (const endpoint of ['http://localhost:9222', 'http://127.0.0.5:9222', 'http://[::1]:9222']) {
    const client = new ChromeDaemonClient({ endpoint, fetchImpl });
    const result = await client.ensureHealthy({ now: FIXED_NOW });
    assert.equal(result.ok, true, `expected ${endpoint} to be accepted`);
  }
});
