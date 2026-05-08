import type { HumanInterventionRequest, RunCheckpoint, RuntimeEvent } from './types';

const baseCheckpoint = {
  runId: 'run_type_fixture',
  intentSnapshot: { target: { kind: 'url', value: 'https://example.com/account' } },
  evidenceRefs: [] as string[],
  artifactRefs: [] as string[],
  resumeAttempts: 0,
  version: 1,
  diagnostics: [],
  createdAt: '2026-04-30T08:00:00.000Z',
  updatedAt: '2026-04-30T08:00:00.000Z',
};

export const waitingCheckpointFixture: RunCheckpoint = {
  ...baseCheckpoint,
  status: 'waiting_for_human',
  phase: 'waiting_for_human',
  pendingInterventionId: 'intervention_type_fixture',
  nextStepId: 'auth_state_recheck',
  resumeTokenHash: 'sha256:hash-only',
  expiresAt: '2026-04-30T08:15:00.000Z',
};

export const completedCheckpointFixture: RunCheckpoint = {
  ...baseCheckpoint,
  status: 'completed',
  phase: 'terminal',
};

// @ts-expect-error waiting checkpoints must name the deterministic next step.
export const invalidWaitingCheckpointFixture: RunCheckpoint = {
  ...baseCheckpoint,
  status: 'waiting_for_human',
  phase: 'waiting_for_human',
  pendingInterventionId: 'intervention_type_fixture',
  resumeTokenHash: 'sha256:hash-only',
  expiresAt: '2026-04-30T08:15:00.000Z',
};

// @ts-expect-error terminal checkpoints must use the terminal phase.
export const invalidTerminalCheckpointFixture: RunCheckpoint = {
  ...baseCheckpoint,
  status: 'completed',
  phase: 'finalizing',
};

export const pendingInterventionFixture: HumanInterventionRequest = {
  id: 'intervention_type_fixture',
  runId: 'run_type_fixture',
  kind: 'login-required',
  status: 'pending',
  reason: 'Authenticated access is required.',
  instructions: ['Complete login in the browser.'],
  resumeTokenPreview: 'rt_1234…abcd',
  resumeTokenHash: 'sha256:hash-only',
  safeToRetry: true,
  timeoutMs: 900000,
  createdAt: '2026-04-30T08:00:00.000Z',
  expiresAt: '2026-04-30T08:15:00.000Z',
};

export const completedInterventionFixture: HumanInterventionRequest = {
  ...pendingInterventionFixture,
  status: 'completed',
  completedAt: '2026-04-30T08:05:00.000Z',
};

// @ts-expect-error pending intervention requests cannot already have completion metadata.
export const invalidPendingInterventionFixture: HumanInterventionRequest = {
  ...pendingInterventionFixture,
  completedAt: '2026-04-30T08:05:00.000Z',
};

// @ts-expect-error completed intervention requests must include completedAt.
export const invalidCompletedInterventionFixture: HumanInterventionRequest = {
  ...pendingInterventionFixture,
  status: 'completed',
};

export const safeRuntimeEventFixture: RuntimeEvent = {
  id: 'event_type_fixture',
  runId: 'run_type_fixture',
  type: 'intervention.requested',
  at: '2026-04-30T08:00:00.000Z',
  data: {
    requestId: 'intervention_type_fixture',
    resumeTokenPreview: 'rt_1234…abcd',
    url: 'https://example.com/login',
  },
};

export const invalidRuntimeEventFixture: RuntimeEvent = {
  ...safeRuntimeEventFixture,
  data: {
    // @ts-expect-error event data must be JSON-safe redacted data, not arbitrary objects.
    leakedDateObject: new Date('2026-04-30T08:00:00.000Z'),
  },
};
