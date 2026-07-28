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
// The daemon id 3.2 derives from the loopback endpoint; recreation now requires the supplied
// daemonRef's endpoint to derive the registry's daemonId, so fixtures use the real value.
const DAEMON_ID = 'daemon_local_127_0_0_1_9222';
const DAEMON_REF = { id: DAEMON_ID, kind: 'local-chrome-daemon', mode: 'dedicated-daemon', healthUrlPreview: 'http://127.0.0.1:9222' };

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
async function toCompletedIntervention(coordinator, runId = 'run_ac_001', intentSnapshot = { target: { kind: 'url', value: 'https://example.com/account' } }) {
  await coordinator.createRun({ runId, intentSnapshot, artifactRefs: ['artifact_before_auth'] });
  await coordinator.markRunning({ runId, expectedVersion: 1, phase: 'auth_boundary_detected', evidenceRefs: ['evidence_auth_boundary'] });
  const requested = await coordinator.requestHumanIntervention({
    runId, expectedVersion: 2, kind: 'login-required', reason: 'Login required.', instructions: ['Complete login.'], nextStepId: 'auth_state_recheck', browserSessionRef: 'session:abc-1',
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

// The session registry is REQUIRED (K1): it is the only authority binding a session to its
// owning run + page target (the checkpoint carries no page target). This default binds
// session:abc-1 -> run_ac_001 / page:t-1 on daemon_1, and records rebinds (K3).
function defaultRegistry(over = {}) {
  const record = { daemonId: DAEMON_ID, mode: 'dedicated-daemon', runId: 'run_ac_001', pageTargetRef: 'page:t-1', ...over };
  const updates = [];
  return {
    updates,
    get: () => record,
    update: (input) => { updates.push(input); if (input.pageTargetRef !== undefined) record.pageTargetRef = input.pageTargetRef; return record; },
  };
}

// ---- §9.6 scenarios ----

test('completed intervention + successful recheck continues to completed with evidence', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const session = await startedSession([safeObs('o1'), safeObs('o2')]);
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 0.9, diagnostics: [] }), session, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', now: NOW, completeRun: true },
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
    { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('still-unauthorized')), session, sessionRegistry: defaultRegistry() },
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
  // observations are stamped with the RECREATED ref: capture runs on that target after §9.5
  const recreatedObs = { ...safeObs('o1'), pageTargetRef: 'page:recreated-1' };
  const session = new BrowserNetworkCaptureSession({ collect: async () => [recreatedObs] });
  let recheckCalls = 0;
  const rechecker = new FakeBrowserAuthRechecker(() => (++recheckCalls === 1 ? authRecheckFailure('target-stale') : { ok: true, confidence: 1, diagnostics: [] }));
  const created = [];
  const pageTargets = { createTarget: async (input) => { created.push(input); return { pageTargetRef: 'page:recreated-1', state: 'created', updatedAt: NOW }; } };
  // J5: recreation requires the registry to bind the session to its owning daemon; the supplied
  // daemonRef.id must equal the record's daemonId. K3: the registry is REBOUND to the new ref.
  const sessionRegistry = defaultRegistry();
  const result = await resumeBrowserRun(
    { coordinator, rechecker, session, pageTargets, recreationPolicy: () => true, sessionRegistry },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: DAEMON_REF, sideEffectInProgress: false, now: NOW, completeRun: true },
  );
  assert.equal(result.outcome, 'completed');
  assert.equal(recheckCalls, 2); // retried once after recreation
  assert.equal(created.length, 1);
  // K3: the authoritative record now points at the recreated target, not the dead stale one
  assert.deepEqual(sessionRegistry.updates.map((u) => u.pageTargetRef), ['page:recreated-1']);
});

// Codex re-review of PR #5 round 3 (J5): recreation with a daemonRef whose id does NOT match
// the session's registry-bound daemon is blocked (no browser work on a foreign daemon).
test('recreation is blocked when the daemonRef does not match the session daemon', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  let created = 0;
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('target-stale')), session: await startedSession([safeObs('o1')]),
      pageTargets: { createTarget: async () => { created += 1; return { pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }; } },
      recreationPolicy: () => true,
      sessionRegistry: defaultRegistry({ daemonId: 'daemon_OWN' }) },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: { ...DAEMON_REF, id: 'daemon_FOREIGN' }, sideEffectInProgress: false, now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(created, 0);
});

