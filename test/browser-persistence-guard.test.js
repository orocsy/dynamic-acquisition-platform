'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toPersistableSessionRecord,
  guardOpaqueRef,
  guardPageTargetRef,
  guardRefPart,
  guardSurrogateSessionId,
  guardTransparentRef,
  sanitizeUrlPreview,
  BrowserPersistenceError,
} = require('../dist/browser');

const BASE = {
  sessionId: 'session:uuid-1',
  daemonId: 'daemon_local_001',
  runId: 'run_browser_001',
  transparentRef: 'daemon:daemon_local_001:session:run_browser_001',
  mode: 'dedicated-daemon',
};

test('toPersistableSessionRecord passes a clean record through and sanitizes the preview', () => {
  const safe = toPersistableSessionRecord({
    ...BASE,
    pageTargetRef: 'page:target-001',
    targetUrlPreview: 'https://u:p@example.com/account?token=RAWSECRET#f',
  });
  assert.equal(safe.sessionId, 'session:uuid-1');
  assert.equal(safe.pageTargetRef, 'page:target-001');
  assert.equal(safe.targetUrlPreview, 'https://example.com/account');
  assert.equal(JSON.stringify(safe).includes('RAWSECRET'), false);
});

test('toPersistableSessionRecord rejects every unsafe field class', () => {
  // surrogate sessionId must not be the transparent form
  assert.throws(
    () => toPersistableSessionRecord({ ...BASE, sessionId: 'daemon:d:session:r' }),
    BrowserPersistenceError,
  );
  // ref parts must be colon/whitespace-free
  assert.throws(() => toPersistableSessionRecord({ ...BASE, daemonId: 'a:b' }), BrowserPersistenceError);
  assert.throws(() => toPersistableSessionRecord({ ...BASE, runId: 'run id' }), BrowserPersistenceError);
  // page target ref must be opaque (no ws/devtools/profile)
  assert.throws(
    () => toPersistableSessionRecord({ ...BASE, pageTargetRef: 'ws://127.0.0.1:9222/devtools/page/RAW' }),
    BrowserPersistenceError,
  );
});

test('guard helpers are individually exported and typed', () => {
  assert.equal(guardSurrogateSessionId('sessionId', 'session:ok'), 'session:ok');
  assert.equal(guardOpaqueRef('pageTargetRef', undefined), undefined);
  assert.equal(guardRefPart('daemonId', 'daemon_local_1'), 'daemon_local_1');
  assert.equal(sanitizeUrlPreview('https://x.com/p?secret=1'), 'https://x.com/p');
});

test('BrowserPersistenceError names the rejected field', () => {
  try {
    guardOpaqueRef('pageTargetRef', 'ws://x/devtools/page/raw');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof BrowserPersistenceError);
    assert.equal(err.field, 'pageTargetRef');
  }
});

// Finding #3: a persisted pageTargetRef must have the page:<id> shape, not merely
// be "opaque". The 3.2 guard only checked opacity, so a transparent session ref,
// a session surrogate, or an arbitrary token slipped through as a page target ref.
test('guardPageTargetRef requires the page:<id> shape, not merely opacity', () => {
  assert.equal(guardPageTargetRef('pageTargetRef', 'page:abc-123'), 'page:abc-123');
  assert.equal(guardPageTargetRef('pageTargetRef', undefined), undefined);
  for (const bad of [
    'daemon:daemon_local_1:session:run_1', // transparent (linkable) session ref
    'session:uuid-1', // session surrogate
    'not-a-page-ref', // arbitrary opaque token
    'ws://127.0.0.1:9222/devtools/page/RAW', // raw debugger URL
    '/Users/sean/Library/Application Support/Google/Chrome/Profile 1', // profile path
  ]) {
    assert.throws(() => guardPageTargetRef('pageTargetRef', bad), BrowserPersistenceError, `expected "${bad}" rejected`);
  }
});

test('toPersistableSessionRecord rejects a non-page pageTargetRef', () => {
  for (const bad of ['daemon:d:session:r', 'session:uuid-1', 'not-a-page-ref']) {
    assert.throws(
      () => toPersistableSessionRecord({ ...BASE, pageTargetRef: bad }),
      BrowserPersistenceError,
      `expected pageTargetRef "${bad}" rejected`,
    );
  }
});

// Round-6 #2: guards must reject whitespace-padded refs rather than validate the
// trimmed value and persist the untrimmed one (a stored ref you can't look up).
test('guards reject whitespace-padded refs (validate == persist)', () => {
  assert.throws(() => guardPageTargetRef('pageTargetRef', ' page:x '), BrowserPersistenceError);
  assert.throws(() => guardSurrogateSessionId('sessionId', ' session:x '), BrowserPersistenceError);
  assert.throws(() => toPersistableSessionRecord({ ...BASE, pageTargetRef: ' page:x ' }), BrowserPersistenceError);
  // canonical forms still pass through unchanged
  assert.equal(guardPageTargetRef('pageTargetRef', 'page:x'), 'page:x');
  assert.equal(guardSurrogateSessionId('sessionId', 'session:x'), 'session:x');
});

