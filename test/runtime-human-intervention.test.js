'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  InMemoryCheckpointStore,
  InMemoryInterventionStore,
  RuntimeCoordinator,
  RuntimeCoordinatorError,
  hashResumeToken,
  previewResumeToken,
} = require('../dist/runtime');

const FIXED_NOW = '2026-05-07T00:00:00.000Z';
const FIXED_DONE = '2026-05-07T00:05:00.000Z';
const FIXED_TOKEN = 'rt_deterministic_secret_token_1234567890';

function baseIntent() {
  return { target: { kind: 'url', value: 'https://example.com/account' } };
}

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

async function createRunningRun(coordinator, runId = 'run_human_001') {
  await coordinator.createRun({ runId, intentSnapshot: baseIntent(), evidenceRefs: ['evidence_intent'] });
  return coordinator.markRunning({
    runId,
    expectedVersion: 1,
    phase: 'auth_boundary_detected',
    lastCompletedStepId: 'target_opened',
    evidenceRefs: ['evidence_intent', 'evidence_auth_boundary'],
  });
}

async function requestLoginIntervention(coordinator, runId = 'run_human_001', overrides = {}) {
  return coordinator.requestHumanIntervention({
    runId,
    expectedVersion: 2,
    kind: 'login-required',
    reason: 'Login is required before authenticated discovery can continue.',
    instructions: ['Complete login in the controlled browser.', 'Return here when the page is ready.'],
    nextStepId: 'auth_state_recheck',
    timeoutMs: 10 * 60 * 1000,
    url: 'https://example.com/login?token=secret',
    ...overrides,
  });
}

async function rejectsWithCoordinatorError(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof RuntimeCoordinatorError, true);
    assert.equal(error.code, code);
    assert.equal(error.diagnostic.level, 'error');
    return true;
  });
}

test('requestHumanIntervention pauses a running run and returns the raw resume token once', async () => {
  const { checkpointStore, interventionStore, coordinator } = makeCoordinator();
  await createRunningRun(coordinator);

  const { checkpoint, request, resumeToken } = await requestLoginIntervention(coordinator);

  assert.equal(resumeToken, FIXED_TOKEN);
  assert.equal(checkpoint.status, 'waiting_for_human');
  assert.equal(checkpoint.phase, 'waiting_for_human');
  assert.equal(checkpoint.pendingInterventionId, request.id);
  assert.equal(checkpoint.nextStepId, 'auth_state_recheck');
  assert.equal(checkpoint.resumeTokenHash, hashResumeToken(FIXED_TOKEN));
  assert.equal(checkpoint.version, 3);
  assert.deepEqual(checkpoint.evidenceRefs, ['evidence_intent', 'evidence_auth_boundary']);

  assert.equal(request.status, 'pending');
  assert.equal(request.kind, 'login-required');
  assert.equal(request.url, 'https://example.com/login');
  assert.equal(request.resumeTokenHash, hashResumeToken(FIXED_TOKEN));
  assert.equal(request.resumeTokenPreview, previewResumeToken(FIXED_TOKEN));

  const storedRequest = await interventionStore.get(request.id);
  const storedCheckpoint = await checkpointStore.get('run_human_001');
  const events = await checkpointStore.listEvents('run_human_001');
  assert.equal(JSON.stringify(storedRequest).includes(FIXED_TOKEN), false);
  assert.equal(JSON.stringify(storedCheckpoint).includes(FIXED_TOKEN), false);
  assert.equal(JSON.stringify(events).includes(FIXED_TOKEN), false);
  assert.deepEqual(events.map((event) => event.type), ['run.created', 'checkpoint.updated', 'intervention.requested']);
});

test('requestHumanIntervention rejects non-running runs, missing nextStepId, and invalid expiry without state changes', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  await coordinator.createRun({ runId: 'run_not_running_001', intentSnapshot: baseIntent() });

  await rejectsWithCoordinatorError(
    () => coordinator.requestHumanIntervention({
      runId: 'run_not_running_001',
      expectedVersion: 1,
      kind: 'login-required',
      reason: 'Login required.',
      instructions: ['Log in.'],
      nextStepId: 'auth_state_recheck',
    }),
    'invalid-transition',
  );

  await createRunningRun(coordinator, 'run_missing_step_001');
  await rejectsWithCoordinatorError(
    () => requestLoginIntervention(coordinator, 'run_missing_step_001', { nextStepId: '' }),
    'invalid-transition',
  );
  await rejectsWithCoordinatorError(
    () => requestLoginIntervention(coordinator, 'run_missing_step_001', { expiresAt: '2026-05-06T23:59:59.000Z' }),
    'invalid-transition',
  );

  const events = await checkpointStore.listEvents('run_missing_step_001');
  assert.deepEqual(events.map((event) => event.type), ['run.created', 'checkpoint.updated']);
});