// Codex re-review of PR #5 round 3 (J1): a registry record with NO bound page target does not
// authorize an arbitrary target (fail closed).
test('a registry record without a bound page target rejects any target', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const sessionRegistry = { get: () => ({ daemonId: 'd', runId: 'run_ac_001' }) }; // no pageTargetRef
  await assert.rejects(
    () => resumeBrowserRun(
      { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session: { start: async () => {}, stop: async () => ({ observations: [], diagnostics: [] }), listObservations: async () => [] }, sessionRegistry },
      { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW },
    ),
    /does not own this run/,
  );
});

// Codex re-review of PR #5 round 3 (J2): a rechecker-returned pageTargetRef must NOT substitute
// the authorized target for capture.
test('a rechecker-returned pageTargetRef does not redirect capture', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const rechecker = { recheck: async () => ({ ok: true, confidence: 1, pageTargetRef: 'page:FOREIGN', diagnostics: [] }) };
  const keys = [];
  const session = { start: async (i) => keys.push(i.pageTargetRef), stop: async (i) => { keys.push(i.pageTargetRef); return { observations: [], diagnostics: [] }; }, listObservations: async () => [] };
  await resumeBrowserRun({ coordinator, rechecker, session, sessionRegistry: defaultRegistry() }, { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW });
  assert.ok(keys.every((k) => k === 'page:t-1'), JSON.stringify(keys)); // authorized target only, not page:FOREIGN
});

// Codex re-review of PR #5 round 3 (J3): a discovery navigation that resolves ok:false (a
// normal failure, not a throw) fails the run terminally before capture.
test('a failed discovery navigation fails the run before capture', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  let stopped = false;
  let aborted = false;
  const session = { start: async () => {}, abort: async () => { aborted = true; }, stop: async () => { stopped = true; return { observations: [], diagnostics: [] }; }, listObservations: async () => [] };
  const pageTargets = { createTarget: async () => ({ pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }), navigate: async () => ({ ok: false, pageTargetRef: 'page:t-1', state: 'stale', diagnostics: [] }) };
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session, pageTargets, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', now: NOW },
  );
  // K6: auth ALREADY passed, so this is a discovery failure -- not another login failure
  assert.equal(result.outcome, 'discovery-failed');
  assert.equal(result.recheckOk, true);
  assert.equal(result.recheckCode, 'discovery-nav-failed');
  assert.equal(result.checkpoint.status, 'failed');
  assert.equal(stopped, false); // capture never ran (the abort-capable session aborted instead)
  assert.equal(aborted, true);
});

test('stale target WITHOUT a permitting policy fails safely (no recreation)', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const session = await startedSession([safeObs('o1')]);
  let created = 0;
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('target-stale')), session,
      pageTargets: { createTarget: async () => { created += 1; return { pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }; } },
      recreationPolicy: () => false, sessionRegistry: defaultRegistry() },
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
      recreationPolicy: () => true, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: { id: 'd', kind: 'local-chrome-daemon', mode: 'dedicated-daemon', healthUrlPreview: 'http://127.0.0.1:9222' }, sideEffectInProgress: true, now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(created, 0);
});

test('a duplicate resume attempt remains rejected by the coordinator', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const deps = { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session: await startedSession([safeObs('o1')]), sessionRegistry: defaultRegistry() };
  const input = { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', now: NOW };
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
  const result = await resumeBrowserRun({ coordinator, rechecker: hostile, session, sessionRegistry: defaultRegistry() }, { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW });
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
  await resumeBrowserRun({ coordinator, rechecker, session, sessionRegistry: defaultRegistry() }, { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW });
  assert.deepEqual(stopKeys, ['page:t-1']); // fell back to the safe input ref, not the rogue one
});

// Codex re-review of PR #5 round 1 (H6): completion is opt-in; by default a multi-step run
// stays running after evidence is recorded (a terminal transition can't be undone).
test('by default the run continues (evidence-recorded) after recording, not completed', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const session = await startedSession([safeObs('o1')]);
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', now: NOW },
  );
  assert.equal(result.outcome, 'evidence-recorded');
  assert.equal(result.checkpoint.status, 'running'); // not terminal
});

