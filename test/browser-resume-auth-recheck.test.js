'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FakeBrowserAuthRechecker,
  DetectorBackedAuthRechecker,
  NotImplementedAuthStateProbe,
  authRecheckFailure,
  isBrowserAuthRecheckFailureCode,
  browserAuthRecheckMessage,
} = require('../dist/browser');

// ---- abuse cases first ----

test('rechecker rejects a transparent/unsafe browserSessionRef without echoing it', async () => {
  const rechecker = new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] });
  for (const ref of ['daemon:d1:session:run_XYZREF', 'ws://127.0.0.1:9222/devtools/browser/XYZREF', 'session:access_token_XYZREF']) {
    await assert.rejects(
      () => rechecker.recheck({ runId: 'r', browserSessionRef: ref, pageTargetRef: 'page:t-1' }),
      (err) => { assert.equal(String(err.message).includes('XYZREF'), false); return true; },
      ref,
    );
  }
});

test('rechecker rejects a non-page-shaped pageTargetRef', async () => {
  const rechecker = new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] });
  for (const bad of ['ws://127.0.0.1:9222/devtools/browser/RAW', 'daemon:d:session:r', 'not-a-page-ref'])
    await assert.rejects(() => rechecker.recheck({ runId: 'r', browserSessionRef: 'session:ok-1', pageTargetRef: bad }), /page target ref/, bad);
});

test('a fixed failure result carries only a per-code message, never source text', () => {
  const f = authRecheckFailure('still-unauthorized');
  assert.equal(f.ok, false);
  assert.equal(f.code, 'still-unauthorized');
  assert.equal(f.message, browserAuthRecheckMessage('still-unauthorized'));
  assert.equal(isBrowserAuthRecheckFailureCode('still-unauthorized'), true);
  assert.equal(isBrowserAuthRecheckFailureCode('__proto__'), false); // prototype key not a code
  assert.equal(isBrowserAuthRecheckFailureCode('sk-live-x'), false);
});

// ---- FakeBrowserAuthRechecker ----

test('fake rechecker returns the injected outcome (fixed or planner)', async () => {
  const okr = new FakeBrowserAuthRechecker({ ok: true, confidence: 0.5, diagnostics: [] });
  assert.deepEqual(await okr.recheck({ runId: 'r', browserSessionRef: 'session:a' }), { ok: true, confidence: 0.5, diagnostics: [] });
  const planned = new FakeBrowserAuthRechecker((input) => (input.targetUrl === 'https://blocked' ? authRecheckFailure('still-unauthorized') : { ok: true, confidence: 1, diagnostics: [] }));
  assert.equal((await planned.recheck({ runId: 'r', browserSessionRef: 'session:a', targetUrl: 'https://blocked' })).ok, false);
  assert.equal((await planned.recheck({ runId: 'r', browserSessionRef: 'session:a', targetUrl: 'https://ok' })).ok, true);
});

// ---- DetectorBackedAuthRechecker (reuses the 3.5 detector as the auth-signal oracle) ----

function probeOf(observed) {
  return { probe: async () => observed };
}

test('detector-backed recheck: a persisting auth boundary -> still-unauthorized (value-free)', async () => {
  const rechecker = new DetectorBackedAuthRechecker(
    probeOf({ navigation: { ok: false, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], status: 401, finalUrlPreview: 'https://idp/login?code=SECRET' } }),
  );
  const result = await rechecker.recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'still-unauthorized');
  assert.equal(result.diagnostics[0].boundaryKind, 'login-required');
  assert.equal(JSON.stringify(result).includes('SECRET'), false); // no page/url fragment
});

test('detector-backed recheck: no auth boundary -> ok', async () => {
  const rechecker = new DetectorBackedAuthRechecker(
    probeOf({ navigation: { ok: true, pageTargetRef: 'page:t-1', state: 'ready', diagnostics: [], status: 200, finalUrlPreview: 'https://app.example.com/dashboard' }, pageTextPreview: 'Welcome back to your dashboard' }),
  );
  const result = await rechecker.recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(result.ok, true);
  assert.equal(result.pageTargetRef, 'page:t-1');
});

test('detector-backed recheck: a probe transport failure fails safe (session-stale), not ok', async () => {
  const rechecker = new DetectorBackedAuthRechecker({ probe: async () => { throw new Error('daemon gone'); } });
  const result = await rechecker.recheck({ runId: 'r', browserSessionRef: 'session:a', pageTargetRef: 'page:t-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session-stale');
  assert.equal(result.diagnostics[0].code, 'auth-recheck-probe-failed');
});

test('the default detector-backed probe is not implemented (real transport deferred)', async () => {
  const rechecker = new DetectorBackedAuthRechecker(new NotImplementedAuthStateProbe());
  // the NotImplemented probe throws -> mapped to a safe session-stale failure
  const result = await rechecker.recheck({ runId: 'r', browserSessionRef: 'session:a' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session-stale');
});
