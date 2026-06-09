'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runBrowserNetworkCaptureFlow, BrowserNetworkCaptureSession } = require('../dist/browser');

function safeObs(id, over = {}) {
  return {
    id,
    runId: 'run_1',
    source: 'cdp',
    capturedAt: '2026-01-01T00:00:00.000Z',
    request: { url: 'https://api.example.com/v1/users', method: 'GET', queryParamNames: ['page'], ...(over.request || {}) },
    response: { status: 200, mimeType: 'application/json' },
    timing: { startedAt: '2026-01-01T00:00:01.000Z', durationMs: 5 },
  };
}

async function startedSession(observations) {
  const session = new BrowserNetworkCaptureSession({ collect: async () => observations });
  await session.start({ runId: 'run_1', pageTargetRef: 'page:t-1' });
  return session;
}

function fakeCoordinator() {
  const calls = [];
  return {
    calls,
    recordNormalizedEvidence: async (input) => {
      calls.push(input);
      return { runId: input.runId, version: input.expectedVersion + 1, status: 'running', phase: input.phase };
    },
  };
}

test('runtime capture flow records evidence through the coordinator', async () => {
  const session = await startedSession([safeObs('o1'), safeObs('o2')]);
  const coordinator = fakeCoordinator();
  const result = await runBrowserNetworkCaptureFlow(
    { session, coordinator },
    { runId: 'run_1', pageTargetRef: 'page:t-1', expectedVersion: 3, now: '2026-01-01T00:00:02.000Z', targetUrl: 'https://api.example.com' },
  );
  assert.equal(result.recorded, true);
  assert.equal(coordinator.calls.length, 1);
  assert.ok(result.evidenceCount >= 1);
  assert.equal(coordinator.calls[0].evidenceRefs.length, result.evidenceCount);
  assert.equal(coordinator.calls[0].phase, 'normalizing_evidence');
  assert.ok(result.checkpoint);
  // nothing secret reaches what the coordinator persists
  assert.equal(JSON.stringify(coordinator.calls[0]).includes('SECRET'), false);
});

test('failed evidence validation does not record (run not advanced)', async () => {
  const session = await startedSession([safeObs('o1')]);
  const coordinator = fakeCoordinator();
  const normalize = () => ({
    evidence: [],
    diagnostics: [{ level: 'error', code: 'INVALID_EVIDENCE', entryId: 'e', errors: ['bad shape'] }],
    skipped: [{ index: 0, reason: 'invalid-evidence' }],
  });
  const result = await runBrowserNetworkCaptureFlow({ session, coordinator, normalize }, { runId: 'run_1', pageTargetRef: 'page:t-1', expectedVersion: 3 });
  assert.equal(result.recorded, false);
  assert.equal(coordinator.calls.length, 0);
  assert.equal(result.evidenceCount, 0);
});

test('a secret-bearing (unsanitized) observation is gated out and never reaches the coordinator', async () => {
  // a query string in request.url violates the observation invariant (isSanitizedUrlField
  // forbids '?'), so the session's assertSafeBrowserObservation gate EXCLUDES it -> the
  // secret never flows into the map/normalize/coordinator path (exit criteria 7.7).
  const leaky = {
    id: 'leak',
    runId: 'run_1',
    source: 'cdp',
    capturedAt: '2026-01-01T00:00:00.000Z',
    request: { url: 'https://api.example.com/v1/users?access_token=SUPERSECRETVALUE', method: 'GET' },
  };
  const session = await startedSession([safeObs('ok'), leaky]);
  const coordinator = fakeCoordinator();
  const result = await runBrowserNetworkCaptureFlow({ session, coordinator }, { runId: 'run_1', pageTargetRef: 'page:t-1', expectedVersion: 3 });
  assert.equal(result.evidenceCount, 1); // only the safe observation produced evidence
  assert.equal(JSON.stringify(coordinator.calls[0]).includes('SUPERSECRETVALUE'), false);
  assert.equal(JSON.stringify(result).includes('SUPERSECRETVALUE'), false);
});

test('flow drops unmappable (url-less) observations and counts them', async () => {
  const noUrl = { id: 'nourl', runId: 'run_1', source: 'cdp', capturedAt: '2026-01-01T00:00:00.000Z', request: { method: 'GET' } };
  const session = await startedSession([safeObs('o1'), noUrl]);
  const coordinator = fakeCoordinator();
  const result = await runBrowserNetworkCaptureFlow({ session, coordinator }, { runId: 'run_1', pageTargetRef: 'page:t-1', expectedVersion: 3 });
  assert.equal(result.recorded, true);
  assert.equal(result.evidenceCount, 1);
  assert.equal(coordinator.calls[0].eventData.unmappableObservationCount, 1);
});
