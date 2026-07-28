'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BrowserNetworkCaptureSession } = require('../dist/browser');

function safeObs(id) {
  return {
    id,
    runId: 'run_1',
    pageTargetRef: 'page:t-1',
    source: 'cdp',
    capturedAt: '2026-01-01T00:00:00.000Z',
    request: { url: 'https://api.example.com/v1/users', method: 'GET', queryParamNames: ['page'] },
    response: { status: 200, mimeType: 'application/json' },
    timing: { startedAt: '2026-01-01T00:00:01.000Z', durationMs: 5 },
  };
}

function fakeSource(observations) {
  return { collect: async () => observations };
}

test('session captures, validates, lists safe observations', async () => {
  const session = new BrowserNetworkCaptureSession(fakeSource([safeObs('o1'), safeObs('o2')]));
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const result = await session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  assert.equal(result.observations.length, 2);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual((await session.listObservations('run_1')).map((o) => o.id), ['o1', 'o2']);
});

test('session excludes an unsafe observation with a value-free diagnostic', async () => {
  const unsafe = { ...safeObs('bad'), request: { url: 'http://127.0.0.1:9222/devtools/browser/RAWTARGET', method: 'GET' } };
  const session = new BrowserNetworkCaptureSession(fakeSource([safeObs('ok'), unsafe]));
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const result = await session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  assert.deepEqual(result.observations.map((o) => o.id), ['ok']);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'unsafe-observation-skipped');
  // the unsafe value never leaks into the result (observations or diagnostics)
  assert.equal(JSON.stringify(result).includes('RAWTARGET'), false);
});

test('session stop without a prior start rejects', async () => {
  const session = new BrowserNetworkCaptureSession(fakeSource([]));
  await assert.rejects(() => session.stop({ runId: 'run_x', pageTargetRef: 'page:t-1' }), /requires a prior start/);
});

