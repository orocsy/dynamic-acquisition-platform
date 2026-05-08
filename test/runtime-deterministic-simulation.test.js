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
  runDeterministicAuthenticatedSimulation,
} = require('../dist/runtime');

const baseFixture = require('../src/fixtures/runtime/simulated-auth-resume-flow.json');

const FIXED_TOKEN = 'rt_simulated_resume_secret_token_1234567890';

function makeDeps() {
  const checkpointStore = new InMemoryCheckpointStore();
  const interventionStore = new InMemoryInterventionStore();
  const counters = { event: 0, intervention: 0 };
  return {
    checkpointStore,
    interventionStore,
    coordinator: new RuntimeCoordinator({
      checkpointStore,
      interventionStore,
      idFactory: (kind) => `${kind}_${String(++counters[kind]).padStart(3, '0')}`,
      resumeTokenIssuer: () => ({
        resumeToken: FIXED_TOKEN,
        resumeTokenHash: hashResumeToken(FIXED_TOKEN),
        resumeTokenPreview: previewResumeToken(FIXED_TOKEN),
      }),
    }),
  };
}

function fixtureWithRunId(runId) {
  return { ...baseFixture, runId };
}

test('deterministic authenticated simulation completes only after resume auth recheck and evidence normalization', async () => {
  const deps = makeDeps();
  const result = await runDeterministicAuthenticatedSimulation(deps, fixtureWithRunId('run_sim_happy_001'));

  assert.equal(result.outcome, 'completed');
  assert.equal(result.checkpoints.resumed.status, 'running_after_resume');
  assert.equal(result.checkpoints.resumed.phase, 'auth_state_recheck');
  assert.equal(result.checkpoints.authRechecked.status, 'running');
  assert.equal(result.checkpoints.authRechecked.phase, 'discovering_network');
  assert.equal(result.checkpoints.authRechecked.lastCompletedStepId, 'auth_state_recheck');
  assert.equal('pendingInterventionId' in result.checkpoints.authRechecked, false);
  assert.equal('nextStepId' in result.checkpoints.authRechecked, false);
  assert.equal('resumeTokenHash' in result.checkpoints.authRechecked, false);
  assert.equal('expiresAt' in result.checkpoints.authRechecked, false);

  assert.equal(result.normalizedEvidence.evidence.length, 1);
  assert.deepEqual(result.checkpoints.evidenceNormalized.evidenceRefs, [
    'evidence_intent',
    'evidence_auth_boundary',
    'evidence_001',
  ]);
  assert.equal(result.checkpoints.final.status, 'completed');
  assert.equal(result.checkpoints.final.phase, 'terminal');
  assert.deepEqual(result.checkpoints.final.evidenceRefs, result.checkpoints.evidenceNormalized.evidenceRefs);

  assert.deepEqual(result.events.map((event) => event.type), [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
    'intervention.completed',
    'run.resumed',
    'auth.rechecked',
    'evidence.normalized',
    'run.completed',
  ]);

  const authRecheckedIndex = result.events.findIndex((event) => event.type === 'auth.rechecked');
  const evidenceNormalizedIndex = result.events.findIndex((event) => event.type === 'evidence.normalized');
  assert.ok(authRecheckedIndex > result.events.findIndex((event) => event.type === 'run.resumed'));
  assert.ok(evidenceNormalizedIndex > authRecheckedIndex);

  assert.equal(JSON.stringify(result).includes(FIXED_TOKEN), false);
  assert.equal(JSON.stringify(result.checkpoints.final).includes(FIXED_TOKEN), false);
  assert.equal(JSON.stringify(result.events).includes(FIXED_TOKEN), false);
  assert.equal(JSON.stringify(result.events).includes('secret-value'), false);
  assert.equal(JSON.stringify(result.normalizedEvidence).includes('secret-value'), false);
  assert.equal(result.normalizedEvidence.evidence[0].target.value, 'https://example.com/account/items');
  assert.equal(result.normalizedEvidence.evidence[0].observations[0].data.urlPattern, 'https://example.com/api/account/items');
});

