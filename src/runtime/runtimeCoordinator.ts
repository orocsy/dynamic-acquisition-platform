import { randomUUID } from 'node:crypto';
import type { CheckpointStore } from './checkpointStore';
import {
  expiresAtFromTimeout,
  hasMeaningfulInstructions,
  resolveHumanInterventionTimeoutMs,
  type ResumeTokenIssuer,
  type RuntimeCoordinatorCompleteHumanInterventionInput,
  type RuntimeCoordinatorCompleteHumanInterventionResult,
  type RuntimeCoordinatorRequestHumanInterventionInput,
  type RuntimeCoordinatorRequestHumanInterventionResult,
  type RuntimeCoordinatorResumeRunInput,
} from './humanIntervention';
import type { InterventionStore } from './interventionStore';
import { assertDefaultResumeEntryStep } from './resumePolicy';
import { issueResumeToken, verifyResumeToken } from './resumeToken';
import { RuntimeCoordinatorError, isRuntimeStoreError } from './runtimeErrors';
import {
  TERMINAL_RUN_STATUSES,
  type CheckpointPatch,
  type HumanInterventionRequest,
  type PendingHumanInterventionRequest,
  type RunCheckpoint,
  type RunPhase,
  type RunStatus,
  type RuntimeDiagnostic,
  type RuntimeEvent,
  type RuntimeEventType,
  type RuntimeSafeData,
} from './types';

export type RuntimeClock = () => string;
export type RuntimeIdKind = 'event' | 'intervention';
export type RuntimeIdFactory = (kind: RuntimeIdKind) => string;

export type RuntimeCoordinatorOptions = {
  checkpointStore: CheckpointStore;
  interventionStore?: InterventionStore;
  clock?: RuntimeClock;
  idFactory?: RuntimeIdFactory;
  resumeTokenIssuer?: ResumeTokenIssuer;
};

export type RuntimeCoordinatorCreateRunInput = {
  runId: string;
  intentSnapshot: unknown;
  phase?: Exclude<RunPhase, 'terminal' | 'waiting_for_human'>;
  evidenceRefs?: readonly string[];
  artifactRefs?: readonly string[];
  browserSessionRef?: string;
  diagnostics?: readonly RuntimeDiagnostic[];
  now?: string;
};

export type RuntimeCoordinatorTransitionInput = {
  runId: string;
  expectedVersion: number;
  now?: string;
  phase?: RunPhase;
  evidenceRefs?: readonly string[];
  artifactRefs?: readonly string[];
  browserSessionRef?: string;
  lastCompletedStepId?: string;
  diagnostics?: readonly RuntimeDiagnostic[];
  eventData?: Record<string, RuntimeSafeData>;
};

export type RuntimeCoordinatorFailureInput = RuntimeCoordinatorTransitionInput & {
  code?: string;
  message?: string;
  data?: Record<string, RuntimeSafeData>;
};

type TransitionConfig = {
  toStatus: RunStatus;
  toPhase: RunPhase | ((checkpoint: RunCheckpoint, input: RuntimeCoordinatorTransitionInput) => RunPhase);
  eventType: RuntimeEventType;
  allowedFrom: readonly RunStatus[];
  defaultEventData?: Record<string, RuntimeSafeData>;
  clearPendingResumeFields?: boolean;
};

function defaultIdFactory(kind: RuntimeIdKind): string {
  return `${kind}_${randomUUID()}`;
}

function defaultClock(): string {
  return new Date().toISOString();
}

function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status as (typeof TERMINAL_RUN_STATUSES)[number]);
}

function cloneDiagnostics(diagnostics: readonly RuntimeDiagnostic[] | undefined): RuntimeDiagnostic[] | undefined {
  return diagnostics ? diagnostics.map((diagnostic) => ({ ...diagnostic, data: diagnostic.data ? { ...diagnostic.data } : undefined })) : undefined;
}

