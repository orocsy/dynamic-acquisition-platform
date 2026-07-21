'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { requestHumanInterventionFromBrowser, buildHumanInstructions } = require('../dist/browser');
const {
  InMemoryCheckpointStore,
  InMemoryInterventionStore,
  RuntimeCoordinator,
  hashResumeToken,
  previewResumeToken,
} = require('../dist/runtime');

const FIXED_NOW = '2026-07-15T00:00:00.000Z';
const FIXED_TOKEN = 'rt_bridge_secret_token_ONCE_ONLY_0001';

function makeCoordinator() {
  const checkpointStore = new InMemoryCheckpointStore();
  const interventionStore = new InMemoryInterventionStore();
  const counters = { event: 0, intervention: 0 };
  return {
    checkpointStore,
    interventionStore,
    coordinator: new RuntimeCoordinator({
      checkpointStore,
      interventionStore,
      clock: () => FIXED_NOW,
      idFactory: (kind) => `${kind}_${String(++counters[kind]).padStart(3, '0')}`,
      resumeTokenIssuer: () => ({
        resumeToken: FIXED_TOKEN,
        resumeTokenHash: hashResumeToken(FIXED_TOKEN),
        resumeTokenPreview: previewResumeToken(FIXED_TOKEN),
      }),
    }),
  };
}

async function runningRun(coordinator, runId = 'run_bridge_001') {
  await coordinator.createRun({ runId, intentSnapshot: { target: { kind: 'url', value: 'https://example.com/account' } } });
  await coordinator.markRunning({ runId, expectedVersion: 1, phase: 'auth_boundary_detected' });
  return runId;
}

function loginSignal(over = {}) {
  return {
    kind: 'login-required',
    confidence: 0.9,
    source: 'navigation',
    reason: 'navigation-unauthorized-status',
    urlPreview: 'https://idp.example.com/login',
    ...over,
  };
}

// ---- abuse cases first ----

test('bridge rejects a transparent or unsafe browserSessionRef without echoing it', async () => {
  const { coordinator } = makeCoordinator();
  for (const ref of ['daemon:d1:session:run_XYZREF', 'ws://127.0.0.1:9222/devtools/browser/XYZREF', 'session:access_token_XYZREF']) {
    await assert.rejects(
      () =>
        requestHumanInterventionFromBrowser(
          { coordinator },
          { runId: 'run_x', expectedVersion: 2, signal: loginSignal(), browserSessionRef: ref },
        ),
      (err) => {
        assert.equal(String(err.message).includes('XYZREF'), false, 'ref must not be echoed');
        return true;
      },
      ref,
    );
  }
});

test('bridge drops an unknown detector reason and sanitizes the url before persisting', async () => {
  const captured = [];
  const coordinator = {
    requestHumanIntervention: async (input) => {
      captured.push(input);
      return { checkpoint: { runId: input.runId }, request: { id: 'intervention_001' }, resumeToken: 'tok' };
    },
  };
  await requestHumanInterventionFromBrowser(
    { coordinator },
    {
      runId: 'run_x',
      expectedVersion: 2,
      signal: loginSignal({ reason: 'sk-live-SECRETREASON', urlPreview: 'https://idp.example.com/cb?code=SECRETCODE' }),
      browserSessionRef: 'session:abc-123',
    },
  );
  const sent = captured[0];
  assert.equal(sent.reason, 'Browser auth boundary (login-required)'); // unknown reason dropped, not sanitized
  assert.equal(sent.url, 'https://idp.example.com/cb'); // query stripped
  assert.equal(JSON.stringify(sent).includes('SECRET'), false);
});

test('bridge rejects an unknown signal kind without echoing it', async () => {
  const { coordinator } = makeCoordinator();
  await assert.rejects(
    () =>
      requestHumanInterventionFromBrowser(
        { coordinator },
        { runId: 'run_x', expectedVersion: 2, signal: loginSignal({ kind: 'give-me-your-sk-live-KEY' }), browserSessionRef: 'session:abc-123' },
      ),
    (err) => {
      assert.equal(String(err.message).includes('sk-live'), false);
      return true;
    },
  );
});

// ---- coordinator-backed behavior (LLD §8.7) ----