// Codex re-review of PR #5 round 1 (H2): a supplied session ref that differs from the one the
// resumed checkpoint carries is a cross-run mix -> terminal failure, no recheck against it.
test('a session ref not matching the resumed run fails terminally', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  let recheckRan = false;
  const rechecker = { recheck: async () => { recheckRan = true; return { ok: true, confidence: 1, diagnostics: [] }; } };
  const result = await resumeBrowserRun(
    { coordinator, rechecker, session: { start: async () => {}, stop: async () => ({ observations: [], diagnostics: [] }), listObservations: async () => [] }, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:OTHER-RUN', pageTargetRef: 'page:t-1', now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(result.recheckCode, 'session-mismatch');
  assert.equal(result.checkpoint.status, 'failed');
  assert.equal(recheckRan, false, 'must not recheck against a mismatched session');
});

// Codex re-review of PR #5 round 1 (H4): a malformed ref throws BEFORE the resume transition,
// so the caller can fix the input and retry; the transition was not consumed.
test('a malformed pageTargetRef throws before resume and the transition is retryable', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  await assert.rejects(
    () => resumeBrowserRun(
      { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session: { start: async () => {}, stop: async () => ({ observations: [], diagnostics: [] }), listObservations: async () => [] }, sessionRegistry: defaultRegistry() },
      { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'not-a-page-ref', now: NOW },
    ),
    /page target ref/,
  );
  // the run was NOT transitioned, so a corrected retry still works
  const retry = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session: await startedSession([safeObs('o1')]), sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW },
  );
  assert.equal(retry.outcome, 'evidence-recorded');
});

// Codex re-review of PR #5 round 1 (H4): a rechecker that throws AFTER the resume transition
// must become a terminal failure, not a stranded running_after_resume checkpoint.
test('a post-transition rechecker throw becomes a terminal failure', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const rechecker = { recheck: async () => { throw new Error('probe blew up'); } };
  const result = await resumeBrowserRun(
    { coordinator, rechecker, session: { start: async () => {}, stop: async () => ({ observations: [], diagnostics: [] }), listObservations: async () => [] }, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(result.recheckCode, 'recheck-error');
  assert.equal(result.checkpoint.status, 'failed');
});

// Codex re-review of PR #5 round 1 (H5): recreation requires sideEffectInProgress === false;
// an omitted (unknown) value must NOT be treated as safe.
test('recreation is blocked when sideEffectInProgress is omitted (unknown)', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  let created = 0;
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('target-stale')), session: await startedSession([safeObs('o1')]),
      pageTargets: { createTarget: async () => { created += 1; return { pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }; } },
      recreationPolicy: () => true, sessionRegistry: defaultRegistry() },
    // no sideEffectInProgress supplied
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: { id: 'd', kind: 'local-chrome-daemon', mode: 'dedicated-daemon', healthUrlPreview: 'http://127.0.0.1:9222' }, now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(created, 0);
});

// Codex re-review of PR #5 round 1 (H9): a non-literal-true `ok` (a truthy string/number, or a
// getter-flipped value) must be treated as a FAILURE, never as success.
test('a non-boolean ok discriminator is treated as a failure, not success', async () => {
  const { coordinator } = makeCoordinator();
  for (const okValue of ['false', 1, {}, 'true']) {
    const runId = `run_ok_${String(okValue).replace(/\W/g, '')}`;
    const { requestId, completed } = await toCompletedIntervention(coordinator, runId);
    const rechecker = { recheck: async () => ({ ok: okValue, confidence: 1, diagnostics: [] }) };
    const result = await resumeBrowserRun(
      { coordinator, rechecker, session: { start: async () => { throw new Error('should not capture'); }, stop: async () => ({ observations: [], diagnostics: [] }), listObservations: async () => [] }, sessionRegistry: defaultRegistry({ runId }) },
      { runId, expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW },
    );
    assert.equal(result.outcome, 'recheck-failed', `ok=${JSON.stringify(okValue)}`);
  }
});

// Codex re-review of PR #5 round 2 (I1): the checkpoint carries only the session ref, so a
// caller-supplied page target from ANOTHER run/session is rejected via the registry BEFORE the
// resume transition (retryable), not after (which would strand the run).
test('a page target not owned by the session is rejected before transitioning', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const registry = { get: (sessionId) => (sessionId === 'session:abc-1' ? { daemonId: 'd', runId: 'run_ac_001', pageTargetRef: 'page:t-1' } : undefined) };
  const rechecker = new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] });
  await assert.rejects(
    () => resumeBrowserRun(
      { coordinator, rechecker, session: { start: async () => {}, stop: async () => ({ observations: [], diagnostics: [] }), listObservations: async () => [] }, sessionRegistry: registry },
      { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:OTHER-RUN-TARGET', now: NOW },
    ),
    /does not own/,
  );
  // the run was NOT transitioned, so the registry-owned target still works
  const ok = await resumeBrowserRun(
    { coordinator, rechecker, session: await startedSession([safeObs('o1')]), sessionRegistry: registry },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW },
  );
  assert.equal(ok.outcome, 'evidence-recorded');
});