function assertPhaseAllowedForStatus(status: RunStatus, phase: RunPhase): void {
  if (isTerminalStatus(status)) {
    if (phase !== 'terminal') {
      throw new RuntimeCoordinatorError('invalid-transition', `terminal status ${status} must use terminal phase`, {
        level: 'error',
        code: 'invalid-transition',
        message: `Rejected transition to ${status}: terminal run states must use terminal phase.`,
        data: { toStatus: status, toPhase: phase },
      });
    }
    return;
  }

  if (phase === 'terminal') {
    throw new RuntimeCoordinatorError('invalid-transition', `non-terminal status ${status} cannot use terminal phase`, {
      level: 'error',
      code: 'invalid-transition',
      message: `Rejected transition to ${status}: terminal phase is reserved for terminal run states.`,
      data: { toStatus: status, toPhase: phase },
    });
  }

  if (status !== 'expired' && status !== 'waiting_for_human' && phase === 'waiting_for_human') {
    throw new RuntimeCoordinatorError('invalid-transition', `status ${status} cannot use waiting_for_human phase`, {
      level: 'error',
      code: 'invalid-transition',
      message: `Rejected transition to ${status}: waiting_for_human phase is reserved for waits/expiry audit state.`,
      data: { toStatus: status, toPhase: phase },
    });
  }
}

function buildFailureDiagnostic(input: RuntimeCoordinatorFailureInput, at: string): RuntimeDiagnostic | undefined {
  if (!input.message && !input.code && !input.data) return undefined;
  return {
    level: 'error',
    code: input.code ?? 'run-failed',
    message: input.message ?? 'Run failed.',
    at,
    data: input.data,
  };
}

function assertNonEmptyHumanInterventionInput(input: RuntimeCoordinatorRequestHumanInterventionInput): void {
  const timeoutMs = resolveHumanInterventionTimeoutMs(input.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RuntimeCoordinatorError('invalid-transition', 'human intervention timeoutMs must be positive', {
      level: 'error',
      code: 'invalid-transition',
      message: 'Rejected human intervention request: timeoutMs must be a positive number.',
      data: { runId: input.runId, timeoutMs },
    });
  }

  if (!input.reason.trim()) {
    throw new RuntimeCoordinatorError('invalid-transition', 'human intervention reason is required', {
      level: 'error',
      code: 'invalid-transition',
      message: 'Rejected human intervention request: reason is required.',
      data: { runId: input.runId },
    });
  }

  if (!hasMeaningfulInstructions(input.instructions)) {
    throw new RuntimeCoordinatorError('invalid-transition', 'human intervention instructions are required', {
      level: 'error',
      code: 'invalid-transition',
      message: 'Rejected human intervention request: at least one instruction is required.',
      data: { runId: input.runId },
    });
  }

  if (!input.nextStepId.trim()) {
    throw new RuntimeCoordinatorError('invalid-transition', 'human intervention nextStepId is required', {
      level: 'error',
      code: 'invalid-transition',
      message: 'Rejected human intervention request: nextStepId is required.',
      data: { runId: input.runId },
    });
  }
}

function resolveHumanInterventionExpiresAt(input: RuntimeCoordinatorRequestHumanInterventionInput, now: string, timeoutMs: number): string {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new RuntimeCoordinatorError('invalid-transition', 'human intervention clock produced an invalid timestamp', {
      level: 'error',
      code: 'invalid-transition',
      message: 'Rejected human intervention request: current timestamp is invalid.',
      data: { runId: input.runId, now },
    });
  }

  const expiresAt = input.expiresAt ?? expiresAtFromTimeout(now, timeoutMs);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new RuntimeCoordinatorError('invalid-transition', 'human intervention expiresAt must be after now', {
      level: 'error',
      code: 'invalid-transition',
      message: 'Rejected human intervention request: expiresAt must be a valid future timestamp.',
      data: { runId: input.runId, now, expiresAt },
    });
  }

  return expiresAt;
}

function assertPendingRequest(request: HumanInterventionRequest): asserts request is PendingHumanInterventionRequest {
  if (request.status === 'pending') return;

  throw new RuntimeCoordinatorError('invalid-transition', `intervention ${request.id} is already ${request.status}`, {
    level: 'error',
    code: 'invalid-transition',
    message: 'Rejected human intervention completion: request is not pending.',
    data: { runId: String(request.runId), requestId: String(request.id), status: request.status },
  });
}

function humanOutcomeDiagnostic(input: RuntimeCoordinatorCompleteHumanInterventionInput, at: string): RuntimeDiagnostic | undefined {
  if (input.result === 'completed') return undefined;

  if (input.result === 'unsafe') {
    return {
      level: 'error',
      code: 'unsafe-human-result',
      message: 'Human intervention was marked unsafe; run was cancelled instead of resumed.',
      at,
      data: { runId: input.runId, requestId: input.requestId, completedBy: input.completedBy, hasNotes: Boolean(input.notes) },
    };
  }

  if (input.result === 'expired') {
    return {
      level: 'warning',
      code: 'intervention-expired',
      message: 'Human intervention expired before a safe resume.',
      at,
      data: { runId: input.runId, requestId: input.requestId, completedBy: input.completedBy },
    };
  }

  return {
    level: 'info',
    code: 'human-intervention-cancelled',
    message: 'Human intervention was cancelled; run was cancelled instead of resumed.',
    at,
    data: { runId: input.runId, requestId: input.requestId, completedBy: input.completedBy, hasNotes: Boolean(input.notes) },
  };
}

