'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  InMemoryCheckpointStore,
  InMemoryInterventionStore,
  RuntimeStoreError,
} = require('../dist/runtime');

function createdCheckpoint(overrides = {}) {
  return {
    runId: 'run_store_001',
    status: 'created',
    phase: 'intent_accepted',
    intentSnapshot: { target: 'https://example.com' },
    evidenceRefs: [],
    artifactRefs: [],
    resumeAttempts: 0,
    version: 1,
    diagnostics: [],
    createdAt: '2026-04-30T08:00:00.000Z',
    updatedAt: '2026-04-30T08:00:00.000Z',
    ...overrides,
  };
}

function waitingCheckpoint(overrides = {}) {
  return createdCheckpoint({
    status: 'waiting_for_human',
    phase: 'waiting_for_human',
    pendingInterventionId: 'intervention_store_001',
    nextStepId: 'auth_state_recheck',
    resumeTokenHash: 'sha256:hash-only',
    expiresAt: '2026-04-30T08:30:00.000Z',
    ...overrides,
  });
}

function pendingIntervention(overrides = {}) {
  return {
    id: 'intervention_store_001',
    runId: 'run_store_001',
    kind: 'login-required',
    status: 'pending',
    reason: 'Login is required.',
    url: 'https://example.com/login?token=secret',
    instructions: ['Complete login in the browser.'],
    resumeTokenPreview: 'rt_1234…abcd',
    resumeTokenHash: 'sha256:hash-only',
    safeToRetry: true,
    timeoutMs: 900000,
    createdAt: '2026-04-30T08:00:00.000Z',
    expiresAt: '2026-04-30T08:30:00.000Z',
    ...overrides,
  };
}

async function rejectsWithStoreError(action, code) {
  await assert.rejects(action, (error) => error instanceof RuntimeStoreError && error.code === code);
}

test('checkpoint store create/get clones records, strips unexpected raw tokens, redacts unsafe browser refs, and rejects duplicates', async () => {
  const store = new InMemoryCheckpointStore();
  const input = createdCheckpoint({
    evidenceRefs: ['evidence_001'],
    browserSessionRef: '~/Library/Application Support/Chrome/Profile?cookie=session',
    resumeToken: 'rt_sensitive_raw_token',
  });
  const created = await store.create(input);

  input.evidenceRefs.push('mutated_input');
  created.evidenceRefs.push('mutated_return');

  const stored = await store.get('run_store_001');
  assert.deepEqual(stored.evidenceRefs, ['evidence_001']);
  assert.equal(stored.browserSessionRef, '[redacted]');
  assert.equal(JSON.stringify(stored).includes('rt_sensitive_raw_token'), false);
  assert.equal(JSON.stringify(stored).includes('~/Library'), false);
  await rejectsWithStoreError(() => store.create(createdCheckpoint()), 'invalid-transition');
});

test('checkpoint store create/update can commit accepted transition events with checkpoint mutations', async () => {
  const store = new InMemoryCheckpointStore();
  await store.create(
    createdCheckpoint(),
    { id: 'event_create', runId: 'run_store_001', type: 'run.created', at: '2026-04-30T08:00:00.000Z', data: { url: 'https://example.com/start?token=secret' } },
  );

  const updated = await store.update(
    'run_store_001',
    { expectedVersion: 1, status: 'running', phase: 'target_opened', updatedAt: '2026-04-30T08:01:00.000Z' },
    { id: 'event_update', runId: 'run_store_001', type: 'checkpoint.updated', at: '2026-04-30T08:01:00.000Z', data: { resumeToken: 'raw-token' } },
  );

  assert.equal(updated.status, 'running');
  const events = await store.listEvents('run_store_001');
  assert.deepEqual(events.map((event) => event.id), ['event_create', 'event_update']);
  assert.equal(events[0].data.url, 'https://example.com/start');
  assert.equal(events[1].data.resumeToken, '[redacted]');

  await rejectsWithStoreError(
    () => store.update(
      'run_store_001',
      { expectedVersion: 2, status: 'completed', phase: 'terminal' },
      { id: 'event_mismatch', runId: 'wrong_run', type: 'run.completed', at: '2026-04-30T08:02:00.000Z', data: {} },
    ),
    'invalid-transition',
  );
});

test('checkpoint store update increments version, preserves createdAt, and checks expected version', async () => {
  const store = new InMemoryCheckpointStore();
  await store.create(createdCheckpoint());

  const updated = await store.update('run_store_001', {
    expectedVersion: 1,
    status: 'running',
    phase: 'target_opened',
    evidenceRefs: ['evidence_001'],
    updatedAt: '2026-04-30T08:01:00.000Z',
  });

  assert.equal(updated.version, 2);
  assert.equal(updated.createdAt, '2026-04-30T08:00:00.000Z');
  assert.equal(updated.updatedAt, '2026-04-30T08:01:00.000Z');
  assert.deepEqual(updated.evidenceRefs, ['evidence_001']);
  await rejectsWithStoreError(() => store.update('run_store_001', { expectedVersion: 1 }), 'stale-checkpoint-version');
});

test('checkpoint store terminal transition clears pending resume fields', async () => {
  const store = new InMemoryCheckpointStore();
  await store.create(waitingCheckpoint());

  const terminal = await store.update('run_store_001', {
    expectedVersion: 1,
    status: 'completed',
    phase: 'terminal',
    updatedAt: '2026-04-30T08:10:00.000Z',
  });

  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.phase, 'terminal');
  assert.equal('pendingInterventionId' in terminal, false);
  assert.equal('nextStepId' in terminal, false);
  assert.equal('resumeTokenHash' in terminal, false);
  assert.equal('expiresAt' in terminal, false);
});