// Codex re-review of PR #5 round 2 (I3): absence of a checkpoint-bound session is NOT
// permission to adopt a caller-supplied one.
test('a resume with no checkpoint-bound session fails terminally', async () => {
  const { coordinator } = makeCoordinator();
  const runId = 'run_no_session';
  await coordinator.createRun({ runId, intentSnapshot: { target: { kind: 'url', value: 'https://example.com/account' } } });
  await coordinator.markRunning({ runId, expectedVersion: 1, phase: 'auth_boundary_detected' });
  const requested = await coordinator.requestHumanIntervention({ runId, expectedVersion: 2, kind: 'login-required', reason: 'x', instructions: ['y'], nextStepId: 'auth_state_recheck' });
  const completed = await coordinator.completeHumanIntervention({ runId, requestId: requested.request.id, expectedVersion: 3, resumeToken: TOKEN, result: 'completed', completedBy: 'human', completedAt: DONE });
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session: { start: async () => {}, stop: async () => ({ observations: [], diagnostics: [] }), listObservations: async () => [] }, sessionRegistry: defaultRegistry({ runId }) },
    { runId, expectedVersion: completed.checkpoint.version, requestId: requested.request.id, browserSessionRef: 'session:adopted', pageTargetRef: 'page:t-1', now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(result.recheckCode, 'session-mismatch');
  assert.equal(result.checkpoint.status, 'failed');
});

// Codex re-review of PR #5 round 2 (I2) + round 5 (K6): a throw AFTER confirmResumeAuthRecheck
// advanced the version -> the terminal markFailed must use the LATEST version, else it is
// rejected/stranded. And because the PASSED auth event is already committed, the failure must
// be reported as a DISCOVERY failure -- `recheck-failed` here would contradict the event log.
test('a throw after confirm fails terminally as a DISCOVERY failure (latest version)', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const session = { start: async () => { throw new Error('start blew up after confirm'); }, stop: async () => ({ observations: [], diagnostics: [] }), listObservations: async () => [] };
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', now: NOW },
  );
  assert.equal(result.outcome, 'discovery-failed');
  assert.equal(result.recheckOk, true); // auth DID pass; only discovery failed
  assert.equal(result.recheckCode, 'discovery-error');
  assert.equal(result.checkpoint.status, 'failed');
  const failedEvent = (await checkpointStore.listEvents('run_ac_001')).find((e) => e.type === 'run.failed');
  assert.equal(failedEvent.data.authRecheck, 'passed'); // consistent with the committed auth.rechecked
  assert.equal(failedEvent.data.stepId, 'discovering_network');
});

// Codex re-review of PR #5 round 2 (I5, I6): a discovery navigation runs inside the fresh
// post-recheck window before capture, and evidence-recorded advances the completed step.
test('discovery navigation runs in the fresh window and the completed step advances', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const order = [];
  const source = { beginCapture: () => order.push('reset'), collect: async () => { order.push('collect'); return [safeObs('o1')]; } };
  const session = new BrowserNetworkCaptureSession(source);
  const navigations = [];
  const pageTargets = { createTarget: async () => ({ pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }), navigate: async (i) => { order.push('navigate'); navigations.push(i.url); return { ok: true, pageTargetRef: i.pageTargetRef, state: 'ready', diagnostics: [] }; } };
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session, pageTargets, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', now: NOW },
  );
  assert.equal(result.outcome, 'evidence-recorded');
  assert.deepEqual(navigations, ['https://example.com/account']);
  assert.deepEqual(order, ['reset', 'navigate', 'collect']);
  assert.equal(result.checkpoint.lastCompletedStepId, 'discovering_network');
});

