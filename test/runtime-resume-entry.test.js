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

const FIXED_NOW = '2026-05-07T01:00:00.000Z';
const FIXED_DONE = '2026-05-07T01:03:00.000Z';
const FIXED_RESUME = '2026-05-07T01:04:00.000Z';
const FIXED_TOKEN = 'rt_resume_entry_secret_token_1234567890';

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

function baseIntent() {
  return { target: { kind: 'url', value: 'https://example.com/account' } };
}

async function prepareCompletedIntervention(coordinator, runId = 'run_resume_001', overrides = {}) {
  await coordinator.createRun({ runId, intentSnapshot: baseIntent(), artifactRefs: ['artifact_before_auth'] });
  await coordinator.markRunning({
    runId,
    expectedVersion: 1,
    phase: 'auth_boundary_detected',
    evidenceRefs: ['evidence_auth_boundary'],
    lastCompletedStepId: 'target_opened',
  });
  const requested = await coordinator.requestHumanIntervention({
    runId,
    expectedVersion: 2,
    kind: 'login-required',
    reason: 'Login is required.',
    instructions: ['Complete login.'],
    nextStepId: 'auth_state_recheck',
    timeoutMs: 600000,
    ...overrides.request,
  });
  const completed = await coordinator.completeHumanIntervention({
    runId,
    requestId: requested.request.id,
    expectedVersion: 3,
    resumeToken: FIXED_TOKEN,
    result: 'completed',
    completedBy: 'human',
    completedAt: FIXED_DONE,
    ...overrides.complete,
  });
  return { requested, completed };
}

async function rejectsWithCoordinatorError(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof RuntimeCoordinatorError, true);
    assert.equal(error.code, code);
    assert.equal(error.diagnostic.level, 'error');
    return true;
  });
}

test('resumeRun enters running_after_resume at auth_state_recheck and preserves wait metadata for audit', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  const { requested, completed } = await prepareCompletedIntervention(coordinator);

  const resumed = await coordinator.resumeRun({
    runId: 'run_resume_001',
    expectedVersion: completed.checkpoint.version,
    requestId: requested.request.id,
    now: FIXED_RESUME,
  });

  assert.equal(resumed.status, 'running_after_resume');
  assert.equal(resumed.phase, 'auth_state_recheck');
  assert.equal(resumed.resumeAttempts, 1);
  assert.equal(resumed.version, 5);
  assert.equal(resumed.pendingInterventionId, requested.request.id);
  assert.equal(resumed.nextStepId, 'auth_state_recheck');
  assert.equal(resumed.resumeTokenHash, hashResumeToken(FIXED_TOKEN));
  assert.deepEqual(resumed.artifactRefs, ['artifact_before_auth']);
  assert.deepEqual(resumed.evidenceRefs, ['evidence_auth_boundary']);

  const events = await checkpointStore.listEvents('run_resume_001');
  assert.deepEqual(events.map((event) => event.type), [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
    'intervention.completed',
    'run.resumed',
  ]);
  assert.equal(events.at(-1).data.nextStepId, 'auth_state_recheck');
});

test('resumeRun rejects duplicate resume attempts without appending a second resume event', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  const { requested, completed } = await prepareCompletedIntervention(coordinator, 'run_resume_duplicate_001');

  const resumed = await coordinator.resumeRun({
    runId: 'run_resume_duplicate_001',
    expectedVersion: completed.checkpoint.version,
    requestId: requested.request.id,
    now: FIXED_RESUME,
  });

  await rejectsWithCoordinatorError(
    () => coordinator.resumeRun({
      runId: 'run_resume_duplicate_001',
      expectedVersion: resumed.version,
      requestId: requested.request.id,
      now: '2026-05-07T01:05:00.000Z',
    }),
    'invalid-transition',
  );

  const checkpoint = await checkpointStore.get('run_resume_duplicate_001');
  assert.equal(checkpoint.status, 'running_after_resume');
  assert.equal(checkpoint.version, resumed.version);
  assert.deepEqual((await checkpointStore.listEvents('run_resume_duplicate_001')).map((event) => event.type), [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
    'intervention.completed',
    'run.resumed',
  ]);
});

test('resumeRun rejects stale versions without appending a resume event', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  const { requested } = await prepareCompletedIntervention(coordinator, 'run_resume_stale_001');

  await rejectsWithCoordinatorError(
    () => coordinator.resumeRun({
      runId: 'run_resume_stale_001',
      expectedVersion: 3,
      requestId: requested.request.id,
      now: FIXED_RESUME,
    }),
    'stale-checkpoint-version',
  );

  const events = await checkpointStore.listEvents('run_resume_stale_001');
  assert.deepEqual(events.map((event) => event.type), [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
    'intervention.completed',
  ]);
});

test('resumeRun rejects cancelled, unsafe, and expired intervention outcomes', async () => {
  for (const result of ['cancelled', 'unsafe', 'expired']) {
    const runId = `run_resume_reject_${result}`;
    const { coordinator } = makeCoordinator();
    await coordinator.createRun({ runId, intentSnapshot: baseIntent() });
    await coordinator.markRunning({ runId, expectedVersion: 1, phase: 'auth_boundary_detected' });
    const requested = await coordinator.requestHumanIntervention({
      runId,
      expectedVersion: 2,
      kind: 'login-required',
      reason: 'Login is required.',
      instructions: ['Complete login.'],
      nextStepId: 'auth_state_recheck',
    });
    const completed = await coordinator.completeHumanIntervention({
      runId,
      requestId: requested.request.id,
      expectedVersion: 3,
      resumeToken: FIXED_TOKEN,
      result,
      completedBy: result === 'expired' ? 'system' : 'human',
      completedAt: FIXED_DONE,
    });

    await rejectsWithCoordinatorError(
      () => coordinator.resumeRun({
        runId,
        expectedVersion: completed.checkpoint.version,
        requestId: requested.request.id,
        now: FIXED_RESUME,
      }),
      'invalid-transition',
    );
  }
});

test('resumeRun requires auth_state_recheck as the first resumed step', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  const { requested, completed } = await prepareCompletedIntervention(coordinator, 'run_resume_bad_step_001', {
    request: { nextStepId: 'discovering_network' },
  });

  await rejectsWithCoordinatorError(
    () => coordinator.resumeRun({
      runId: 'run_resume_bad_step_001',
      expectedVersion: completed.checkpoint.version,
      requestId: requested.request.id,
      now: FIXED_RESUME,
    }),
    'invalid-transition',
  );

  const checkpoint = await checkpointStore.get('run_resume_bad_step_001');
  assert.equal(checkpoint.status, 'waiting_for_human');
  assert.equal(checkpoint.version, completed.checkpoint.version);
  assert.deepEqual((await checkpointStore.listEvents('run_resume_bad_step_001')).map((event) => event.type), [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
    'intervention.completed',
  ]);
});
