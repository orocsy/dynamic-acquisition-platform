'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resumeBrowserRun,
  FakeBrowserAuthRechecker,
  authRecheckFailure,
  BrowserNetworkCaptureSession,
} = require('../dist/browser');
const {
  InMemoryCheckpointStore,
  InMemoryInterventionStore,
  RuntimeCoordinator,
  RuntimeCoordinatorError,
  hashResumeToken,
  previewResumeToken,
} = require('../dist/runtime');

const NOW = '2026-07-15T02:00:00.000Z';
const DONE = '2026-07-15T02:03:00.000Z';
const TOKEN = 'rt_resume_browser_secret_token_000001';

function makeCoordinator() {
  const checkpointStore = new InMemoryCheckpointStore();
  const interventionStore = new InMemoryInterventionStore();
  const counters = { event: 0, intervention: 0 };
  const coordinator = new RuntimeCoordinator({
    checkpointStore,
    interventionStore,
    clock: () => NOW,
    idFactory: (kind) => `${kind}_${String(++counters[kind]).padStart(3, '0')}`,
    resumeTokenIssuer: () => ({ resumeToken: TOKEN, resumeTokenHash: hashResumeToken(TOKEN), resumeTokenPreview: previewResumeToken(TOKEN) }),
  });
  return { checkpointStore, coordinator };
}

// Drive a run to a COMPLETED intervention (ready for resumeBrowserRun). Returns the completed
// checkpoint (its version is resumeBrowserRun's expectedVersion) + the requestId.
async function toCompletedIntervention(coordinator, runId = 'run_ac_001') {
  await coordinator.createRun({ runId, intentSnapshot: { target: { kind: 'url', value: 'https://example.com/account' } }, artifactRefs: ['artifact_before_auth'] });
  await coordinator.markRunning({ runId, expectedVersion: 1, phase: 'auth_boundary_detected', evidenceRefs: ['evidence_auth_boundary'] });
  const requested = await coordinator.requestHumanIntervention({
    runId, expectedVersion: 2, kind: 'login-required', reason: 'Login required.', instructions: ['Complete login.'], nextStepId: 'auth_state_recheck',
  });
  const completed = await coordinator.completeHumanIntervention({
    runId, requestId: requested.request.id, expectedVersion: 3, resumeToken: TOKEN, result: 'completed', completedBy: 'human', completedAt: DONE,
  });
  return { requestId: requested.request.id, completed };
}

function safeObs(id) {
  return {
    id, runId: 'run_ac_001', pageTargetRef: 'page:t-1', source: 'cdp', capturedAt: NOW,
    request: { url: 'https://api.example.com/v1/users', method: 'GET', queryParamNames: ['page'] },
    response: { status: 200, mimeType: 'application/json' },
  };
}
function sessionWith(observations) {
  const session = new BrowserNetworkCaptureSession({ collect: async () => observations });
  return session;
}
async function startedSession(observations, runId = 'run_ac_001') {
  const session = sessionWith(observations);
  await session.start({ runId, pageTargetRef: 'page:t-1' });
  return session;
}

// ---- §9.6 scenarios ----

test('completed intervention + successful recheck continues to completed with evidence', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const session = await startedSession([safeObs('o1'), safeObs('o2')]);
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 0.9, diagnostics: [] }), session },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://api.example.com', now: NOW },
  );
  assert.equal(result.outcome, 'completed');
  assert.equal(result.checkpoint.status, 'completed');
  assert.ok(result.capture.evidenceCount >= 1);
  // deterministic event order (§9.6)
  const events = (await checkpointStore.listEvents('run_ac_001')).map((e) => e.type);
  assert.deepEqual(events, [
    'run.created', 'checkpoint.updated', 'intervention.requested', 'intervention.completed',
    'run.resumed', 'auth.rechecked', 'evidence.normalized', 'run.completed',
  ]);
});

test('a failed recheck calls markFailed BEFORE any evidence work (session never stopped)', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  let stopped = false;
  const session = { start: async () => {}, stop: async () => { stopped = true; return { observations: [], diagnostics: [] }; }, listObservations: async () => [] };
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('still-unauthorized')), session },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(result.checkpoint.status, 'failed');
  assert.equal(stopped, false, 'capture must not run after a failed recheck');
  const events = (await checkpointStore.listEvents('run_ac_001')).map((e) => e.type);
  assert.deepEqual(events.slice(-2), ['run.resumed', 'run.failed']);
  assert.equal(events.includes('auth.rechecked'), false);
  assert.equal(events.includes('evidence.normalized'), false);
});