test('auth recheck failure fails the resumed run before evidence normalization', async () => {
  const deps = makeDeps();
  const result = await runDeterministicAuthenticatedSimulation(
    deps,
    fixtureWithRunId('run_sim_auth_fail_001'),
    {
      authStateRecheck: {
        ok: false,
        code: 'auth-state-recheck-failed',
        message: 'Session was still unauthenticated after human login.',
      },
    },
  );

  assert.equal(result.outcome, 'failed-auth-recheck');
  assert.equal(result.checkpoints.final.status, 'failed');
  assert.equal(result.checkpoints.final.phase, 'terminal');
  assert.equal(result.checkpoints.final.diagnostics.at(-1).code, 'auth-state-recheck-failed');
  assert.equal(result.normalizedEvidence.evidence.length, 0);
  assert.deepEqual(result.events.map((event) => event.type), [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
    'intervention.completed',
    'run.resumed',
    'run.failed',
  ]);
  assert.equal(result.events.some((event) => event.type === 'evidence.normalized'), false);
});

test('cancelled human intervention never resumes or normalizes evidence', async () => {
  const deps = makeDeps();
  const result = await runDeterministicAuthenticatedSimulation(
    deps,
    fixtureWithRunId('run_sim_cancelled_001'),
    {
      humanCompletion: {
        result: 'cancelled',
        completedBy: 'human',
        notes: 'User cancelled the login attempt.',
      },
    },
  );

  assert.equal(result.outcome, 'human-cancelled');
  assert.equal(result.checkpoints.final.status, 'cancelled');
  assert.equal(result.checkpoints.final.phase, 'terminal');
  assert.equal(result.normalizedEvidence.evidence.length, 0);
  assert.deepEqual(result.events.map((event) => event.type), [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
    'intervention.cancelled',
  ]);
  assert.equal(result.events.some((event) => event.type === 'run.resumed'), false);
  assert.equal(result.events.some((event) => event.type === 'evidence.normalized'), false);
});

test('evidence normalization cannot run before post-resume auth recheck succeeds', async () => {
  const deps = makeDeps();
  await deps.coordinator.createRun({ runId: 'run_sim_out_of_order_001', intentSnapshot: baseFixture.intentSnapshot });
  await deps.coordinator.markRunning({
    runId: 'run_sim_out_of_order_001',
    expectedVersion: 1,
    phase: 'auth_boundary_detected',
  });
  const requested = await deps.coordinator.requestHumanIntervention({
    runId: 'run_sim_out_of_order_001',
    expectedVersion: 2,
    kind: 'login-required',
    reason: 'Login required.',
    instructions: ['Log in.'],
    nextStepId: 'auth_state_recheck',
  });
  const completed = await deps.coordinator.completeHumanIntervention({
    runId: 'run_sim_out_of_order_001',
    requestId: requested.request.id,
    expectedVersion: 3,
    resumeToken: FIXED_TOKEN,
    result: 'completed',
    completedBy: 'human',
  });
  const resumed = await deps.coordinator.resumeRun({
    runId: 'run_sim_out_of_order_001',
    requestId: requested.request.id,
    expectedVersion: completed.checkpoint.version,
  });

  await assert.rejects(
    () => deps.coordinator.recordNormalizedEvidence({
      runId: 'run_sim_out_of_order_001',
      expectedVersion: resumed.version,
      evidenceRefs: ['evidence_001'],
    }),
    (error) => {
      assert.equal(error instanceof RuntimeCoordinatorError, true);
      assert.equal(error.code, 'invalid-transition');
      return true;
    },
  );

  assert.deepEqual((await deps.checkpointStore.listEvents('run_sim_out_of_order_001')).map((event) => event.type), [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
    'intervention.completed',
    'run.resumed',
  ]);
});

test('wrong resume token stops the simulation before completion or resume', async () => {
  const deps = makeDeps();
  const runId = 'run_sim_wrong_token_001';
  await assert.rejects(
    () => runDeterministicAuthenticatedSimulation(
      deps,
      fixtureWithRunId(runId),
      { humanCompletion: { resumeTokenOverride: 'rt_wrong_resume_token' } },
    ),
    (error) => {
      assert.equal(error instanceof RuntimeCoordinatorError, true);
      assert.equal(error.code, 'invalid-resume-token');
      return true;
    },
  );

  const checkpoint = await deps.checkpointStore.get(runId);
  assert.equal(checkpoint.status, 'waiting_for_human');
  assert.equal(checkpoint.version, 3);
  assert.deepEqual((await deps.checkpointStore.listEvents(runId)).map((event) => event.type), [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
  ]);
  const request = await deps.interventionStore.get(checkpoint.pendingInterventionId);
  assert.equal(request.status, 'pending');
});
