import type { NetworkEvidenceNormalizerInput, NetworkEvidenceNormalizerResult, RawNetworkEntry } from '../discovery/network';
import { normalizeNetworkEvidence } from '../discovery/network';
import type { CheckpointStore } from './checkpointStore';
import type { RuntimeCoordinator } from './runtimeCoordinator';
import type {
  HumanInterventionCompletedBy,
  HumanInterventionCompletionResult,
  HumanInterventionKind,
  HumanInterventionRequest,
  RunCheckpoint,
  RuntimeDiagnostic,
  RuntimeEvent,
  RuntimeSafeData,
} from './types';

export type DeterministicSimulationClock = {
  createdAt?: string;
  runningAt?: string;
  interventionRequestedAt?: string;
  interventionCompletedAt?: string;
  resumedAt?: string;
  authRecheckedAt?: string;
  evidenceNormalizedAt?: string;
  completedAt?: string;
  failedAt?: string;
};

export type DeterministicHumanInterventionFixture = {
  kind?: HumanInterventionKind;
  reason?: string;
  instructions?: readonly string[];
  timeoutMs?: number;
  url?: string;
  safeToRetry?: boolean;
};

export type DeterministicAuthenticatedSimulationFixture = {
  runId: string;
  targetUrl: string;
  intentSnapshot: unknown;
  browserSessionRef?: string;
  preAuthEvidenceRefs?: readonly string[];
  preAuthArtifactRefs?: readonly string[];
  networkEntries: readonly RawNetworkEntry[];
  intentId?: string;
  humanIntervention?: DeterministicHumanInterventionFixture;
  clock?: DeterministicSimulationClock;
};

export type DeterministicAuthenticatedSimulationDeps = {
  coordinator: RuntimeCoordinator;
  checkpointStore: CheckpointStore;
  normalizeEvidence?: (input: NetworkEvidenceNormalizerInput) => NetworkEvidenceNormalizerResult;
};

export type DeterministicAuthStateRecheck =
  | { ok: true; diagnostics?: readonly RuntimeDiagnostic[] }
  | { ok: false; code?: string; message?: string; diagnostics?: readonly RuntimeDiagnostic[] };

export type DeterministicAuthenticatedSimulationOptions = {
  humanCompletion?: {
    result?: HumanInterventionCompletionResult;
    completedBy?: HumanInterventionCompletedBy;
    resumeTokenOverride?: string;
    notes?: string;
  };
  authStateRecheck?: DeterministicAuthStateRecheck;
};

export type DeterministicAuthenticatedSimulationOutcome =
  | 'completed'
  | 'failed-auth-recheck'
  | 'human-cancelled'
  | 'human-unsafe'
  | 'human-expired';

export type DeterministicAuthenticatedSimulationResult = {
  outcome: DeterministicAuthenticatedSimulationOutcome;
  checkpoints: {
    created: RunCheckpoint;
    running: RunCheckpoint;
    waiting: RunCheckpoint;
    afterHumanCompletion: RunCheckpoint;
    resumed?: RunCheckpoint;
    authRechecked?: RunCheckpoint;
    evidenceNormalized?: RunCheckpoint;
    final: RunCheckpoint;
  };
  intervention: {
    request: HumanInterventionRequest;
    afterCompletion: HumanInterventionRequest;
  };
  normalizedEvidence: NetworkEvidenceNormalizerResult;
  events: RuntimeEvent[];
};

function emptyNormalizedEvidence(): NetworkEvidenceNormalizerResult {
  return {
    evidence: [],
    diagnostics: [],
    skipped: [],
  };
}

function defaultHumanCompletionActor(result: HumanInterventionCompletionResult): HumanInterventionCompletedBy {
  return result === 'expired' ? 'system' : 'human';
}

function outcomeForHumanResult(result: HumanInterventionCompletionResult): DeterministicAuthenticatedSimulationOutcome | undefined {
  if (result === 'completed') return undefined;
  if (result === 'cancelled') return 'human-cancelled';
  if (result === 'unsafe') return 'human-unsafe';
  return 'human-expired';
}