test('stale target with a safe recreation policy continues after a new target ref', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const session = await startedSession([safeObs('o1')]);
  let recheckCalls = 0;
  const rechecker = new FakeBrowserAuthRechecker(() => (++recheckCalls === 1 ? authRecheckFailure('target-stale') : { ok: true, confidence: 1, diagnostics: [] }));
  const created = [];
  const pageTargets = { createTarget: async (input) => { created.push(input); return { pageTargetRef: 'page:recreated-1', state: 'created', updatedAt: NOW }; } };
  const result = await resumeBrowserRun(
    { coordinator, rechecker, session, pageTargets, recreationPolicy: () => true },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: { id: 'daemon_1', kind: 'local-chrome-daemon', mode: 'dedicated-daemon', healthUrlPreview: 'http://127.0.0.1:9222' }, now: NOW },
  );
  assert.equal(result.outcome, 'completed');
  assert.equal(recheckCalls, 2); // retried once after recreation
  assert.equal(created.length, 1);
});

test('stale target WITHOUT a permitting policy fails safely (no recreation)', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const session = await startedSession([safeObs('o1')]);
  let created = 0;
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('target-stale')), session,
      pageTargets: { createTarget: async () => { created += 1; return { pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }; } },
      recreationPolicy: () => false },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: { id: 'd', kind: 'local-chrome-daemon', mode: 'dedicated-daemon', healthUrlPreview: 'http://127.0.0.1:9222' }, now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(result.recheckCode, 'target-stale');
  assert.equal(created, 0, 'no recreation without a permitting policy');
});

test('a side-effect in progress blocks recreation even if policy would allow it', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const session = await startedSession([safeObs('o1')]);
  let created = 0;
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('target-stale')), session,
      pageTargets: { createTarget: async () => { created += 1; return { pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }; } },
      recreationPolicy: () => true },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: { id: 'd', kind: 'local-chrome-daemon', mode: 'dedicated-daemon', healthUrlPreview: 'http://127.0.0.1:9222' }, sideEffectInProgress: true, now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(created, 0);
});

test('a duplicate resume attempt remains rejected by the coordinator', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const deps = { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session: await startedSession([safeObs('o1')]) };
  const input = { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://api.example.com', now: NOW };
  await resumeBrowserRun(deps, input);
  // a second resume at the SAME expectedVersion is a stale-version transition -> rejected
  await assert.rejects(() => resumeBrowserRun(deps, input), (e) => e instanceof RuntimeCoordinatorError);
});

// ---- abuse: the resume flow does not trust a foreign rechecker's message/code/ref ----

test('resume flow re-derives a safe failure message and never forwards a foreign one', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  // a hostile rechecker returns an unknown code + secret-bearing message/diagnostics
  const hostile = { recheck: async () => ({ ok: false, code: 'sk-live-BADCODE', message: 'Bearer sk-live-MSGSECRET', diagnostics: [{ level: 'error', secret: 'sk-live-DIAGSECRET' }] }) };
  const session = { start: async () => {}, stop: async () => { throw new Error('should not capture'); }, listObservations: async () => [] };
  const result = await resumeBrowserRun({ coordinator, rechecker: hostile, session }, { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW });
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(result.recheckCode, 'still-unauthorized'); // unknown code -> safe default
  const persisted = JSON.stringify(await checkpointStore.get('run_ac_001'));
  assert.equal(persisted.includes('MSGSECRET'), false);
  assert.equal(persisted.includes('DIAGSECRET'), false);
  assert.equal(persisted.includes('BADCODE'), false);
});

test('resume flow ignores a foreign rechecker-returned pageTargetRef that is not page-shaped', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  // ok result carrying a rogue ws:// pageTargetRef; capture must key off the safe input ref
  const rechecker = { recheck: async () => ({ ok: true, confidence: 1, pageTargetRef: 'ws://127.0.0.1:9222/devtools/RAW', diagnostics: [] }) };
  const stopKeys = [];
  const session = { start: async () => {}, stop: async (i) => { stopKeys.push(i.pageTargetRef); return { observations: [], diagnostics: [] }; }, listObservations: async () => [] };
  await resumeBrowserRun({ coordinator, rechecker, session }, { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW });
  assert.deepEqual(stopKeys, ['page:t-1']); // fell back to the safe input ref, not the rogue one
});
