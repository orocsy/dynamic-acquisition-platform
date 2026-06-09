'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BrowserNetworkCaptureSession } = require('../dist/browser');

function safeObs(id) {
  return {
    id,
    runId: 'run_1',
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
  const evil = { id: 'Bearer SUPERSECRETID', runId: 'run_1', source: 'cdp', capturedAt: '2026-01-01T00:00:00.000Z', request: { url: 'https://h/x', method: 'GET' } };
  const session = new BrowserNetworkCaptureSession(fakeSource([evil]));
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  const result = await session.stop({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  assert.equal(result.observations.length, 0);
  assert.equal(result.diagnostics[0].code, 'unsafe-observation-skipped');
  assert.equal(result.diagnostics[0].observationId, undefined);
  assert.equal(JSON.stringify(result).includes('SUPERSECRETID'), false);
});