test('checkpoint store rejects missing records, invalid waiting checkpoints, and terminal updates', async () => {
  const store = new InMemoryCheckpointStore();
  await rejectsWithStoreError(() => store.update('missing', { status: 'running' }), 'checkpoint-not-found');
  await rejectsWithStoreError(
    () => store.create(waitingCheckpoint({ nextStepId: undefined })),
    'invalid-transition',
  );

  await rejectsWithStoreError(
    () => store.create(createdCheckpoint({ status: 'completed', phase: 'terminal', expiresAt: '2026-04-30T08:30:00.000Z' })),
    'terminal-run-state',
  );

  await store.create(createdCheckpoint({ status: 'completed', phase: 'terminal' }));
  await rejectsWithStoreError(() => store.update('run_store_001', { status: 'running' }), 'terminal-run-state');
});

test('checkpoint store redacts diagnostics/events, appends events in order, and lists active waiting checkpoints', async () => {
  const store = new InMemoryCheckpointStore();
  await store.create(waitingCheckpoint({
    diagnostics: [
      {
        level: 'warning',
        code: 'redaction-required',
        message: 'query should be sanitized',
        data: { url: 'https://example.com/login?token=secret' },
      },
    ],
  }));
  await store.create(waitingCheckpoint({ runId: 'run_expired', expiresAt: '2026-04-30T07:00:00.000Z' }));
  await store.create(createdCheckpoint({ runId: 'run_running', status: 'running', phase: 'target_opened' }));

  const storedCheckpoint = await store.get('run_store_001');
  assert.equal(storedCheckpoint.diagnostics[0].data.url, 'https://example.com/login');

  await store.appendEvent({ id: 'event_001', runId: 'run_store_001', type: 'run.created', at: '2026-04-30T08:00:00.000Z', data: { url: 'https://example.com/start?code=secret' } });
  await store.appendEvent({ id: 'event_002', runId: 'run_store_001', type: 'checkpoint.updated', at: '2026-04-30T08:01:00.000Z', data: { status: 'waiting_for_human', resumeToken: 'raw-token' } });

  const events = await store.listEvents('run_store_001');
  assert.deepEqual(events.map((event) => event.id), ['event_001', 'event_002']);
  assert.equal(events[0].data.url, 'https://example.com/start');
  assert.equal(events[1].data.resumeToken, '[redacted]');

  events[0].data.mutated = true;
  const eventsAgain = await store.listEvents('run_store_001');
  assert.equal(eventsAgain[0].data.mutated, undefined);

  const waiting = await store.listWaiting('2026-04-30T08:05:00.000Z');
  assert.deepEqual(waiting.map((checkpoint) => checkpoint.runId), ['run_store_001']);
});

test('intervention store create/get clones records, strips unexpected raw tokens, and rejects duplicates', async () => {
  const store = new InMemoryInterventionStore();
  const input = pendingIntervention({ resumeToken: 'rt_sensitive_raw_token' });
  const created = await store.create(input);

  input.instructions.push('mutated_input');
  created.instructions.push('mutated_return');

  const stored = await store.get('intervention_store_001');
  assert.deepEqual(stored.instructions, ['Complete login in the browser.']);
  assert.equal(stored.url, 'https://example.com/login');
  assert.equal(JSON.stringify(stored).includes('rt_sensitive_raw_token'), false);
  await rejectsWithStoreError(() => store.create(pendingIntervention()), 'invalid-transition');
});

test('intervention store completes, expires, and cancels pending requests only', async () => {
  const store = new InMemoryInterventionStore();
  await store.create(pendingIntervention());

  const completed = await store.complete({
    requestId: 'intervention_store_001',
    runId: 'run_store_001',
    resumeToken: 'raw-token-not-persisted',
    result: 'completed',
    completedBy: 'human',
    completedAt: '2026-04-30T08:05:00.000Z',
  });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.completedAt, '2026-04-30T08:05:00.000Z');
  assert.equal(JSON.stringify(completed).includes('raw-token-not-persisted'), false);
  await rejectsWithStoreError(
    () => store.complete({ requestId: 'intervention_store_001', runId: 'run_store_001', resumeToken: 'x', result: 'completed', completedBy: 'human', completedAt: '2026-04-30T08:06:00.000Z' }),
    'invalid-transition',
  );

  const expiringStore = new InMemoryInterventionStore();
  await expiringStore.create(pendingIntervention({ id: 'intervention_expire' }));
  const expired = await expiringStore.expire('intervention_expire', '2026-04-30T08:30:00.000Z');
  assert.equal(expired.status, 'expired');

  const cancellingStore = new InMemoryInterventionStore();
  await cancellingStore.create(pendingIntervention({ id: 'intervention_cancel' }));
  const cancelled = await cancellingStore.cancel('intervention_cancel', '2026-04-30T08:10:00.000Z');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelledAt, '2026-04-30T08:10:00.000Z');
});

test('intervention store rejects missing requests and run mismatches', async () => {
  const store = new InMemoryInterventionStore();
  await rejectsWithStoreError(() => store.expire('missing', '2026-04-30T08:00:00.000Z'), 'intervention-not-found');

  await store.create(pendingIntervention());
  await rejectsWithStoreError(
    () => store.complete({ requestId: 'intervention_store_001', runId: 'wrong_run', resumeToken: 'x', result: 'completed', completedBy: 'human', completedAt: '2026-04-30T08:05:00.000Z' }),
    'invalid-transition',
  );
});
