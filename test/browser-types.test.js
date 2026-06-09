'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const browser = require('../dist/browser');

test('exports Phase 3.1 browser contracts and helpers', () => {
  assert.equal(typeof browser.createBrowserSessionRef, 'function');
  assert.equal(typeof browser.isOpaqueBrowserRef, 'function');
  assert.equal(typeof browser.redactBrowserDiagnosticData, 'function');
  assert.equal(typeof browser.assertSafeBrowserObservation, 'function');
});

test('creates browser daemon, session, and observation fixtures without launching Chrome', () => {
  const daemonRef = {
    id: 'daemon_local_chrome_001',
    kind: 'local-chrome-daemon',
    mode: 'dedicated-daemon',
    healthUrlPreview: 'http://127.0.0.1:9222/json/version',
  };
  const browserSessionRef = browser.createBrowserSessionRef({
    daemonId: daemonRef.id,
    runId: 'run_browser_001',
  });
  const observation = {
    id: 'observation_browser_001',
    runId: 'run_browser_001',
    source: 'daemon-fixture',
    capturedAt: '2026-05-24T00:00:00.000Z',
    pageTargetRef: 'page:target-001',
    request: {
      url: 'https://example.com/account',
      method: 'GET',
      headersPreview: { accept: 'application/json', authorization: '[redacted]' },
      resourceType: 'xhr',
      bodyShape: 'unknown',
    },
    response: {
      status: 200,
      mimeType: 'application/json',
      headersPreview: { 'content-type': 'application/json', 'set-cookie': '[redacted]' },
      bodyShape: 'json-object',
    },
    timing: {
      startedAt: '2026-05-24T00:00:00.000Z',
      durationMs: 42,
    },
  };

  browser.assertSafeBrowserObservation(observation);

  assert.equal(daemonRef.kind, 'local-chrome-daemon');
  assert.equal(browserSessionRef, 'daemon:daemon_local_chrome_001:session:run_browser_001');
  assert.equal(JSON.stringify({ daemonRef, browserSessionRef, observation }).includes('ws://'), false);
});

test('runtime package remains browser-free at the source boundary', () => {
  const runtimeDir = path.join(__dirname, '..', 'src', 'runtime');
  const runtimeFiles = fs.readdirSync(runtimeDir).filter((file) => file.endsWith('.ts'));
  const importsBrowser = runtimeFiles.some((file) => {
    const source = fs.readFileSync(path.join(runtimeDir, file), 'utf8');
    return /from ['"]\.\.\/browser|require\(['"]\.\.\/browser/.test(source);
  });

  assert.equal(importsBrowser, false);
});