test('bridge creates waiting_for_human through the real coordinator and returns the token once', async () => {
  const { coordinator, checkpointStore, interventionStore } = makeCoordinator();
  const runId = await runningRun(coordinator);
  const result = await requestHumanInterventionFromBrowser(
    { coordinator },
    {
      runId,
      expectedVersion: 2,
      signal: loginSignal({ reason: 'navigation-unauthorized-status' }),
      browserSessionRef: 'session:abc-123',
      now: FIXED_NOW,
    },
  );

  assert.equal(result.checkpoint.status, 'waiting_for_human');
  assert.equal(result.checkpoint.phase, 'waiting_for_human');
  assert.equal(result.checkpoint.browserSessionRef, 'session:abc-123');
  assert.equal(result.resumeToken, FIXED_TOKEN); // returned ONCE, here only
  assert.equal(result.request.kind, 'login-required');
  assert.equal(result.checkpoint.nextStepId, 'auth_state_recheck'); // C3: the runtime's fixed resume-entry step
  assert.ok(result.request.reason.includes('navigation-unauthorized-status')); // known reason forwarded
  assert.deepEqual([...result.request.instructions], buildHumanInstructions('login-required'));

  // the raw token exists NOWHERE in persisted state (hash + preview only)
  const persisted = JSON.stringify({
    checkpoint: await checkpointStore.get(runId),
    request: await interventionStore.get('intervention_001'),
  });
  assert.equal(persisted.includes(FIXED_TOKEN), false);
});

test('bridge marks the page target stale after recording, and a markStale failure never loses the token', async () => {
  const { coordinator } = makeCoordinator();
  const runId = await runningRun(coordinator, 'run_bridge_002');
  const staleCalls = [];
  const result = await requestHumanInterventionFromBrowser(
    { coordinator, pageTargets: { markStale: async (ref, reason) => { staleCalls.push([ref, reason]); return {}; } } },
    { runId, expectedVersion: 2, signal: loginSignal(), browserSessionRef: 'session:abc-123', pageTargetRef: 'page:t-1' },
  );
  assert.deepEqual(staleCalls, [['page:t-1', 'auth-boundary-intervention']]);
  assert.equal(result.resumeToken, FIXED_TOKEN);

  const { coordinator: c2 } = makeCoordinator();
  const runId2 = await runningRun(c2, 'run_bridge_003');
  const result2 = await requestHumanInterventionFromBrowser(
    { coordinator: c2, pageTargets: { markStale: async () => { throw new Error('target gone'); } } },
    { runId: runId2, expectedVersion: 2, signal: loginSignal(), browserSessionRef: 'session:abc-123', pageTargetRef: 'page:t-1' },
  );
  assert.equal(result2.resumeToken, FIXED_TOKEN); // still returned despite the stale failure
  assert.equal(result2.checkpoint.status, 'waiting_for_human');
});

// Codex re-review of PR #4 (C3): the runtime's resumeRun asserts the pending
// intervention's nextStepId === 'auth_state_recheck', else it PERMANENTLY fails the run
// at resume. A bridge-created intervention must therefore be resumable end-to-end.
test('a bridge-created intervention resumes end-to-end (C3)', async () => {
  const { coordinator } = makeCoordinator();
  const runId = await runningRun(coordinator, 'run_bridge_resume');
  const requested = await requestHumanInterventionFromBrowser(
    { coordinator },
    { runId, expectedVersion: 2, signal: loginSignal(), browserSessionRef: 'session:abc-123', now: FIXED_NOW },
  );
  assert.equal(requested.checkpoint.nextStepId, 'auth_state_recheck');

  await coordinator.completeHumanIntervention({
    runId,
    requestId: requested.request.id,
    expectedVersion: requested.checkpoint.version,
    resumeToken: requested.resumeToken,
    result: 'completed',
    completedBy: 'human',
    completedAt: '2026-07-15T00:05:00.000Z',
  });
  const resumed = await coordinator.resumeRun({
    runId,
    expectedVersion: requested.checkpoint.version + 1,
    requestId: requested.request.id,
    now: '2026-07-15T00:06:00.000Z',
  });
  assert.equal(resumed.status, 'running_after_resume');
  assert.equal(resumed.phase, 'auth_state_recheck');
});

// Codex re-review of PR #4 (C3): a caller-supplied nextStepId other than the fixed
// resume-entry step is rejected up front, so an un-resumable intervention is never created.
test('bridge rejects a non-default nextStepId', async () => {
  const { coordinator } = makeCoordinator();
  const runId = await runningRun(coordinator, 'run_bridge_badstep');
  await assert.rejects(
    () =>
      requestHumanInterventionFromBrowser(
        { coordinator },
        { runId, expectedVersion: 2, signal: loginSignal(), browserSessionRef: 'session:abc-123', nextStepId: 'discovering_network' },
      ),
    /nextStepId must be auth_state_recheck/,
  );
  // the explicit default value is accepted
  const ok = await requestHumanInterventionFromBrowser(
    { coordinator },
    { runId, expectedVersion: 2, signal: loginSignal(), browserSessionRef: 'session:abc-123', nextStepId: 'auth_state_recheck' },
  );
  assert.equal(ok.checkpoint.nextStepId, 'auth_state_recheck');
});