test('human lifecycle methods require an intervention store', async () => {
  const checkpointStore = new InMemoryCheckpointStore();
  const coordinator = new RuntimeCoordinator({ checkpointStore, clock: () => FIXED_NOW });
  await createRunningRun(coordinator, 'run_missing_store_001');

  await rejectsWithCoordinatorError(
    () => coordinator.requestHumanIntervention({
      runId: 'run_missing_store_001',
      expectedVersion: 2,
      kind: 'login-required',
      reason: 'Login is required.',
      instructions: ['Log in.'],
      nextStepId: 'auth_state_recheck',
    }),
    'invalid-transition',
  );
});

test('completeHumanIntervention verifies the raw token before completing a pending request', async () => {
  const { checkpointStore, interventionStore, coordinator } = makeCoordinator();
  await createRunningRun(coordinator);
  const requested = await requestLoginIntervention(coordinator);

  await rejectsWithCoordinatorError(
    () => coordinator.completeHumanIntervention({
      runId: 'run_human_001',
      requestId: requested.request.id,
      expectedVersion: 3,
      resumeToken: 'rt_wrong_token',
      result: 'completed',
      completedBy: 'human',
      completedAt: FIXED_DONE,
    }),
    'invalid-resume-token',
  );

  assert.equal((await interventionStore.get(requested.request.id)).status, 'pending');
  assert.equal((await checkpointStore.get('run_human_001')).version, 3);
  assert.deepEqual((await checkpointStore.listEvents('run_human_001')).map((event) => event.type), [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
  ]);

  const completed = await coordinator.completeHumanIntervention({
    runId: 'run_human_001',
    requestId: requested.request.id,
    expectedVersion: 3,
    resumeToken: FIXED_TOKEN,
    result: 'completed',
    completedBy: 'human',
    browserSessionRef: 'browser_session_opaque_001',
    completedAt: FIXED_DONE,
  });

  assert.equal(completed.request.status, 'completed');
  assert.equal(completed.request.completedAt, FIXED_DONE);
  assert.equal(completed.checkpoint.status, 'waiting_for_human');
  assert.equal(completed.checkpoint.phase, 'waiting_for_human');
  assert.equal(completed.checkpoint.browserSessionRef, 'browser_session_opaque_001');
  assert.equal(completed.checkpoint.version, 4);
  assert.equal(JSON.stringify(await checkpointStore.listEvents('run_human_001')).includes(FIXED_TOKEN), false);
  assert.deepEqual((await checkpointStore.listEvents('run_human_001')).map((event) => event.type), [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
    'intervention.completed',
  ]);

  await rejectsWithCoordinatorError(
    () => coordinator.completeHumanIntervention({
      runId: 'run_human_001',
      requestId: requested.request.id,
      expectedVersion: 4,
      resumeToken: FIXED_TOKEN,
      result: 'completed',
      completedBy: 'human',
      completedAt: '2026-05-07T00:06:00.000Z',
    }),
    'invalid-transition',
  );
});

test('cancelled, unsafe, and expired human outcomes update request and checkpoint state safely', async () => {
  for (const [result, expectedStatus, expectedDiagnostic] of [
    ['cancelled', 'cancelled', 'human-intervention-cancelled'],
    ['unsafe', 'cancelled', 'unsafe-human-result'],
    ['expired', 'expired', 'intervention-expired'],
  ]) {
    const runId = `run_${result}_001`;
    const { coordinator } = makeCoordinator();
    await createRunningRun(coordinator, runId);
    const requested = await requestLoginIntervention(coordinator, runId);

    const completed = await coordinator.completeHumanIntervention({
      runId,
      requestId: requested.request.id,
      expectedVersion: 3,
      resumeToken: FIXED_TOKEN,
      result,
      completedBy: result === 'expired' ? 'system' : 'human',
      notes: result === 'unsafe' ? 'Human saw an unsafe redirect.' : undefined,
      completedAt: FIXED_DONE,
    });

    assert.equal(completed.request.status, expectedStatus);
    assert.equal(completed.checkpoint.status, expectedStatus);
    assert.equal(completed.checkpoint.diagnostics.at(-1).code, expectedDiagnostic);

    if (result === 'expired') {
      assert.equal(completed.checkpoint.phase, 'waiting_for_human');
      assert.equal(completed.checkpoint.pendingInterventionId, requested.request.id);
    } else {
      assert.equal(completed.checkpoint.phase, 'terminal');
      assert.equal('pendingInterventionId' in completed.checkpoint, false);
    }
  }
});
