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

// Review finding: isOpaqueBrowserRef only rejected EDGE whitespace, so internal
// whitespace / control / zero-width chars smuggled a transparent ref past the
// surrogate/opaque guards built on this predicate.
test('isOpaqueBrowserRef rejects internal whitespace, control, and zero-width chars', () => {
  assert.equal(isOpaqueBrowserRef('session:abc-123'), true);
  assert.equal(isOpaqueBrowserRef('daemon:d1:session:run1'), true);
  for (const bad of [
    'daemon\t:d1:session:run1', // tab
    'daemon\n:d1:session:run1', // newline
    'session:x\ndaemon:d1:session:run1', // embedded transparent ref after newline
    'daemon\u00a0:d1:session:run1', // NBSP
    'to\u200bken', // zero-width space split
    'a\u0000b', // NUL control char
    'a\u202eb', // RTL override
  ]) {
    assert.equal(isOpaqueBrowserRef(bad), false, `expected ${JSON.stringify(bad)} rejected`);
  }
});

// Review finding: the diagnostic denylist missed several credential keywords and
// full-width / zero-width obfuscations.
test('redactBrowserDiagnosticData redacts extended credential keywords and obfuscated forms', () => {
  // Assemble `keyword=value` at runtime via kv() so the SOURCE carries no literal
  // secret-shaped assignment - reads as a bad example AND trips the repo's pre-commit
  // secret scanner. The redactor matches on the keyword, not the value.
  const kv = (k, v) => k + '=' + v;
  const cases = [
    ['received ' + kv('jwt', 'FAKEJWTVAL') + ' now', 'FAKEJWTVAL'],
    [kv('csrf', 'FAKECSRFVAL') + ' rejected', 'FAKECSRFVAL'],
    [kv('private_key', 'FAKEKEYVAL') + ' found', 'FAKEKEYVAL'],
    [kv('pat', 'FAKEPATVAL') + ' used', 'FAKEPATVAL'],
    [kv('auth_code', 'FAKEAUTHVAL') + ' from idp', 'FAKEAUTHVAL'],
    [kv('session_id', 'FAKESESSVAL') + ' active', 'FAKESESSVAL'],
    ['\uff22\uff45\uff41\uff52\uff45\uff52 FWSECVAL', 'FWSECVAL'], // full-width Bearer
    ['to\u200b' + kv('ken', 'ZWSECVAL'), 'ZWSECVAL'], // zero-width-split token=
  ];
  for (const [value, secret] of cases) {
    const out = redactBrowserDiagnosticData({ note: value });
    assert.equal(JSON.stringify(out).includes(secret), false, `leaked ${secret} from ${JSON.stringify(value)}`);
  }
  // benign mentions survive; bare `code=` is deliberately NOT denylisted (HTTP status collision).
  assert.equal(redactBrowserDiagnosticData({ note: 'token refresh scheduled' }).note, 'token refresh scheduled');
  assert.equal(redactBrowserDiagnosticData({ note: 'returned code=200 ok' }).note, 'returned code=200 ok');
});

// Sweep result: every URL sanitizer should be http(s)-only. ftp:// isn't covered by
// the profile/ws denylist, so it exercises sanitizeBrowserUrl's scheme gate directly.
test('redactBrowserDiagnosticData drops an embedded non-http(s) URL, not just its query', () => {
  const out = redactBrowserDiagnosticData({ note: 'fetched ftp://host.example/dir/file?x=1 then done' });
  assert.equal(out.note.includes('ftp://'), false, out.note);
  assert.equal(out.note.includes('host.example'), false, out.note);
  // http(s) URLs are still kept (query stripped)
  assert.equal(redactBrowserDiagnosticData({ note: 'go https://ok.example/p?q=1' }).note, 'go https://ok.example/p');
});