// Codex re-review of PR #5 round 4 (K5): a capture can be `recorded` yet carry NO evidence
// (nothing collected / everything skipped). Completing then would be a false success.
test('completeRun does not complete a run that produced zero evidence', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const emptySession = new BrowserNetworkCaptureSession({ collect: async () => [] }); // nothing captured
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session: emptySession, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', targetUrl: 'https://example.com/account', pageTargetRef: 'page:t-1', now: NOW, completeRun: true },
  );
  assert.equal(result.capture.evidenceCount, 0);
  assert.equal(result.outcome, 'evidence-not-recorded'); // NOT 'completed'
  assert.notEqual(result.checkpoint.status, 'completed');
});

// Codex re-review of PR #5 round 4 (K4 in the flow): a failed discovery navigation aborts the
// capture window it opened, so a buffering source is not left accumulating for a dead run.
test('a failed discovery navigation aborts the opened capture window', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const calls = [];
  const session = {
    start: async () => calls.push('start'),
    abort: async () => calls.push('abort'),
    stop: async () => { calls.push('stop'); return { observations: [], diagnostics: [] }; },
    listObservations: async () => [],
  };
  const pageTargets = { createTarget: async () => ({ pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }), navigate: async () => ({ ok: false, pageTargetRef: 'page:t-1', state: 'stale', diagnostics: [] }) };
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session, pageTargets, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', now: NOW },
  );
  assert.equal(result.outcome, 'discovery-failed');
  assert.deepEqual(calls, ['start', 'abort']); // window opened then aborted; never stopped/collected
});

// Codex re-review of PR #5 round 5 (K4): a REJECTED navigate() promise must take the same
// abort-then-discovery-failure path as an ok:false result -- surfacing it to the generic catch
// used to leave the just-opened window buffering while the run went terminal.
test('a REJECTED discovery navigation aborts the window and fails in the discovery phase', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const calls = [];
  const session = {
    start: async () => calls.push('start'),
    abort: async () => calls.push('abort'),
    stop: async () => { calls.push('stop'); return { observations: [], diagnostics: [] }; },
    listObservations: async () => [],
  };
  const pageTargets = { createTarget: async () => ({ pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }), navigate: async () => { throw new Error('target vanished after recheck'); } };
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session, pageTargets, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', now: NOW },
  );
  assert.equal(result.outcome, 'discovery-failed');
  assert.equal(result.recheckCode, 'discovery-nav-failed');
  assert.deepEqual(calls, ['start', 'abort']); // aborted, never stopped/collected
});

// Codex re-review of PR #5 round 5 (K9): navigation success is BOUND to the requested target.
// A pageTargets implementation mixing results across concurrent pages could answer ok for a
// DIFFERENT page; accepting it would run capture against a target that was never navigated.
test('discovery navigation success for a DIFFERENT target is a failure (bound to requested page)', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const calls = [];
  const session = {
    start: async () => calls.push('start'),
    abort: async () => calls.push('abort'),
    stop: async () => { calls.push('stop'); return { observations: [], diagnostics: [] }; },
    listObservations: async () => [],
  };
  const pageTargets = { createTarget: async () => ({ pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }), navigate: async () => ({ ok: true, pageTargetRef: 'page:other', state: 'ready', diagnostics: [] }) };
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session, pageTargets, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', now: NOW },
  );
  assert.equal(result.outcome, 'discovery-failed');
  assert.equal(result.recheckCode, 'discovery-nav-failed');
  assert.deepEqual(calls, ['start', 'abort']); // the mismatched success never reaches capture
});

// Round 5 hardening alongside K4: if the capture flow's own stop() throws, the window opened
// by start() is still live -- the generic catch must abort it before the terminal markFailed.
test('a throw inside the capture flow aborts the still-open window and fails as discovery', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const calls = [];
  const session = {
    start: async () => calls.push('start'),
    abort: async () => calls.push('abort'),
    stop: async () => { calls.push('stop'); throw new Error('transport died mid-stop'); },
    listObservations: async () => [],
  };
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', now: NOW },
  );
  assert.equal(result.outcome, 'discovery-failed');
  assert.equal(result.recheckCode, 'discovery-error');
  assert.deepEqual(calls, ['start', 'stop', 'abort']); // stop failed -> abort before markFailed
});