export class RuntimeCoordinator {
  readonly #checkpointStore: CheckpointStore;
  readonly #interventionStore?: InterventionStore;
  readonly #clock: RuntimeClock;
  readonly #idFactory: RuntimeIdFactory;
  readonly #resumeTokenIssuer: ResumeTokenIssuer;

  constructor(options: RuntimeCoordinatorOptions) {
    this.#checkpointStore = options.checkpointStore;
    this.#interventionStore = options.interventionStore;
    this.#clock = options.clock ?? defaultClock;
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#resumeTokenIssuer = options.resumeTokenIssuer ?? issueResumeToken;
  }

  async createRun(input: RuntimeCoordinatorCreateRunInput): Promise<RunCheckpoint> {
    const now = input.now ?? this.#clock();
    const phase = input.phase ?? 'intent_accepted';
    assertPhaseAllowedForStatus('created', phase);

    const checkpoint: RunCheckpoint = {
      runId: input.runId,
      status: 'created',
      phase,
      intentSnapshot: input.intentSnapshot,
      evidenceRefs: [...(input.evidenceRefs ?? [])],
      artifactRefs: [...(input.artifactRefs ?? [])],
      ...(input.browserSessionRef ? { browserSessionRef: input.browserSessionRef } : {}),
      resumeAttempts: 0,
      version: 1,
      diagnostics: cloneDiagnostics(input.diagnostics) ?? [],
      createdAt: now,
      updatedAt: now,
    };

    const createdEvent: RuntimeEvent = {
      id: this.#idFactory('event'),
      runId: checkpoint.runId,
      type: 'run.created',
      at: now,
      data: {
        status: checkpoint.status,
        phase: checkpoint.phase,
        evidenceRefCount: checkpoint.evidenceRefs.length,
        artifactRefCount: checkpoint.artifactRefs.length,
      },
    };

    return this.#createCheckpoint(checkpoint, createdEvent);
  }

