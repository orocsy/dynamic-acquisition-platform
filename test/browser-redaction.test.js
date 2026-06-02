'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertSafeBrowserObservation,
  containsUnsafeBrowserData,
  createBrowserSessionRef,
  isOpaqueBrowserRef,
  redactBrowserDiagnosticData,
} = require('../dist/browser');

test('browser redaction masks query values and credential-like fields recursively', () => {
  const rawCookie = 'sid=raw-cookie';
  const rawAuthorization = 'Bearer raw-auth';
  const rawProfilePath = '~/Library/Application Support/Google/Chrome/Profile 1';
  const rawAbsoluteProfilePath = '/Users/sean/Library/Application Support/Google/Chrome/Profile 1';
  const redacted = redactBrowserDiagnosticData({
    url: 'https://example.com/account?token=secret&code=123#frag',
    nested: {
      cookie: rawCookie,
      authorization: rawAuthorization,
      setCookie: 'session=raw-set-cookie',
      profilePath: rawProfilePath,
      absoluteProfilePath: rawAbsoluteProfilePath,
      headersPreview: {
        accept: 'application/json',
        cookie: rawCookie,
      },
      urls: ['https://example.com/api?secret=value', '/api/resource?signature=secret'],
    },
  });

  assert.equal(redacted.url, 'https://example.com/account');
  assert.equal(redacted.nested.cookie, '[redacted]');
  assert.equal(redacted.nested.authorization, '[redacted]');
  assert.equal(redacted.nested.setCookie, '[redacted]');
  assert.equal(redacted.nested.profilePath, '[redacted]');
  assert.equal(redacted.nested.absoluteProfilePath, '[redacted]');
  assert.equal(redacted.nested.headersPreview.cookie, '[redacted]');
  assert.deepEqual(redacted.nested.urls, ['https://example.com/api', '/api/resource']);
  assert.equal(
    containsUnsafeBrowserData(redacted, [rawCookie, rawAuthorization, rawProfilePath, rawAbsoluteProfilePath, 'secret', 'raw-set-cookie']),
    false,
  );
});

test('browser ref helpers reject profile-like refs and preserve opaque refs', () => {
  const sessionRef = createBrowserSessionRef({ daemonId: 'daemon_local_001', runId: 'run_browser_001' });

  assert.equal(sessionRef, 'daemon:daemon_local_001:session:run_browser_001');
  assert.equal(isOpaqueBrowserRef(sessionRef), true);
  assert.equal(isOpaqueBrowserRef('page_target_001'), true);
  assert.equal(isOpaqueBrowserRef('~/Library/Application Support/Google/Chrome/Profile 1'), false);
  assert.equal(isOpaqueBrowserRef('ws://127.0.0.1:9222/devtools/browser/raw'), false);
  assert.throws(
    () => createBrowserSessionRef({ daemonId: 'daemon_local_001', runId: 'run_001?cookie=secret' }),
    /opaque browser ref part/,
  );

  const redacted = redactBrowserDiagnosticData({
    browserSessionRef: sessionRef,
    pageTargetRef: 'page_target_001',
    unsafeBrowserSessionRef: '~/Library/Application Support/Google/Chrome/Profile 1',
  });
  assert.equal(redacted.browserSessionRef, sessionRef);
  assert.equal(redacted.pageTargetRef, 'page_target_001');
  assert.equal(redacted.unsafeBrowserSessionRef, '[redacted]');
});

test('browser observation validation rejects unredacted sensitive header previews', () => {
  assert.throws(
    () => assertSafeBrowserObservation({
      id: 'observation_bad_header',
      runId: 'run_browser_001',
      source: 'daemon-fixture',
      capturedAt: '2026-05-24T00:00:00.000Z',
      request: {
        url: 'https://example.com/account',
        method: 'GET',
        headersPreview: { authorization: 'Bearer raw-auth' },
      },
    }),
    /must be redacted/,
  );

  assert.doesNotThrow(() => assertSafeBrowserObservation({
    id: 'observation_safe_header',
    runId: 'run_browser_001',
    source: 'daemon-fixture',
    capturedAt: '2026-05-24T00:00:00.000Z',
    request: {
      url: 'https://example.com/account',
      method: 'GET',
      headersPreview: { authorization: '[redacted]' },
    },
  }));

  assert.throws(
    () => assertSafeBrowserObservation({
      id: 'observation_bad_timing',
      runId: 'run_browser_001',
      source: 'daemon-fixture',
      capturedAt: '2026-05-24T00:00:00.000Z',
      timing: { durationMs: Number.NaN },
    }),
    /non-finite number/,
  );
});