// Codex re-review of PR #5 round 6 (P1): stale-target recreation is bound to the run's OWN
// intent URL (the intentSnapshot fixed at createRun). A caller with valid run/session/page
// refs must not be able to substitute a different URL and have an authenticated target
// recreated at that destination under a policy that approved the original intent (§9.5).
test('recreation is blocked when targetUrl is not the run original intent URL', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator); // intent: https://example.com/account
  let created = 0;
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('target-stale')), session: await startedSession([safeObs('o1')]),
      pageTargets: { createTarget: async () => { created += 1; return { pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }; } },
      recreationPolicy: () => true,
      sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://evil.example.com/account', daemonRef: DAEMON_REF, sideEffectInProgress: false, now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed'); // stale target, no recreation attempted
  assert.equal(created, 0);
});

// Same §9.5 binding, fail-closed side: a run whose intentSnapshot carries no URL target
// (missing / non-url kind) never authorizes recreation, whatever URL the caller supplies.
test('recreation is blocked when the run intent has no URL target (fail closed)', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator, 'run_ac_001', { target: { kind: 'app', value: 'https://example.com/account' } });
  let created = 0;
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('target-stale')), session: await startedSession([safeObs('o1')]),
      pageTargets: { createTarget: async () => { created += 1; return { pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }; } },
      recreationPolicy: () => true,
      sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: DAEMON_REF, sideEffectInProgress: false, now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(created, 0);
});

// Codex re-review of PR #5 round 6 (P2): a session WITHOUT the optional abort() must still
// tear the window down on a failed discovery navigation -- stop() ends the window and its
// result is DISCARDED (nothing normalized/recorded for the terminal run).
test('a session without abort tears the window down via stop() on navigation failure', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const calls = [];
  const session = {
    start: async () => calls.push('start'),
    // NO abort method on this session
    stop: async () => { calls.push('stop'); return { observations: [safeObs('o1')], diagnostics: [] }; },
    listObservations: async () => [],
  };
  const pageTargets = { createTarget: async () => ({ pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }), navigate: async () => ({ ok: false, pageTargetRef: 'page:t-1', state: 'stale', diagnostics: [] }) };
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker({ ok: true, confidence: 1, diagnostics: [] }), session, pageTargets, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', now: NOW },
  );
  assert.equal(result.outcome, 'discovery-failed');
  assert.equal(result.recheckCode, 'discovery-nav-failed');
  assert.deepEqual(calls, ['start', 'stop']); // window closed via the stop() fallback
  // the discarded stop() result was never recorded as evidence
  const events = (await checkpointStore.listEvents('run_ac_001')).map((e) => e.type);
  assert.equal(events.includes('evidence.normalized'), false);
});

// Codex re-review of PR #5 round 7 (P1): the WHOLE input is snapshotted before any work, so a
// stateful targetUrl GETTER cannot show the intent URL to the §9.5 comparison and a
// substituted destination to the later policy/createTarget/navigate reads.
test('a stateful targetUrl getter cannot pass intent binding and then substitute the URL', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator); // intent: https://example.com/account
  const recreatedObs = { ...safeObs('o1'), pageTargetRef: 'page:recreated-1' };
  const session = new BrowserNetworkCaptureSession({ collect: async () => [recreatedObs] });
  let recheckCalls = 0;
  const rechecker = new FakeBrowserAuthRechecker(() => (++recheckCalls === 1 ? authRecheckFailure('target-stale') : { ok: true, confidence: 1, diagnostics: [] }));
  const created = [];
  const navigations = [];
  const pageTargets = {
    createTarget: async (i) => { created.push(i.targetUrl); return { pageTargetRef: 'page:recreated-1', state: 'created', updatedAt: NOW }; },
    navigate: async (i) => { navigations.push(i.url); return { ok: true, pageTargetRef: i.pageTargetRef, state: 'ready', diagnostics: [] }; },
  };
  let reads = 0;
  const hostileInput = {
    runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1',
    get targetUrl() { reads += 1; return reads === 1 ? 'https://example.com/account' : 'https://evil.example.com/exfil'; },
    daemonRef: DAEMON_REF,
    sideEffectInProgress: false, now: NOW, completeRun: true,
  };
  const result = await resumeBrowserRun(
    { coordinator, rechecker, session, pageTargets, recreationPolicy: () => true, sessionRegistry: defaultRegistry() },
    hostileInput,
  );
  assert.equal(reads, 1); // the getter fired ONCE, during the input snapshot
  assert.equal(result.outcome, 'completed');
  // every browser call saw the SAME (intent) URL -- never the substituted one
  assert.deepEqual(created, ['https://example.com/account']);
  assert.deepEqual(navigations, ['https://example.com/account']);
});

