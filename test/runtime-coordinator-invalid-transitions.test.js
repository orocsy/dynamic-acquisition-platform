'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  InMemoryCheckpointStore,
  RuntimeCoordinator,
  RuntimeCoordinatorError,
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

async function rejectsWithCoordinatorError(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof RuntimeCoordinatorError, true);
    assert.equal(error.code, code);
    assert.equal(error.diagnostic.level, 'error');
    assert.equal(error.diagnostic.code, code);
    return true;
  });
}

test('runtime coordinator rejects duplicate create attempts and appends no extra event', async () => {
  const { store, coordinator } = makeCoordinator();
  await coordinator.createRun({ runId: 'run_duplicate_001', intentSnapshot: baseIntent() });
  await coordinator.markRunning({ runId: 'run_duplicate_001', expectedVersion: 1 });

  await rejectsWithCoordinatorError(
    () => coordinator.createRun({ runId: 'run_duplicate_001', intentSnapshot: baseIntent() }),
    'invalid-transition',
  );

  const checkpoint = await store.get('run_duplicate_001');
  assert.equal(checkpoint.status, 'running');
  const events = await store.listEvents('run_duplicate_001');
  assert.deepEqual(events.map((event) => event.type), ['run.created', 'checkpoint.updated']);
});

test('runtime coordinator rejects invalid active-state transitions without appending events', async () => {
  const { store, coordinator } = makeCoordinator();
  await coordinator.createRun({ runId: 'run_invalid_active_001', intentSnapshot: baseIntent() });

  await rejectsWithCoordinatorError(
    () => coordinator.markCompleted({ runId: 'run_invalid_active_001', expectedVersion: 1 }),
    'invalid-transition',
  );
  await rejectsWithCoordinatorError(
    () => coordinator.markFailed({ runId: 'run_invalid_active_001', expectedVersion: 1 }),
    'invalid-transition',
  );
  await rejectsWithCoordinatorError(
    () => coordinator.markExpired({ runId: 'run_invalid_active_001', expectedVersion: 1 }),
    'invalid-transition',
  );
  await rejectsWithCoordinatorError(
    () => coordinator.cancelRun({ runId: 'run_invalid_active_001', expectedVersion: 1 }),
    'invalid-transition',
  );

  const checkpoint = await store.get('run_invalid_active_001');
  assert.equal(checkpoint.status, 'created');
  const events = await store.listEvents('run_invalid_active_001');
  assert.deepEqual(events.map((event) => event.type), ['run.created']);
});

test('runtime coordinator rejects rerunning terminal checkpoints', async () => {
  const completedFlow = makeCoordinator();
  await completedFlow.coordinator.createRun({ runId: 'run_completed_001', intentSnapshot: baseIntent() });
  await completedFlow.coordinator.markRunning({ runId: 'run_completed_001', expectedVersion: 1 });
  await completedFlow.coordinator.markCompleted({ runId: 'run_completed_001', expectedVersion: 2 });

  await rejectsWithCoordinatorError(
    () => completedFlow.coordinator.markRunning({ runId: 'run_completed_001', expectedVersion: 3 }),
    'terminal-run-state',
  );

  const completedEvents = await completedFlow.store.listEvents('run_completed_001');
  assert.deepEqual(completedEvents.map((event) => event.type), ['run.created', 'checkpoint.updated', 'run.completed']);

  const failedFlow = makeCoordinator();
  await failedFlow.coordinator.createRun({ runId: 'run_failed_terminal_001', intentSnapshot: baseIntent() });
  await failedFlow.coordinator.markRunning({ runId: 'run_failed_terminal_001', expectedVersion: 1 });
  await failedFlow.coordinator.markFailed({ runId: 'run_failed_terminal_001', expectedVersion: 2, message: 'Network exhausted.' });

  await rejectsWithCoordinatorError(
    () => failedFlow.coordinator.markCompleted({ runId: 'run_failed_terminal_001', expectedVersion: 3 }),
    'terminal-run-state',
  );

  const failedEvents = await failedFlow.store.listEvents('run_failed_terminal_001');
  assert.deepEqual(failedEvents.map((event) => event.type), ['run.created', 'checkpoint.updated', 'run.failed']);
});

test('runtime coordinator rejects stale expected versions and leaves checkpoint/events untouched', async () => {
  const { store, coordinator } = makeCoordinator();
  await coordinator.createRun({ runId: 'run_stale_001', intentSnapshot: baseIntent() });
  await coordinator.markRunning({ runId: 'run_stale_001', expectedVersion: 1 });

  await rejectsWithCoordinatorError(
    () => coordinator.markCompleted({ runId: 'run_stale_001', expectedVersion: 1 }),
    'stale-checkpoint-version',
  );

  const checkpoint = await store.get('run_stale_001');
  assert.equal(checkpoint.status, 'running');
  assert.equal(checkpoint.version, 2);
  const events = await store.listEvents('run_stale_001');
  assert.deepEqual(events.map((event) => event.type), ['run.created', 'checkpoint.updated']);
});

test('runtime coordinator rejects unknown runs with a structured diagnostic', async () => {
  const { store, coordinator } = makeCoordinator();

  await rejectsWithCoordinatorError(
    () => coordinator.markRunning({ runId: 'missing_run', expectedVersion: 1 }),
    'checkpoint-not-found',
  );

  const events = await store.listEvents('missing_run');
  assert.deepEqual(events, []);
});

test('runtime coordinator rejects terminal phase on non-terminal transitions', async () => {
  const { store, coordinator } = makeCoordinator();
  await coordinator.createRun({ runId: 'run_bad_phase_001', intentSnapshot: baseIntent() });

  await rejectsWithCoordinatorError(
    () => coordinator.markRunning({ runId: 'run_bad_phase_001', expectedVersion: 1, phase: 'terminal' }),
    'invalid-transition',
  );

  const checkpoint = await store.get('run_bad_phase_001');
  assert.equal(checkpoint.status, 'created');
  const events = await store.listEvents('run_bad_phase_001');
  assert.deepEqual(events.map((event) => event.type), ['run.created']);
});