function mergeRefs(existingRefs: readonly string[], newRefs: readonly string[]): string[] {
  return [...new Set([...existingRefs, ...newRefs])];
}

function runtimeDataFromNormalizerDiagnostic(diagnostic: NetworkEvidenceNormalizerResult['diagnostics'][number]): Record<string, RuntimeSafeData> {
  const data: Record<string, RuntimeSafeData> = {};
  if (diagnostic.entryId) data.entryId = diagnostic.entryId;
  if (diagnostic.category) data.category = diagnostic.category;
  if (diagnostic.errors?.length) data.errors = [...diagnostic.errors];
  return data;
}

function diagnosticsFromNormalizer(result: NetworkEvidenceNormalizerResult, at: string | undefined): RuntimeDiagnostic[] {
  return result.diagnostics.map((diagnostic) => ({
    level: diagnostic.level,
    code: `network.${diagnostic.code.toLowerCase().replaceAll('_', '-')}`,
    message: `Network evidence normalization: ${diagnostic.code}`,
    ...(at ? { at } : {}),
    data: runtimeDataFromNormalizerDiagnostic(diagnostic),
  }));
}

export async function runDeterministicAuthenticatedSimulation(
  deps: DeterministicAuthenticatedSimulationDeps,
  fixture: DeterministicAuthenticatedSimulationFixture,
  options: DeterministicAuthenticatedSimulationOptions = {},
): Promise<DeterministicAuthenticatedSimulationResult> {
  const normalizeEvidence = deps.normalizeEvidence ?? normalizeNetworkEvidence;
  const humanIntervention = fixture.humanIntervention ?? {};
  const completionResult = options.humanCompletion?.result ?? 'completed';
  const completedBy = options.humanCompletion?.completedBy ?? defaultHumanCompletionActor(completionResult);
  const clock = fixture.clock ?? {};

  const created = await deps.coordinator.createRun({
    runId: fixture.runId,
    intentSnapshot: fixture.intentSnapshot,
    artifactRefs: [...(fixture.preAuthArtifactRefs ?? [])],
    now: clock.createdAt,
  });

  const running = await deps.coordinator.markRunning({
    runId: fixture.runId,
    expectedVersion: created.version,
    phase: 'auth_boundary_detected',
    browserSessionRef: fixture.browserSessionRef,
    evidenceRefs: [...(fixture.preAuthEvidenceRefs ?? []), 'evidence_auth_boundary'],
    artifactRefs: created.artifactRefs,
    lastCompletedStepId: 'target_opened',
    now: clock.runningAt,
    eventData: {
      action: 'targetOpenedAndAuthBoundaryDetected',
      targetUrl: fixture.targetUrl,
    },
  });

  const requested = await deps.coordinator.requestHumanIntervention({
    runId: fixture.runId,
    expectedVersion: running.version,
    kind: humanIntervention.kind ?? 'login-required',
    reason: humanIntervention.reason ?? 'Authenticated access is required before deterministic evidence discovery can continue.',
    instructions: humanIntervention.instructions ?? ['Complete the login in the controlled browser.', 'Return when the authenticated page is ready.'],
    nextStepId: 'auth_state_recheck',
    timeoutMs: humanIntervention.timeoutMs,
    url: humanIntervention.url ?? fixture.targetUrl,
    safeToRetry: humanIntervention.safeToRetry,
    browserSessionRef: fixture.browserSessionRef,
    lastCompletedStepId: 'auth_boundary_detected',
    now: clock.interventionRequestedAt,
  });

  const afterHuman = await deps.coordinator.completeHumanIntervention({
    runId: fixture.runId,
    requestId: String(requested.request.id),
    expectedVersion: requested.checkpoint.version,
    resumeToken: options.humanCompletion?.resumeTokenOverride ?? requested.resumeToken,
    result: completionResult,
    completedBy,
    browserSessionRef: fixture.browserSessionRef,
    notes: options.humanCompletion?.notes,
    completedAt: clock.interventionCompletedAt,
  });

  const humanOutcome = outcomeForHumanResult(completionResult);
  if (humanOutcome) {
    return {
      outcome: humanOutcome,
      checkpoints: {
        created,
        running,
        waiting: requested.checkpoint,
        afterHumanCompletion: afterHuman.checkpoint,
        final: afterHuman.checkpoint,
      },
      intervention: {
        request: requested.request,
        afterCompletion: afterHuman.request,
      },
      normalizedEvidence: emptyNormalizedEvidence(),
      events: await deps.checkpointStore.listEvents(fixture.runId),
    };
  }

  const resumed = await deps.coordinator.resumeRun({
    runId: fixture.runId,
    requestId: String(requested.request.id),
    expectedVersion: afterHuman.checkpoint.version,
    now: clock.resumedAt,
  });

  const authStateRecheck = options.authStateRecheck ?? { ok: true };
  if (!authStateRecheck.ok) {
    const failed = await deps.coordinator.markFailed({
      runId: fixture.runId,
      expectedVersion: resumed.version,
      now: clock.failedAt,
      code: authStateRecheck.code ?? 'auth-state-recheck-failed',
      message: authStateRecheck.message ?? 'Authenticated state recheck failed after human intervention.',
      diagnostics: authStateRecheck.diagnostics,
      eventData: {
        stepId: 'auth_state_recheck',
        authStateRecheck: 'failed',
      },
    });

    return {
      outcome: 'failed-auth-recheck',
      checkpoints: {
        created,
        running,
        waiting: requested.checkpoint,
        afterHumanCompletion: afterHuman.checkpoint,
        resumed,
        final: failed,
      },
      intervention: {
        request: requested.request,
        afterCompletion: afterHuman.request,
      },
      normalizedEvidence: emptyNormalizedEvidence(),
      events: await deps.checkpointStore.listEvents(fixture.runId),
    };
  }

  const authRechecked = await deps.coordinator.confirmResumeAuthRecheck({
    runId: fixture.runId,
    expectedVersion: resumed.version,
    now: clock.authRecheckedAt,
    phase: 'discovering_network',
    browserSessionRef: fixture.browserSessionRef,
    diagnostics: authStateRecheck.diagnostics,
    eventData: {
      authStateRecheck: 'passed',
    },
  });

  const normalizedEvidence = normalizeEvidence({
    entries: [...fixture.networkEntries],
    targetUrl: fixture.targetUrl,
    intentId: fixture.intentId,
    runId: fixture.runId,
  });
  const normalizedEvidenceRefs = normalizedEvidence.evidence.map((evidence) => evidence.evidenceId);
  const evidenceRefs = mergeRefs(authRechecked.evidenceRefs, normalizedEvidenceRefs);

  const evidenceNormalized = await deps.coordinator.recordNormalizedEvidence({
    runId: fixture.runId,
    expectedVersion: authRechecked.version,
    now: clock.evidenceNormalizedAt,
    phase: 'normalizing_evidence',
    evidenceRefs,
    artifactRefs: authRechecked.artifactRefs,
    diagnostics: diagnosticsFromNormalizer(normalizedEvidence, clock.evidenceNormalizedAt),
    lastCompletedStepId: 'discovering_network',
    eventData: {
      evidenceCount: normalizedEvidence.evidence.length,
      skippedCount: normalizedEvidence.skipped.length,
    },
  });

  const final = await deps.coordinator.markCompleted({
    runId: fixture.runId,
    expectedVersion: evidenceNormalized.version,
    now: clock.completedAt,
    evidenceRefs: evidenceNormalized.evidenceRefs,
    artifactRefs: evidenceNormalized.artifactRefs,
    lastCompletedStepId: 'normalizing_evidence',
    eventData: {
      evidenceRefCount: evidenceNormalized.evidenceRefs.length,
    },
  });

  return {
    outcome: 'completed',
    checkpoints: {
      created,
      running,
      waiting: requested.checkpoint,
      afterHumanCompletion: afterHuman.checkpoint,
      resumed,
      authRechecked,
      evidenceNormalized,
      final,
    },
    intervention: {
      request: requested.request,
      afterCompletion: afterHuman.request,
    },
    normalizedEvidence,
    events: await deps.checkpointStore.listEvents(fixture.runId),
  };
}