// Codex re-review of PR #5 round 8 (P1): the entry snapshot also CANONICALIZES daemonRef.id
// to a primitive -- an object id with a stateful toString() could otherwise satisfy the J5
// comparison and then be re-converted inside createTarget/the transport to a foreign daemon.
test('a stateful daemonRef.id cannot pass the J5 check and recreate on a foreign daemon', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const recreatedObs = { ...safeObs('o1'), pageTargetRef: 'page:recreated-1' };
  const session = new BrowserNetworkCaptureSession({ collect: async () => [recreatedObs] });
  let recheckCalls = 0;
  const rechecker = new FakeBrowserAuthRechecker(() => (++recheckCalls === 1 ? authRecheckFailure('target-stale') : { ok: true, confidence: 1, diagnostics: [] }));
  const createdDaemonIds = [];
  const pageTargets = { createTarget: async (i) => { createdDaemonIds.push(i.daemonRef.id); return { pageTargetRef: 'page:recreated-1', state: 'created', updatedAt: NOW }; } };
  let conversions = 0;
  const shiftyId = { toString() { conversions += 1; return conversions === 1 ? DAEMON_ID : 'daemon_FOREIGN'; } };
  const result = await resumeBrowserRun(
    { coordinator, rechecker, session, pageTargets, recreationPolicy: () => true, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: { ...DAEMON_REF, id: shiftyId }, sideEffectInProgress: false, now: NOW, completeRun: true },
  );
  assert.equal(conversions, 1); // toString ran ONCE, in the snapshot
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(createdDaemonIds, [DAEMON_ID]); // the controller saw the SAME primitive the J5 check approved
});

// Codex re-review of PR #5 rounds 9+10 (P1): a substituted URL is refused BEFORE any browser
// work at all. Round 9 checked it after the recheck, but a real rechecker's probe NAVIGATES
// using targetUrl -- so the unsafe action had already happened. The gate now precedes the
// recheck: no probe, no navigation, no capture window.
test('a substituted URL is refused before the recheck probe ever runs', async () => {
  const { checkpointStore, coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator); // intent: https://example.com/account
  const calls = [];
  const session = {
    start: async () => calls.push('start'),
    abort: async () => calls.push('abort'),
    stop: async () => { calls.push('stop'); return { observations: [], diagnostics: [] }; },
    listObservations: async () => [],
  };
  let recheckCalls = 0;
  const rechecker = new FakeBrowserAuthRechecker(() => { recheckCalls += 1; return { ok: true, confidence: 1, diagnostics: [] }; });
  const navigations = [];
  const pageTargets = { createTarget: async () => ({ pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }), navigate: async (i) => { navigations.push(i.url); return { ok: true, pageTargetRef: i.pageTargetRef, state: 'ready', diagnostics: [] }; } };
  const result = await resumeBrowserRun(
    { coordinator, rechecker, session, pageTargets, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://evil.example.com/exfil', now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.equal(result.recheckCode, 'url-not-intent');
  assert.equal(recheckCalls, 0); // the rechecker (and therefore its navigating probe) never ran
  assert.deepEqual(navigations, []);
  assert.deepEqual(calls, []); // no capture window
  const events = (await checkpointStore.listEvents('run_ac_001')).map((e) => e.type);
  assert.equal(events.includes('auth.rechecked'), false);
  assert.equal(events.includes('evidence.normalized'), false);
});

// Codex re-review of PR #5 round 9 (P2): successful recreation CLOSES the dead stale target
// (navigate only marks it stale) so repeated stale resumes do not accumulate live pages; a
// failing close does not fail the recovered resume.
test('recreation closes the dead stale target best-effort', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const recreatedObs = { ...safeObs('o1'), pageTargetRef: 'page:recreated-1' };
  const session = new BrowserNetworkCaptureSession({ collect: async () => [recreatedObs] });
  let recheckCalls = 0;
  const rechecker = new FakeBrowserAuthRechecker(() => (++recheckCalls === 1 ? authRecheckFailure('target-stale') : { ok: true, confidence: 1, diagnostics: [] }));
  const closed = [];
  const pageTargets = {
    createTarget: async () => ({ pageTargetRef: 'page:recreated-1', state: 'created', updatedAt: NOW }),
    closeTarget: async (ref) => { closed.push(ref); throw new Error('close hiccup'); }, // even a FAILING close is tolerated
  };
  const result = await resumeBrowserRun(
    { coordinator, rechecker, session, pageTargets, recreationPolicy: () => true, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: DAEMON_REF, sideEffectInProgress: false, now: NOW, completeRun: true },
  );
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(closed, ['page:t-1']); // the DEAD stale target was closed, not the replacement
});

// Codex re-review of PR #5 round 10 (P2): createTarget can legitimately resolve with a
// stale/closed snapshot when a concurrent lifecycle op changes the reserved target. Rebinding
// the authoritative session to that dead target (and closing the old one) would strand the
// session, so an unusable snapshot is refused BEFORE any rebind or close.
test('an unusable recreation snapshot is refused before the registry is rebound', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const closed = [];
  const registry = defaultRegistry();
  const pageTargets = {
    createTarget: async () => ({ pageTargetRef: 'page:recreated-1', state: 'stale', updatedAt: NOW }), // lost the race
    closeTarget: async (ref) => { closed.push(ref); },
  };
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('target-stale')), session: await startedSession([safeObs('o1')]), pageTargets, recreationPolicy: () => true, sessionRegistry: registry },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: DAEMON_REF, sideEffectInProgress: false, now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.deepEqual(registry.updates, []); // never rebound to the unusable target
  assert.deepEqual(closed, []); // and the original was NOT closed
});