// Codex re-review of PR #4 (C4): an untrusted urlPreview is length-bounded before new URL
// parses it and before it is persisted.
test('bridge drops an overlong urlPreview before sanitizing/persisting', async () => {
  const captured = [];
  const coordinator = { requestHumanIntervention: async (input) => { captured.push(input); return { checkpoint: {}, request: { id: 'x' }, resumeToken: 't' }; } };
  const huge = 'https://app.example.com/' + 'a'.repeat(5000);
  await requestHumanInterventionFromBrowser(
    { coordinator },
    { runId: 'r', expectedVersion: 2, signal: loginSignal({ urlPreview: huge }), browserSessionRef: 'session:abc-123' },
  );
  assert.equal('url' in captured[0], false); // overlong -> dropped, not persisted
  // a normal-length preview is still kept
  await requestHumanInterventionFromBrowser(
    { coordinator },
    { runId: 'r', expectedVersion: 2, signal: loginSignal({ urlPreview: 'https://app.example.com/account' }), browserSessionRef: 'session:abc-123' },
  );
  assert.equal(captured[1].url, 'https://app.example.com/account');
});

// Self-review (S1): the adapter is a trust boundary; a non-string browserSessionRef is
// rejected with a clean error, not an incidental TypeError, and never echoed.
test('bridge rejects a non-string browserSessionRef cleanly', async () => {
  const coordinator = { requestHumanIntervention: async () => { throw new Error('should not reach coordinator'); } };
  for (const ref of [undefined, 12345, ['session:x'], { toString: () => 'session:x' }]) {
    await assert.rejects(
      () => requestHumanInterventionFromBrowser({ coordinator }, { runId: 'r', expectedVersion: 2, signal: loginSignal(), browserSessionRef: ref }),
      /browserSessionRef must be a string/,
      JSON.stringify(ref),
    );
  }
});

// Codex re-review of PR #4 round 2 (D1): a prototype-key signal kind (__proto__,
// constructor, toString) returns an inherited truthy value from an ordinary-object lookup,
// bypassing the unknown-kind rejection. An own-property check must reject it -- without echo.
test('bridge rejects prototype-key signal kinds without echoing them', async () => {
  const coordinator = { requestHumanIntervention: async () => { throw new Error('should not reach coordinator'); } };
  for (const kind of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    await assert.rejects(
      () => requestHumanInterventionFromBrowser({ coordinator }, { runId: 'r', expectedVersion: 2, signal: loginSignal({ kind }), browserSessionRef: 'session:abc-123' }),
      /kind is not a known intervention kind/,
      kind,
    );
  }
});

// Codex re-review of PR #4 round 3 (E1): a foreign detector could back signal fields with
// GETTERS that pass validation on the first read and return a secret on the second (TOCTOU).
// The adapter must snapshot each field once, so the persisted values never see the secret.
test('bridge snapshots signal fields once (getter TOCTOU cannot leak)', async () => {
  const captured = [];
  const coordinator = { requestHumanIntervention: async (input) => { captured.push(input); return { checkpoint: {}, request: { id: 'x' }, resumeToken: 't' }; } };
  let reasonReads = 0;
  let urlReads = 0;
  let sourceReads = 0;
  const evil = {
    kind: 'login-required',
    get confidence() { return 0.9; },
    get reason() { reasonReads += 1; return reasonReads === 1 ? 'navigation-unauthorized-status' : 'sk-live-REASONSECRET'; },
    get urlPreview() { urlReads += 1; return urlReads === 1 ? 'https://idp.example.com/login' : 'https://evil.example.com/x?token=URLSECRET'; },
    get source() { sourceReads += 1; return sourceReads === 1 ? 'navigation' : 'sk-live-SOURCESECRET'; },
  };
  await requestHumanInterventionFromBrowser({ coordinator }, { runId: 'r', expectedVersion: 2, signal: evil, browserSessionRef: 'session:abc-123' });
  const sent = JSON.stringify(captured[0]);
  assert.equal(sent.includes('REASONSECRET'), false);
  assert.equal(sent.includes('URLSECRET'), false);
  assert.equal(sent.includes('SOURCESECRET'), false);
  // each untrusted field was read at most once
  assert.ok(reasonReads <= 1 && urlReads <= 1 && sourceReads <= 1, `reads: reason=${reasonReads} url=${urlReads} source=${sourceReads}`);
  // the first-read (valid) values are what got persisted
  assert.ok(captured[0].reason.includes('navigation-unauthorized-status'));
  assert.equal(captured[0].url, 'https://idp.example.com/login');
});
