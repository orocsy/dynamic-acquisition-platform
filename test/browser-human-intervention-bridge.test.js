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
          { runId: 'run_x', expectedVersion: 2, signal: loginSignal(), browserSessionRef: ref, nextStepId: 'resume-auth' },
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
      nextStepId: 'resume-auth',
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
        { runId: 'run_x', expectedVersion: 2, signal: loginSignal({ kind: 'give-me-your-sk-live-KEY' }), browserSessionRef: 'session:abc-123', nextStepId: 'n' },
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
      nextStepId: 'resume-after-login',
      now: FIXED_NOW,
    },
  );

  assert.equal(result.checkpoint.status, 'waiting_for_human');
  assert.equal(result.checkpoint.phase, 'waiting_for_human');
  assert.equal(result.checkpoint.browserSessionRef, 'session:abc-123');
  assert.equal(result.resumeToken, FIXED_TOKEN); // returned ONCE, here only
  assert.equal(result.request.kind, 'login-required');
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
    { runId, expectedVersion: 2, signal: loginSignal(), browserSessionRef: 'session:abc-123', nextStepId: 'n', pageTargetRef: 'page:t-1' },
  );
  assert.deepEqual(staleCalls, [['page:t-1', 'auth-boundary-intervention']]);
  assert.equal(result.resumeToken, FIXED_TOKEN);

  const { coordinator: c2 } = makeCoordinator();
  const runId2 = await runningRun(c2, 'run_bridge_003');
  const result2 = await requestHumanInterventionFromBrowser(
    { coordinator: c2, pageTargets: { markStale: async () => { throw new Error('target gone'); } } },
    { runId: runId2, expectedVersion: 2, signal: loginSignal(), browserSessionRef: 'session:abc-123', nextStepId: 'n', pageTargetRef: 'page:t-1' },
  );
  assert.equal(result2.resumeToken, FIXED_TOKEN); // still returned despite the stale failure
  assert.equal(result2.checkpoint.status, 'waiting_for_human');
});
