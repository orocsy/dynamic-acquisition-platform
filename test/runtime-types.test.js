'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../dist/runtime');

function serialized(value) {
  return JSON.stringify(value);
}

test('exports Phase 2.1 runtime state constants', () => {
  assert.deepEqual(runtime.RUN_STATUSES, [
    'created',
    'running',
    'waiting_for_human',
    'running_after_resume',
    'expired',
    'failed',
    'completed',
    'cancelled',
  ]);

  assert.deepEqual(runtime.TERMINAL_RUN_STATUSES, ['failed', 'completed', 'cancelled']);

  assert.deepEqual(runtime.RUN_PHASES, [
    'intent_accepted',
    'target_opened',
    'auth_boundary_detected',
    'waiting_for_human',
    'auth_state_recheck',
    'discovering_network',
    'normalizing_evidence',
    'finalizing',
    'terminal',
  ]);
});

test('exports Phase 2.1 human intervention constants', () => {
  assert.deepEqual(runtime.HUMAN_INTERVENTION_KINDS, [
    'login-required',
    'mfa-required',
    'consent-required',
    'captcha-required',
    'decision-required',
  ]);

  assert.deepEqual(runtime.HUMAN_INTERVENTION_STATUSES, ['pending', 'completed', 'expired', 'cancelled']);
  assert.deepEqual(runtime.HUMAN_INTERVENTION_COMPLETION_RESULTS, ['completed', 'cancelled', 'unsafe', 'expired']);
  assert.deepEqual(runtime.HUMAN_INTERVENTION_COMPLETED_BY_VALUES, ['human', 'agent', 'system']);
});

test('exports Phase 2.1 event and diagnostic constants', () => {
  assert.deepEqual(runtime.RUNTIME_EVENT_TYPES, [
    'run.created',
    'checkpoint.updated',
    'intervention.requested',
    'intervention.completed',
    'intervention.expired',
    'intervention.cancelled',
    'run.resumed',
    'auth.rechecked',
    'evidence.normalized',
    'run.expired',
    'run.failed',
    'run.completed',
    'run.cancelled',
  ]);

  assert.deepEqual(runtime.RUNTIME_DIAGNOSTIC_LEVELS, ['info', 'warning', 'error']);
  assert.ok(runtime.RUNTIME_ERROR_CODES.includes('invalid-resume-token'));
  assert.ok(runtime.RUNTIME_ERROR_CODES.includes('stale-checkpoint-version'));
  assert.ok(runtime.RUNTIME_ERROR_CODES.includes('terminal-run-state'));
});

test('checkpoint fixture persists hash and operational refs without raw resume token', () => {
  const checkpoint = {
    runId: 'run_001',
    status: 'waiting_for_human',
    phase: 'waiting_for_human',
    intentSnapshot: { target: { kind: 'url', value: 'https://example.com/account' } },
    evidenceRefs: ['evidence_001'],
    artifactRefs: [],
    browserSessionRef: 'browser-session:opaque-001',
    pendingInterventionId: 'intervention_001',
    lastCompletedStepId: 'auth_boundary_detected',
    nextStepId: 'auth_state_recheck',
    resumeTokenHash: 'sha256:hash-only',
    resumeAttempts: 0,
    version: 3,
    diagnostics: [
      {
        level: 'info',
        code: 'auth-boundary-detected',
        message: 'Login is required before acquisition can continue.',
        data: { url: 'https://example.com/account' },
      },
    ],
    createdAt: '2026-04-30T08:00:00.000Z',
    updatedAt: '2026-04-30T08:01:00.000Z',
    expiresAt: '2026-04-30T08:16:00.000Z',
  };

  assert.equal(checkpoint.status, 'waiting_for_human');
  assert.equal(checkpoint.nextStepId, 'auth_state_recheck');
  assert.equal(checkpoint.version, 3);
  assert.equal(serialized(checkpoint).includes('raw-resume-token'), false);
  assert.equal(Object.hasOwn(checkpoint, 'resumeToken'), false);
});

test('human intervention request fixture stores token hash and preview without raw token', () => {
  const request = {
    id: 'intervention_001',
    runId: 'run_001',
    kind: 'login-required',
    status: 'pending',
    url: 'https://example.com/login',
    reason: 'Authenticated access is required.',
    instructions: ['Open the page and complete login.', 'Do not share credentials with the agent.'],
    resumeTokenPreview: 'rt_1234…abcd',
    resumeTokenHash: 'sha256:hash-only',
    safeToRetry: true,
    timeoutMs: 900000,
    createdAt: '2026-04-30T08:01:00.000Z',
    expiresAt: '2026-04-30T08:16:00.000Z',
  };

  assert.equal(request.status, 'pending');
  assert.equal(request.resumeTokenHash, 'sha256:hash-only');
  assert.equal(request.resumeTokenPreview.includes('hash-only'), false);
  assert.equal(Object.hasOwn(request, 'resumeToken'), false);
});