// The transparent-ref fallback must not let a raw ws://devtools URL ride between
// the daemon:/:session: delimiters and get persisted (the `[^\s]+` swallow hole).
test('guardTransparentRef rejects a ws:// URL smuggled into a transparent ref', () => {
  const evil = 'daemon:ws://127.0.0.1:9222/devtools/browser/RAW:session:run_1';
  assert.throws(() => guardTransparentRef('transparentRef', evil), BrowserPersistenceError);
  assert.throws(() => toPersistableSessionRecord({ ...BASE, transparentRef: evil }), BrowserPersistenceError);
  // a keyword-bearing segment is rejected too
  assert.throws(() => guardTransparentRef('transparentRef', 'daemon:cookie:session:run'), BrowserPersistenceError);
  // a clean transparent ref still passes
  assert.equal(
    guardTransparentRef('transparentRef', 'daemon:daemon_local_1:session:run_1'),
    'daemon:daemon_local_1:session:run_1',
  );
});

// The `daemon:` namespace must ALWAYS validate as the transparent form. The
// isOpaqueBrowserRef early-return allowed colons, so colon-smuggled parts and
// extra tail segments bypassed validation entirely.
test('guardTransparentRef rejects colon-smuggled / extra-segment transparent refs', () => {
  for (const bad of [
    'daemon:a:b:session:run', // daemonId "a:b" carries a colon
    'daemon:daemon_local_1:session:run_1:extra', // extra tail segment
    'daemon:a:session:b:session:c', // doubled session segment
    'daemon:foo', // daemon: prefix but not the transparent form
    'daemon::session:run', // empty daemonId
    'daemon:d:session:', // empty runId
  ]) {
    assert.throws(() => guardTransparentRef('transparentRef', bad), BrowserPersistenceError, `expected "${bad}" rejected`);
    assert.throws(
      () => toPersistableSessionRecord({ ...BASE, transparentRef: bad }),
      BrowserPersistenceError,
      `expected persist of "${bad}" rejected`,
    );
  }
  // a clean single-token daemonId is still accepted
  assert.equal(guardTransparentRef('transparentRef', 'daemon:ws:session:run_1'), 'daemon:ws:session:run_1');
});

// A non-web scheme is a raw endpoint/path, not a page preview — drop it rather
// than persist it with only the query stripped.
test('sanitizeUrlPreview drops non-http(s) schemes and never persists them', () => {
  assert.equal(sanitizeUrlPreview('ws://127.0.0.1:9222/devtools/browser/RAW'), undefined);
  assert.equal(sanitizeUrlPreview('wss://127.0.0.1:9222/devtools/page/ABC?token=SECRET'), undefined);
  assert.equal(sanitizeUrlPreview('chrome://version'), undefined);
  assert.equal(sanitizeUrlPreview('devtools://devtools/page/RAW'), undefined);
  // http(s) previews are kept (query/fragment/userinfo stripped)
  assert.equal(sanitizeUrlPreview('https://u:p@example.com/a?token=SECRET#f'), 'https://example.com/a');
  // ...and a ws:// targetUrlPreview is dropped on persist, not stored
  const rec = toPersistableSessionRecord({ ...BASE, targetUrlPreview: 'ws://127.0.0.1:9222/devtools/browser/RAW' });
  assert.equal(rec.targetUrlPreview, undefined);
});

// Review finding: a surrogate sessionId could smuggle a transparent ref past the
// anti-linkability check using INTERNAL whitespace/zero-width chars (the start-
// anchored daemon: check + edge-only trim let it through). Now rejected at the root.
test('guardSurrogateSessionId rejects whitespace / zero-width-smuggled surrogates', () => {
  for (const bad of [
    'daemon\t:d1:session:run1',
    'session:x\ndaemon:d1:session:run1',
    'sess\u200bion:abc',
    'session\u00a0abc',
  ]) {
    assert.throws(
      () => guardSurrogateSessionId('sessionId', bad),
      BrowserPersistenceError,
      `expected ${JSON.stringify(bad)} rejected`,
    );
  }
  assert.equal(guardSurrogateSessionId('sessionId', 'session:clean-1'), 'session:clean-1');
});

// Codex review: a scheme-relative URL (`//user:pass@host/...`) makes new URL throw,
// so the fallback kept the userinfo. Must strip it.
test('sanitizeUrlPreview strips userinfo from a scheme-relative URL', () => {
  const out = sanitizeUrlPreview('//x:y@example.com/account?q=1');
  assert.equal(out, '//example.com/account');
  assert.equal(out.includes('x:y'), false);
  const rec = toPersistableSessionRecord({ ...BASE, targetUrlPreview: '//x:y@example.com/account?q=1' });
  assert.equal(rec.targetUrlPreview, '//example.com/account');
  assert.equal(JSON.stringify(rec).includes('x:y'), false);
});
