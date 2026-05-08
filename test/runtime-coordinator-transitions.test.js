'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  InMemoryCheckpointStore,
  RuntimeCoordinator,
} = require('../dist/runtime');

const FIXED_NOW = '2026-05-04T00:00:00.000Z';

function makeCoordinator(store = new InMemoryCheckpointStore()) {
  let eventCounter = 0;
  return {
    store,
    coordinator: new RuntimeCoordinator({
      checkpointStore: store,
      clock: () => FIXED_NOW,
      idFactory: (kind) => `${kind}_${String(++eventCounter).padStart(3, '0')}`,
    }),
  };
}

function baseIntent() {
  return { target: { kind: 'url', value: 'https://example.com/account' } };
}

function waitingCheckpoint(overrides = {}) {
  return {
    runId: 'run_waiting_001',
    status: 'waiting_for_human',
    phase: 'waiting_for_human',
    intentSnapshot: baseIntent(),
    evidenceRefs: ['evidence_login_boundary'],
    artifactRefs: ['artifact_before_wait'],
    pendingInterventionId: 'intervention_waiting_001',
    lastCompletedStepId: 'auth_boundary_detected',
    nextStepId: 'auth_state_recheck',
    resumeTokenHash: 'sha256:hash-only',
    resumeAttempts: 0,
    version: 4,
    diagnostics: [
      {
        level: 'info',
        code: 'auth-boundary-detected',
        message: 'Login boundary detected.',
        data: { url: 'https://example.com/login?token=secret' },
      },
    ],
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: '2026-05-04T00:01:00.000Z',
    expiresAt: '2026-05-04T00:16:00.000Z',
    ...overrides,
  };
}

