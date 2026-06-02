'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toPersistableSessionRecord,
  guardOpaqueRef,
  guardPageTargetRef,
  guardRefPart,
  guardSurrogateSessionId,
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