  async markRunning(input: RuntimeCoordinatorTransitionInput): Promise<RunCheckpoint> {
    return this.#transition(input, {
      toStatus: 'running',
      toPhase: (_checkpoint, transitionInput) => transitionInput.phase ?? 'target_opened',
      eventType: 'checkpoint.updated',
      allowedFrom: ['created'],
      defaultEventData: { action: 'markRunning' },
    });
  }

  async markFailed(input: RuntimeCoordinatorFailureInput): Promise<RunCheckpoint> {
    const now = input.now ?? this.#clock();
    const failureDiagnostic = buildFailureDiagnostic(input, now);
    return this.#transition(
      {
        ...input,
        now,
        diagnostics: failureDiagnostic ? [...(input.diagnostics ?? []), failureDiagnostic] : input.diagnostics,
        eventData: {
          ...(input.eventData ?? {}),
          ...(input.code ? { code: input.code } : {}),
          ...(input.message ? { message: input.message } : {}),
        },
      },
      {
        toStatus: 'failed',
        toPhase: 'terminal',
        eventType: 'run.failed',
        allowedFrom: ['running', 'running_after_resume', 'expired'],
      },
    );
  }

  async markCompleted(input: RuntimeCoordinatorTransitionInput): Promise<RunCheckpoint> {
    return this.#transition(input, {
      toStatus: 'completed',
      toPhase: 'terminal',
      eventType: 'run.completed',
      allowedFrom: ['running'],
    });
  }

  async markExpired(input: RuntimeCoordinatorTransitionInput): Promise<RunCheckpoint> {
    return this.#transition(input, {
      toStatus: 'expired',
      toPhase: (checkpoint) => checkpoint.phase,
      eventType: 'run.expired',
      allowedFrom: ['waiting_for_human'],
    });
  }

  async cancelRun(input: RuntimeCoordinatorTransitionInput): Promise<RunCheckpoint> {
    return this.#transition(input, {
      toStatus: 'cancelled',
      toPhase: 'terminal',
      eventType: 'run.cancelled',
      allowedFrom: ['running', 'waiting_for_human', 'expired'],
    });
  }

  async confirmResumeAuthRecheck(input: RuntimeCoordinatorTransitionInput): Promise<RunCheckpoint> {
    return this.#transition(
      {
        ...input,
        lastCompletedStepId: input.lastCompletedStepId ?? 'auth_state_recheck',
        eventData: {
          result: 'passed',
          stepId: 'auth_state_recheck',
          ...(input.eventData ?? {}),
        },
      },
      {
        toStatus: 'running',
        toPhase: (_checkpoint, transitionInput) => transitionInput.phase ?? 'discovering_network',
        eventType: 'auth.rechecked',
        allowedFrom: ['running_after_resume'],
        clearPendingResumeFields: true,
      },
    );
  }

  async recordNormalizedEvidence(input: RuntimeCoordinatorTransitionInput & { evidenceRefs: readonly string[] }): Promise<RunCheckpoint> {
    return this.#transition(
      {
        ...input,
        eventData: {
          evidenceRefCount: input.evidenceRefs.length,
          ...(input.eventData ?? {}),
        },
      },
      {
        toStatus: 'running',
        toPhase: (_checkpoint, transitionInput) => transitionInput.phase ?? 'normalizing_evidence',
        eventType: 'evidence.normalized',
        allowedFrom: ['running'],
      },
    );
  }

  async requestHumanIntervention(
    input: RuntimeCoordinatorRequestHumanInterventionInput,
  ): Promise<RuntimeCoordinatorRequestHumanInterventionResult> {
    const interventionStore = this.#requireInterventionStore('request human intervention');
    assertNonEmptyHumanInterventionInput(input);

    const current = await this.#getCheckpoint(input.runId, 'waiting_for_human');
    this.#assertExpectedVersion(current, input.expectedVersion, 'waiting_for_human');
    this.#assertTransitionAllowed(current, {
      toStatus: 'waiting_for_human',
      toPhase: 'waiting_for_human',
      eventType: 'intervention.requested',
      allowedFrom: ['running'],
    });

    const now = input.now ?? this.#clock();
    const timeoutMs = resolveHumanInterventionTimeoutMs(input.timeoutMs);
    const expiresAt = resolveHumanInterventionExpiresAt(input, now, timeoutMs);
    const issued = this.#resumeTokenIssuer();
    const request: PendingHumanInterventionRequest = {
      id: this.#idFactory('intervention'),
      runId: current.runId,
      kind: input.kind,
      status: 'pending',
      ...(input.url ? { url: input.url } : {}),
      reason: input.reason,
      instructions: input.instructions.map((instruction) => instruction.trim()).filter(Boolean),
      resumeTokenPreview: issued.resumeTokenPreview,
      resumeTokenHash: issued.resumeTokenHash,
      safeToRetry: input.safeToRetry ?? true,
      timeoutMs,
      createdAt: now,
      expiresAt,
    };

    const createdRequest = await this.#createInterventionRequest(interventionStore, request);
    const checkpoint = await this.#updateCheckpoint(input.runId, {
      expectedVersion: input.expectedVersion,
      status: 'waiting_for_human',
      phase: 'waiting_for_human',
      pendingInterventionId: String(createdRequest.id),
      nextStepId: input.nextStepId,
      resumeTokenHash: issued.resumeTokenHash,
      expiresAt,
      updatedAt: now,
      ...(input.browserSessionRef ? { browserSessionRef: input.browserSessionRef } : {}),
      ...(input.lastCompletedStepId ? { lastCompletedStepId: input.lastCompletedStepId } : {}),
      ...(input.evidenceRefs ? { evidenceRefs: [...input.evidenceRefs] } : {}),
      ...(input.artifactRefs ? { artifactRefs: [...input.artifactRefs] } : {}),
      ...(input.diagnostics ? { diagnostics: [...current.diagnostics, ...input.diagnostics] } : {}),
    }, {
      id: this.#idFactory('event'),
      runId: current.runId,
      type: 'intervention.requested',
      at: now,
      data: {
        fromStatus: current.status,
        toStatus: 'waiting_for_human',
        fromPhase: current.phase,
        toPhase: 'waiting_for_human',
        requestId: String(createdRequest.id),
        kind: createdRequest.kind,
        nextStepId: input.nextStepId,
        expiresAt,
        timeoutMs,
        resumeTokenPreview: createdRequest.resumeTokenPreview,
        ...(input.eventData ?? {}),
      },
    }, {
      message: `Could not request human intervention for run ${input.runId}.`,
      runId: input.runId,
      fromStatus: current.status,
      toStatus: 'waiting_for_human',
    });

    return { checkpoint, request: createdRequest, resumeToken: issued.resumeToken };
  }

  async completeHumanIntervention(
    input: RuntimeCoordinatorCompleteHumanInterventionInput,
  ): Promise<RuntimeCoordinatorCompleteHumanInterventionResult> {
    const interventionStore = this.#requireInterventionStore('complete human intervention');
    const now = input.completedAt ?? input.now ?? this.#clock();
    const current = await this.#getCheckpoint(input.runId, input.result === 'expired' ? 'expired' : 'waiting_for_human');
    this.#assertExpectedVersion(current, input.expectedVersion, input.result === 'expired' ? 'expired' : 'waiting_for_human');
    this.#assertCheckpointWaitingForHuman(current, input.requestId);

    const request = await this.#getInterventionRequest(input.requestId, input.runId);
    assertPendingRequest(request);
    this.#assertRequestMatchesCheckpoint(request, current);
    this.#assertResumeTokenMatches(input.resumeToken, request);

    const completedRequest = await this.#completeInterventionRequest(interventionStore, {
      requestId: input.requestId,
      runId: input.runId,
      resumeToken: input.resumeToken,
      result: input.result,
      completedBy: input.completedBy,
      ...(input.browserSessionRef ? { browserSessionRef: input.browserSessionRef } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      completedAt: now,
    });

    const outcomeDiagnostic = humanOutcomeDiagnostic(input, now);
    const diagnostics = [...current.diagnostics, ...(input.diagnostics ?? []), ...(outcomeDiagnostic ? [outcomeDiagnostic] : [])];
    const patch = this.#checkpointPatchForHumanCompletion(input, current, now, diagnostics);
    const eventType = input.result === 'completed'
      ? 'intervention.completed'
      : input.result === 'expired'
        ? 'intervention.expired'
        : 'intervention.cancelled';

    const checkpoint = await this.#updateCheckpoint(input.runId, patch, {
      id: this.#idFactory('event'),
      runId: current.runId,
      type: eventType,
      at: now,
      data: {
        fromStatus: current.status,
        toStatus: patch.status ?? current.status,
        fromPhase: current.phase,
        toPhase: patch.phase ?? current.phase,
        requestId: input.requestId,
        result: input.result,
        completedBy: input.completedBy,
        hasNotes: Boolean(input.notes),
        ...(input.eventData ?? {}),
      },
    }, {
      message: `Could not complete human intervention ${input.requestId} for run ${input.runId}.`,
      runId: input.runId,
      fromStatus: current.status,
      toStatus: patch.status ?? current.status,
    });

    return { checkpoint, request: completedRequest };
  }

  async resumeRun(input: RuntimeCoordinatorResumeRunInput): Promise<RunCheckpoint> {
    const current = await this.#getCheckpoint(input.runId, 'running_after_resume');
    this.#assertExpectedVersion(current, input.expectedVersion, 'running_after_resume');
    const requestId = input.requestId ?? ('pendingInterventionId' in current ? current.pendingInterventionId : undefined);
    if (!requestId) {
      throw new RuntimeCoordinatorError('invalid-transition', `run ${input.runId} has no pending intervention to resume`, {
        level: 'error',
        code: 'invalid-transition',
        message: 'Rejected resume: checkpoint has no pending intervention id.',
        data: { runId: input.runId, fromStatus: current.status },
      });
    }
    this.#assertCheckpointWaitingForHuman(current, String(requestId));

    const request = await this.#getInterventionRequest(String(requestId), input.runId);
    if (request.status !== 'completed') {
      throw new RuntimeCoordinatorError('invalid-transition', `intervention ${request.id} is ${request.status}, not completed`, {
        level: 'error',
        code: 'invalid-transition',
        message: 'Rejected resume: human intervention is not completed.',
        data: { runId: input.runId, requestId: String(request.id), requestStatus: request.status },
      });
    }
    this.#assertRequestMatchesCheckpoint(request, current);
    assertDefaultResumeEntryStep({ runId: input.runId, requestId: String(request.id), nextStepId: current.nextStepId });

    const now = input.now ?? this.#clock();
    return this.#updateCheckpoint(input.runId, {
      expectedVersion: input.expectedVersion,
      status: 'running_after_resume',
      phase: 'auth_state_recheck',
      resumeAttempts: current.resumeAttempts + 1,
      updatedAt: now,
    }, {
      id: this.#idFactory('event'),
      runId: current.runId,
      type: 'run.resumed',
      at: now,
      data: {
        fromStatus: current.status,
        toStatus: 'running_after_resume',
        fromPhase: current.phase,
        toPhase: 'auth_state_recheck',
        requestId: String(request.id),
        nextStepId: current.nextStepId,
        resumeAttempts: current.resumeAttempts + 1,
        ...(input.eventData ?? {}),
      },
    }, {
      message: `Could not resume run ${input.runId}.`,
      runId: input.runId,
      fromStatus: current.status,
      toStatus: 'running_after_resume',
    });
  }

  async #createCheckpoint(checkpoint: RunCheckpoint, event: RuntimeEvent): Promise<RunCheckpoint> {
    try {
      return await this.#checkpointStore.create(checkpoint, event);
    } catch (error) {
      throw this.#coordinatorErrorFromStore(error, {
        message: `Could not create checkpoint for run ${checkpoint.runId}.`,
        runId: String(checkpoint.runId),
        toStatus: checkpoint.status,
      });
    }
  }

  async #transition(input: RuntimeCoordinatorTransitionInput, config: TransitionConfig): Promise<RunCheckpoint> {
    const current = await this.#getCheckpoint(input.runId, config.toStatus);
    this.#assertExpectedVersion(current, input.expectedVersion, config.toStatus);
    this.#assertTransitionAllowed(current, config);

    const now = input.now ?? this.#clock();
    const toPhase = typeof config.toPhase === 'function' ? config.toPhase(current, input) : config.toPhase;
    assertPhaseAllowedForStatus(config.toStatus, toPhase);

    const patch: CheckpointPatch = {
      expectedVersion: input.expectedVersion,
      status: config.toStatus,
      phase: toPhase,
      updatedAt: now,
      ...(input.evidenceRefs ? { evidenceRefs: [...input.evidenceRefs] } : {}),
      ...(input.artifactRefs ? { artifactRefs: [...input.artifactRefs] } : {}),
      ...(input.browserSessionRef ? { browserSessionRef: input.browserSessionRef } : {}),
      ...(input.lastCompletedStepId ? { lastCompletedStepId: input.lastCompletedStepId } : {}),
      ...(input.diagnostics ? { diagnostics: [...current.diagnostics, ...input.diagnostics] } : {}),
      ...(config.clearPendingResumeFields ? { clearPendingResumeFields: true } : {}),
    };

    const event: RuntimeEvent = {
      id: this.#idFactory('event'),
      runId: current.runId,
      type: config.eventType,
      at: now,
      data: {
        fromStatus: current.status,
        toStatus: config.toStatus,
        fromPhase: current.phase,
        toPhase,
        expectedVersion: input.expectedVersion,
        ...(config.defaultEventData ?? {}),
        ...(input.eventData ?? {}),
      },
    };

    try {
      return await this.#checkpointStore.update(input.runId, patch, event);
    } catch (error) {
      throw this.#coordinatorErrorFromStore(error, {
        message: `Could not transition run ${input.runId} from ${current.status} to ${config.toStatus}.`,
        runId: input.runId,
        fromStatus: current.status,
        toStatus: config.toStatus,
      });
    }
  }

  async #getCheckpoint(runId: string, toStatus: RunStatus): Promise<RunCheckpoint> {
    const checkpoint = await this.#checkpointStore.get(runId);
    if (!checkpoint) {
      throw new RuntimeCoordinatorError('checkpoint-not-found', `checkpoint not found for run ${runId}`, {
        level: 'error',
        code: 'checkpoint-not-found',
        message: `Rejected transition to ${toStatus}: checkpoint was not found.`,
        data: { runId, toStatus },
      });
    }
    return checkpoint;
  }

  #assertExpectedVersion(checkpoint: RunCheckpoint, expectedVersion: number, toStatus: RunStatus): void {
    if (expectedVersion !== checkpoint.version) {
      throw new RuntimeCoordinatorError(
        'stale-checkpoint-version',
        `checkpoint version mismatch for run ${checkpoint.runId}: expected ${expectedVersion}, current ${checkpoint.version}`,
        {
          level: 'error',
          code: 'stale-checkpoint-version',
          message: `Rejected transition to ${toStatus}: checkpoint version was stale.`,
          data: {
            runId: String(checkpoint.runId),
            expectedVersion,
            currentVersion: checkpoint.version,
            fromStatus: checkpoint.status,
            toStatus,
          },
        },
      );
    }
  }

  #assertTransitionAllowed(checkpoint: RunCheckpoint, config: TransitionConfig): void {
    if (isTerminalStatus(checkpoint.status)) {
      throw new RuntimeCoordinatorError('terminal-run-state', `run ${checkpoint.runId} is already terminal: ${checkpoint.status}`, {
        level: 'error',
        code: 'terminal-run-state',
        message: `Rejected transition to ${config.toStatus}: run is already terminal.`,
        data: { runId: String(checkpoint.runId), fromStatus: checkpoint.status, toStatus: config.toStatus },
      });
    }

    if (!config.allowedFrom.includes(checkpoint.status)) {
      throw new RuntimeCoordinatorError(
        'invalid-transition',
        `cannot transition run ${checkpoint.runId} from ${checkpoint.status} to ${config.toStatus}`,
        {
          level: 'error',
          code: 'invalid-transition',
          message: `Rejected transition from ${checkpoint.status} to ${config.toStatus}.`,
          data: { runId: String(checkpoint.runId), fromStatus: checkpoint.status, toStatus: config.toStatus },
        },
      );
    }
  }

  #requireInterventionStore(action: string): InterventionStore {
    if (this.#interventionStore) return this.#interventionStore;

    throw new RuntimeCoordinatorError('invalid-transition', `cannot ${action}: interventionStore was not configured`, {
      level: 'error',
      code: 'invalid-transition',
      message: `Rejected ${action}: RuntimeCoordinator requires an InterventionStore for human intervention lifecycle methods.`,
      data: { action },
    });
  }

  async #createInterventionRequest(
    interventionStore: InterventionStore,
    request: PendingHumanInterventionRequest,
  ): Promise<HumanInterventionRequest> {
    try {
      return await interventionStore.create(request);
    } catch (error) {
      throw this.#coordinatorErrorFromStore(error, {
        message: `Could not create human intervention request ${request.id}.`,
        runId: String(request.runId),
        toStatus: 'waiting_for_human',
      });
    }
  }

  async #completeInterventionRequest(
    interventionStore: InterventionStore,
    input: {
      requestId: string;
      runId: string;
      resumeToken: string;
      result: RuntimeCoordinatorCompleteHumanInterventionInput['result'];
      completedBy: RuntimeCoordinatorCompleteHumanInterventionInput['completedBy'];
      browserSessionRef?: string;
      notes?: string;
      completedAt: string;
    },
  ): Promise<HumanInterventionRequest> {
    try {
      return await interventionStore.complete(input);
    } catch (error) {
      throw this.#coordinatorErrorFromStore(error, {
        message: `Could not complete human intervention request ${input.requestId}.`,
        runId: input.runId,
        toStatus: input.result === 'expired' ? 'expired' : input.result === 'completed' ? 'waiting_for_human' : 'cancelled',
      });
    }
  }

  async #updateCheckpoint(
    runId: string,
    patch: CheckpointPatch,
    event: RuntimeEvent,
    context: { message: string; runId: string; fromStatus?: RunStatus; toStatus: RunStatus },
  ): Promise<RunCheckpoint> {
    try {
      return await this.#checkpointStore.update(runId, patch, event);
    } catch (error) {
      throw this.#coordinatorErrorFromStore(error, context);
    }
  }

  async #getInterventionRequest(requestId: string, runId: string): Promise<HumanInterventionRequest> {
    const interventionStore = this.#requireInterventionStore('read human intervention');
    const request = await interventionStore.get(requestId);
    if (!request) {
      throw new RuntimeCoordinatorError('intervention-not-found', `intervention not found for request ${requestId}`, {
        level: 'error',
        code: 'intervention-not-found',
        message: 'Rejected human intervention operation: request was not found.',
        data: { runId, requestId },
      });
    }
    if (String(request.runId) !== runId) {
      throw new RuntimeCoordinatorError('invalid-transition', `intervention ${requestId} does not belong to run ${runId}`, {
        level: 'error',
        code: 'invalid-transition',
        message: 'Rejected human intervention operation: request belongs to a different run.',
        data: { runId, requestId, requestRunId: String(request.runId) },
      });
    }
    return request;
  }

  #assertCheckpointWaitingForHuman(checkpoint: RunCheckpoint, requestId: string): asserts checkpoint is RunCheckpoint & {
    status: 'waiting_for_human';
    pendingInterventionId: string;
    nextStepId: string;
    resumeTokenHash: string;
  } {
    if (checkpoint.status !== 'waiting_for_human') {
      throw new RuntimeCoordinatorError('invalid-transition', `run ${checkpoint.runId} is ${checkpoint.status}, not waiting_for_human`, {
        level: 'error',
        code: 'invalid-transition',
        message: 'Rejected human intervention operation: checkpoint is not waiting for human input.',
        data: { runId: String(checkpoint.runId), requestId, fromStatus: checkpoint.status },
      });
    }
    if (String(checkpoint.pendingInterventionId) !== requestId) {
      throw new RuntimeCoordinatorError('invalid-transition', `checkpoint pending intervention does not match ${requestId}`, {
        level: 'error',
        code: 'invalid-transition',
        message: 'Rejected human intervention operation: checkpoint pending intervention id does not match request.',
        data: { runId: String(checkpoint.runId), requestId, pendingInterventionId: String(checkpoint.pendingInterventionId) },
      });
    }
  }

  #assertRequestMatchesCheckpoint(request: HumanInterventionRequest, checkpoint: RunCheckpoint): void {
    if (String(request.runId) !== String(checkpoint.runId)) {
      throw new RuntimeCoordinatorError('invalid-transition', `intervention ${request.id} does not belong to run ${checkpoint.runId}`, {
        level: 'error',
        code: 'invalid-transition',
        message: 'Rejected human intervention operation: request/checkpoint run ids differ.',
        data: { runId: String(checkpoint.runId), requestId: String(request.id), requestRunId: String(request.runId) },
      });
    }
    if ('pendingInterventionId' in checkpoint && checkpoint.pendingInterventionId && String(checkpoint.pendingInterventionId) !== String(request.id)) {
      throw new RuntimeCoordinatorError('invalid-transition', `checkpoint is waiting on ${checkpoint.pendingInterventionId}, not ${request.id}`, {
        level: 'error',
        code: 'invalid-transition',
        message: 'Rejected human intervention operation: checkpoint is waiting on a different request.',
        data: { runId: String(checkpoint.runId), requestId: String(request.id), pendingInterventionId: String(checkpoint.pendingInterventionId) },
      });
    }
  }

  #assertResumeTokenMatches(candidateToken: string, request: HumanInterventionRequest): void {
    const result = verifyResumeToken(candidateToken, String(request.resumeTokenHash));
    if (result.ok) return;

    throw new RuntimeCoordinatorError(result.code, result.message, {
      level: 'error',
      code: result.code,
      message: 'Rejected human intervention completion: resume token did not match persisted hash.',
      data: { runId: String(request.runId), requestId: String(request.id), resumeTokenPreview: request.resumeTokenPreview },
    });
  }

  #checkpointPatchForHumanCompletion(
    input: RuntimeCoordinatorCompleteHumanInterventionInput,
    current: RunCheckpoint,
    now: string,
    diagnostics: RuntimeDiagnostic[],
  ): CheckpointPatch {
    const common = {
      expectedVersion: input.expectedVersion,
      updatedAt: now,
      diagnostics,
    } satisfies Pick<CheckpointPatch, 'expectedVersion' | 'updatedAt' | 'diagnostics'>;

    if (input.result === 'completed') {
      return {
        ...common,
        status: 'waiting_for_human',
        phase: 'waiting_for_human',
        ...(input.browserSessionRef ? { browserSessionRef: input.browserSessionRef } : {}),
      };
    }

    if (input.result === 'expired') {
      return {
        ...common,
        status: 'expired',
        phase: current.phase,
      };
    }

    return {
      ...common,
      status: 'cancelled',
      phase: 'terminal',
    };
  }

  #coordinatorErrorFromStore(
    error: unknown,
    context: { message: string; runId: string; fromStatus?: RunStatus; toStatus: RunStatus },
  ): Error {
    if (!isRuntimeStoreError(error)) return error instanceof Error ? error : new Error(String(error));
    if (error instanceof RuntimeCoordinatorError) return error;

    return new RuntimeCoordinatorError(error.code, error.message, {
      level: 'error',
      code: error.code,
      message: context.message,
      data: {
        runId: context.runId,
        ...(context.fromStatus ? { fromStatus: context.fromStatus } : {}),
        toStatus: context.toStatus,
      },
    });
  }
}