// Codex re-review of PR #5 round 10 (P2): when the post-recreation retry recheck fails, the
// REPLACEMENT target must be closed too -- otherwise repeated failed recreations accumulate
// live browser pages even though the original is closed at creation time.
test('a failed retry after recreation closes the replacement target', async () => {
  const { coordinator } = makeCoordinator();
  const { requestId, completed } = await toCompletedIntervention(coordinator);
  const closed = [];
  const pageTargets = {
    createTarget: async () => ({ pageTargetRef: 'page:recreated-1', state: 'created', updatedAt: NOW }),
    closeTarget: async (ref) => { closed.push(ref); },
  };
  // BOTH rechecks report target-stale: recreation runs once, then the retry fails.
  const result = await resumeBrowserRun(
    { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('target-stale')), session: await startedSession([safeObs('o1')]), pageTargets, recreationPolicy: () => true, sessionRegistry: defaultRegistry() },
    { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: DAEMON_REF, sideEffectInProgress: false, now: NOW },
  );
  assert.equal(result.outcome, 'recheck-failed');
  assert.deepEqual(closed, ['page:t-1', 'page:recreated-1']); // original at creation, replacement on failure
});

// Codex re-review of PR #5 round 10 (P1): the J5 daemon binding covers EVERY transport-
// relevant field, not just the id. Reusing the approved id while swapping the endpoint to a
// different (even loopback) daemon, or changing the mode, must block recreation.
test('recreation is blocked when a transport-relevant daemon field is substituted', async () => {
  for (const hostile of [
    { ...DAEMON_REF, healthUrlPreview: 'http://127.0.0.1:9333' }, // different loopback daemon
    { ...DAEMON_REF, healthUrlPreview: 'http://evil.example.com:9222' }, // remote endpoint
    { ...DAEMON_REF, mode: 'shared-daemon' }, // mode the registry never approved
  ]) {
    const { coordinator } = makeCoordinator();
    const { requestId, completed } = await toCompletedIntervention(coordinator);
    let created = 0;
    const result = await resumeBrowserRun(
      { coordinator, rechecker: new FakeBrowserAuthRechecker(authRecheckFailure('target-stale')), session: await startedSession([safeObs('o1')]),
        pageTargets: { createTarget: async () => { created += 1; return { pageTargetRef: 'page:x', state: 'created', updatedAt: NOW }; } },
        recreationPolicy: () => true, sessionRegistry: defaultRegistry() },
      { runId: 'run_ac_001', expectedVersion: completed.checkpoint.version, requestId, browserSessionRef: 'session:abc-1', pageTargetRef: 'page:t-1', targetUrl: 'https://example.com/account', daemonRef: hostile, sideEffectInProgress: false, now: NOW },
    );
    assert.equal(created, 0, `recreation must be blocked for ${JSON.stringify(hostile)}`);
    assert.equal(result.outcome, 'recheck-failed');
  }
});