test('runtime coordinator creates a run, marks it running, and completes it with ordered events', async () => {
  const { store, coordinator } = makeCoordinator();

  const created = await coordinator.createRun({
    runId: 'run_transition_001',
    intentSnapshot: baseIntent(),
    evidenceRefs: ['evidence_001'],
  });
  assert.equal(created.status, 'created');
  assert.equal(created.phase, 'intent_accepted');
  assert.equal(created.version, 1);

  const running = await coordinator.markRunning({
    runId: 'run_transition_001',
    expectedVersion: 1,
    lastCompletedStepId: 'intent_accepted',
    evidenceRefs: ['evidence_001', 'evidence_002'],
  });
  assert.equal(running.status, 'running');
  assert.equal(running.phase, 'target_opened');
  assert.equal(running.lastCompletedStepId, 'intent_accepted');
  assert.deepEqual(running.evidenceRefs, ['evidence_001', 'evidence_002']);
  assert.equal(running.version, 2);

  const completed = await coordinator.markCompleted({
    runId: 'run_transition_001',
    expectedVersion: 2,
    lastCompletedStepId: 'finalizing',
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.phase, 'terminal');
  assert.equal(completed.lastCompletedStepId, 'finalizing');
  assert.deepEqual(completed.evidenceRefs, ['evidence_001', 'evidence_002']);
  assert.equal(completed.version, 3);

  const events = await store.listEvents('run_transition_001');
  assert.deepEqual(events.map((event) => event.type), ['run.created', 'checkpoint.updated', 'run.completed']);
  assert.deepEqual(events.map((event) => event.id), ['event_001', 'event_002', 'event_003']);
  assert.equal(events[1].data.fromStatus, 'created');
  assert.equal(events[1].data.toStatus, 'running');
  assert.equal(events[2].data.fromStatus, 'running');
  assert.equal(events[2].data.toStatus, 'completed');
});

test('runtime coordinator marks running runs failed with structured diagnostics', async () => {
  const { store, coordinator } = makeCoordinator();
  await coordinator.createRun({ runId: 'run_failed_001', intentSnapshot: baseIntent() });
  await coordinator.markRunning({ runId: 'run_failed_001', expectedVersion: 1 });

  const failed = await coordinator.markFailed({
    runId: 'run_failed_001',
    expectedVersion: 2,
    code: 'provider-timeout',
    message: 'Provider did not respond in time.',
    data: { url: 'https://example.com/api?token=secret' },
  });

  assert.equal(failed.status, 'failed');
  assert.equal(failed.phase, 'terminal');
  assert.equal(failed.diagnostics.length, 1);
  assert.equal(failed.diagnostics[0].code, 'provider-timeout');
  assert.equal(failed.diagnostics[0].data.url, 'https://example.com/api');

  const events = await store.listEvents('run_failed_001');
  assert.deepEqual(events.map((event) => event.type), ['run.created', 'checkpoint.updated', 'run.failed']);
  assert.equal(events[2].data.code, 'provider-timeout');
});

test('runtime coordinator expires waiting runs and can terminally fail or cancel expired runs', async () => {
  const failedFlow = makeCoordinator();
  await failedFlow.store.create(waitingCheckpoint({ runId: 'run_waiting_fail_001' }));

  const expired = await failedFlow.coordinator.markExpired({
    runId: 'run_waiting_fail_001',
    expectedVersion: 4,
    phase: 'discovering_network',
  });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.phase, 'waiting_for_human');
  assert.equal(expired.pendingInterventionId, 'intervention_waiting_001');
  assert.equal(expired.version, 5);

  const failed = await failedFlow.coordinator.markFailed({
    runId: 'run_waiting_fail_001',
    expectedVersion: 5,
    message: 'Human intervention expired before login completed.',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.phase, 'terminal');
  assert.equal('pendingInterventionId' in failed, false);

  const failedEvents = await failedFlow.store.listEvents('run_waiting_fail_001');
  assert.deepEqual(failedEvents.map((event) => event.type), ['run.expired', 'run.failed']);

  const cancelledFlow = makeCoordinator();
  await cancelledFlow.store.create(waitingCheckpoint({ runId: 'run_waiting_cancel_001' }));
  const expiredForCancel = await cancelledFlow.coordinator.markExpired({
    runId: 'run_waiting_cancel_001',
    expectedVersion: 4,
  });
  const cancelled = await cancelledFlow.coordinator.cancelRun({
    runId: 'run_waiting_cancel_001',
    expectedVersion: expiredForCancel.version,
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.phase, 'terminal');
});

test('runtime coordinator writes accepted transition events through the atomic store path', async () => {
  class AppendEventRejectingStore extends InMemoryCheckpointStore {
    async appendEvent() {
      throw new Error('coordinator should not call appendEvent for accepted transitions');
    }
  }

  const store = new AppendEventRejectingStore();
  const { coordinator } = makeCoordinator(store);

  await coordinator.createRun({ runId: 'run_atomic_events_001', intentSnapshot: baseIntent() });
  await coordinator.markRunning({ runId: 'run_atomic_events_001', expectedVersion: 1 });

  const checkpoint = await store.get('run_atomic_events_001');
  assert.equal(checkpoint.status, 'running');

  const events = await store.listEvents('run_atomic_events_001');
  assert.deepEqual(events.map((event) => event.type), ['run.created', 'checkpoint.updated']);
});

test('runtime coordinator cancels running and waiting runs while preserving artifacts until terminal cleanup', async () => {
  const runningFlow = makeCoordinator();
  await runningFlow.coordinator.createRun({
    runId: 'run_cancel_running_001',
    intentSnapshot: baseIntent(),
    artifactRefs: ['artifact_001'],
  });
  await runningFlow.coordinator.markRunning({ runId: 'run_cancel_running_001', expectedVersion: 1 });

  const runningCancelled = await runningFlow.coordinator.cancelRun({
    runId: 'run_cancel_running_001',
    expectedVersion: 2,
  });
  assert.equal(runningCancelled.status, 'cancelled');
  assert.equal(runningCancelled.phase, 'terminal');
  assert.deepEqual(runningCancelled.artifactRefs, ['artifact_001']);

  const waitingFlow = makeCoordinator();
  await waitingFlow.store.create(waitingCheckpoint({ runId: 'run_cancel_waiting_001' }));
  const waitingCancelled = await waitingFlow.coordinator.cancelRun({
    runId: 'run_cancel_waiting_001',
    expectedVersion: 4,
  });
  assert.equal(waitingCancelled.status, 'cancelled');
  assert.equal(waitingCancelled.phase, 'terminal');
  assert.equal('pendingInterventionId' in waitingCancelled, false);
  assert.deepEqual(waitingCancelled.artifactRefs, ['artifact_before_wait']);

  const events = await waitingFlow.store.listEvents('run_cancel_waiting_001');
  assert.deepEqual(events.map((event) => event.type), ['run.cancelled']);
});