test('session defaults to a not-implemented source (real transport is out of scope)', async () => {
  const session = new BrowserNetworkCaptureSession();
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  await assert.rejects(() => session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' }), /not implemented/);
});

// Codex re-review of PR #3 (#4): observations from another run/page in a mixed buffer must
// not be stored under THIS capture window (would corrupt the run's evidence).
test('session skips observations that do not match the active run/page window', async () => {
  const otherRun = { ...safeObs('other-run'), runId: 'run_OTHER' };
  const otherTarget = { ...safeObs('other-tgt'), pageTargetRef: 'page:OTHER' };
  const session = new BrowserNetworkCaptureSession(fakeSource([safeObs('ok'), otherRun, otherTarget]));
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const result = await session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  assert.deepEqual(result.observations.map((o) => o.id), ['ok']);
  assert.equal(result.diagnostics.filter((d) => d.code === 'observation-window-mismatch-skipped').length, 2);
});

// Codex re-review of PR #3 (#5): the field-by-field gate validates KNOWN keys only, so an
// extra source-controlled property (postData / rawRequestHeaders) survives unless stripped.
test('session stores only whitelisted observation fields (extra keys are dropped)', async () => {
  const withExtra = { ...safeObs('x1'), rawRequestHeaders: { authorization: 'Bearer LEAKEDTOKEN' }, postData: 'password=LEAKEDTOKEN' };
  withExtra.request = { ...withExtra.request, rawHeaders: { cookie: 'LEAKEDTOKEN' } };
  const session = new BrowserNetworkCaptureSession(fakeSource([withExtra]));
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const result = await session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const stored = result.observations[0];
  assert.equal('rawRequestHeaders' in stored, false);
  assert.equal('postData' in stored, false);
  assert.equal('rawHeaders' in stored.request, false);
  assert.equal(JSON.stringify(result).includes('LEAKEDTOKEN'), false);
  // the whitelisted fields survive
  assert.equal(stored.request.url, 'https://api.example.com/v1/users');
});

// Codex re-review of PR #3 (#6): a rejected observation is source-controlled, so its id and
// the assertion message (which can name a header) must NOT be echoed into diagnostics.
test('rejected-observation diagnostic echoes neither the source id nor the assertion message', async () => {
  const evil = { id: 'Bearer SUPERSECRETID', runId: 'run_1', pageTargetRef: 'page:t-1', source: 'cdp', capturedAt: '2026-01-01T00:00:00.000Z', request: { url: 'https://h/x', method: 'GET' } };
  const session = new BrowserNetworkCaptureSession(fakeSource([evil]));
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const result = await session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  assert.equal(result.observations.length, 0);
  assert.equal(result.diagnostics[0].code, 'unsafe-observation-skipped');
  assert.equal(result.diagnostics[0].observationId, undefined);
  assert.equal(JSON.stringify(result).includes('SUPERSECRETID'), false);
});

// Codex re-review of PR #3 (#5): a transient collect() failure must not make the capture
// unrecoverable -- the active window survives so stop() can be retried.
test('a failed collect leaves the capture window active for retry', async () => {
  let calls = 0;
  const flaky = {
    collect: async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient daemon error');
      return [safeObs('o1')];
    },
  };
  const session = new BrowserNetworkCaptureSession(flaky);
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  await assert.rejects(() => session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' }), /transient/);
  const result = await session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' }); // retry succeeds
  assert.deepEqual(result.observations.map((o) => o.id), ['o1']);
});

// Codex re-review of PR #3 (#6): a same-run observation MISSING pageTargetRef must not be
// stored under the active page window (it would contaminate this page's evidence).
test('session skips a same-run observation missing pageTargetRef', async () => {
  const noTarget = { ...safeObs('no-tgt') };
  delete noTarget.pageTargetRef;
  const session = new BrowserNetworkCaptureSession(fakeSource([safeObs('ok'), noTarget]));
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const result = await session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  assert.deepEqual(result.observations.map((o) => o.id), ['ok']);
  assert.equal(result.diagnostics.filter((d) => d.code === 'observation-window-mismatch-skipped').length, 1);
});

// Codex re-review of PR #3 (round 5): an allowlisted header NAME with a non-string JSON value
// passes the invariant (which string-tests values), so the session copy must keep only STRING
// preview values -- a nested object with a secret must never survive stop()/listObservations().
test('session stores only string header preview values (nested object dropped)', async () => {
  const withObjectHeader = {
    ...safeObs('h1'),
    response: { status: 200, headersPreview: { 'content-type': { raw: 'Bearer HEADERSECRET' } } },
  };
  const session = new BrowserNetworkCaptureSession(fakeSource([withObjectHeader]));
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const result = await session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  assert.equal(result.observations.length, 1);
  assert.equal(JSON.stringify(result).includes('HEADERSECRET'), false);
  assert.equal(JSON.stringify(await session.listObservations('run_1')).includes('HEADERSECRET'), false);
});

// Codex re-review of PR #3 (round 6): the mapper-side method/MIME hardening only protected
// EVIDENCE; the session path returned the raw values through stop()/listObservations().
test('session gate skips a free-form method observation (never stored or returned)', async () => {
  const badMethod = { ...safeObs('m1'), request: { url: 'https://api.example.com/x', method: 'Bearer sk-live-METHODSECRET' } };
  const session = new BrowserNetworkCaptureSession(fakeSource([safeObs('ok'), badMethod]));
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const result = await session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  assert.equal(result.observations.length, 1);
  assert.equal(result.diagnostics[0].code, 'unsafe-observation-skipped');
  assert.equal(JSON.stringify(result).includes('METHODSECRET'), false);
  assert.equal(JSON.stringify(await session.listObservations('run_1')).includes('METHODSECRET'), false);
});

test('session strips MIME parameters before storing an observation', async () => {
  const paramMime = { ...safeObs('p1'), response: { status: 200, mimeType: 'application/json; boundary=sk-live-MIMESECRET' } };
  const session = new BrowserNetworkCaptureSession(fakeSource([paramMime]));
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const result = await session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  assert.equal(result.observations[0].response.mimeType, 'application/json');
  assert.equal(JSON.stringify(result).includes('MIMESECRET'), false);
  assert.equal(JSON.stringify(await session.listObservations('run_1')).includes('MIMESECRET'), false);
});

// Codex re-review of PR #5 round 1 (H3): start() must signal the source to begin/reset the
// capture window, so a re-start at a later boundary (post-auth-recheck) discards earlier traffic.
test('start() calls source.beginCapture to reset the window', async () => {
  const begins = [];
  const source = { beginCapture: (input) => { begins.push(input.pageTargetRef); }, collect: async () => [] };
  const session = new BrowserNetworkCaptureSession(source);
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' }); // re-start resets again
  assert.deepEqual(begins, ['page:t-1', 'page:t-1']);
  // a source without beginCapture (a fixture) still works
  const plain = new BrowserNetworkCaptureSession({ collect: async () => [] });
  await plain.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const r = await plain.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  assert.equal(r.observations.length, 0);
});

// Codex re-review of PR #5 round 3 (J4): a RE-start of an already-active window whose second
// beginCapture rejects must NOT leave the old key active -- else a later stop() collects the
// old pre-boundary buffer.
test('a failed re-start invalidates the previously active window', async () => {
  let call = 0;
  const source = {
    beginCapture: async () => { call += 1; if (call === 2) throw new Error('reset failed'); },
    collect: async () => [{ id: 'stale', runId: 'run_1', pageTargetRef: 'page:t-1', source: 'cdp', capturedAt: '2026-01-01T00:00:00.000Z', request: { url: 'https://h/x', method: 'GET' } }],
  };
  const session = new BrowserNetworkCaptureSession(source);
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' }); // first start succeeds (window active)
  await assert.rejects(() => session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' }), /reset failed/); // re-start reset fails
  // the window must no longer be active -> stop() rejects rather than collecting the stale buffer
  await assert.rejects(() => session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' }), /requires a prior start/);
});

// Codex re-review of PR #5 round 4 (K4): abort() closes an opened window WITHOUT collecting,
// tells the source to discard its buffer, and makes a later stop() invalid.
test('abort() discards the window without collecting', async () => {
  const calls = [];
  const source = {
    beginCapture: () => calls.push('begin'),
    abortCapture: () => calls.push('abort'),
    collect: async () => { calls.push('collect'); return []; },
  };
  const session = new BrowserNetworkCaptureSession(source);
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  await session.abort({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  assert.deepEqual(calls, ['begin', 'abort']); // never collected
  await assert.rejects(() => session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' }), /requires a prior start/);
  assert.deepEqual(await session.listObservations('run_1'), []);
  // aborting an unopened window is a harmless no-op (no source call)
  await session.abort({ runId: 'run_1', pageTargetRef: 'page:never' });
  assert.deepEqual(calls, ['begin', 'abort']);
});
