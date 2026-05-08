import type { CheckpointStore } from './checkpointStore';
import { RuntimeStoreError } from './runtimeErrors';
import { redactBrowserSessionRef, redactRuntimeRecord, stripRuntimeSecretFields } from './runtimeRedaction';
import { TERMINAL_RUN_STATUSES, type CheckpointPatch, type RunCheckpoint, type RuntimeDiagnostic, type RuntimeEvent } from './types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isTerminal(checkpoint: RunCheckpoint): boolean {
  return TERMINAL_RUN_STATUSES.includes(checkpoint.status as (typeof TERMINAL_RUN_STATUSES)[number]);
}

function redactDiagnostics(diagnostics: readonly RuntimeDiagnostic[]): RuntimeDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    data: diagnostic.data ? redactRuntimeRecord(diagnostic.data) : undefined,
  }));
}

function redactCheckpoint(checkpoint: RunCheckpoint): RunCheckpoint {
  const stripped = stripRuntimeSecretFields({ ...checkpoint, diagnostics: redactDiagnostics(checkpoint.diagnostics) }) as RunCheckpoint;
  return stripped.browserSessionRef ? { ...stripped, browserSessionRef: redactBrowserSessionRef(String(stripped.browserSessionRef)) } : stripped;
}

function redactEvent(event: RuntimeEvent): RuntimeEvent {
  return clone({ ...event, data: redactRuntimeRecord(event.data) });
}

function assertEventRunMatches(runId: string, event: RuntimeEvent): void {
  if (String(event.runId) !== runId) {
    throw new RuntimeStoreError('invalid-transition', `event ${event.id} does not belong to run ${runId}`);
  }
}

function appendStoredEvent(events: Map<string, RuntimeEvent[]>, event: RuntimeEvent): void {
  const runId = String(event.runId);
  const currentEvents = events.get(runId) ?? [];
  events.set(runId, [...currentEvents, event]);
}

function clearPendingResumeFieldsForTerminal(checkpoint: RunCheckpoint): RunCheckpoint {
  if (!isTerminal(checkpoint)) return checkpoint;
  const {
    pendingInterventionId: _pendingInterventionId,
    nextStepId: _nextStepId,
    resumeTokenHash: _resumeTokenHash,
    expiresAt: _expiresAt,
    ...terminalCheckpoint
  } = checkpoint;
  return terminalCheckpoint as RunCheckpoint;
}

function clearPendingResumeFieldsAfterAuth(checkpoint: RunCheckpoint): RunCheckpoint {
  if (checkpoint.status === 'waiting_for_human') {
    throw new RuntimeStoreError('invalid-transition', 'waiting_for_human checkpoints cannot clear pending resume fields');
  }

  const {
    pendingInterventionId: _pendingInterventionId,
    nextStepId: _nextStepId,
    resumeTokenHash: _resumeTokenHash,
    expiresAt: _expiresAt,
    ...clearedCheckpoint
  } = checkpoint;
  return clearedCheckpoint as RunCheckpoint;
}

function assertCheckpointInvariant(checkpoint: RunCheckpoint): void {
  if (checkpoint.status === 'waiting_for_human') {
    if (checkpoint.phase !== 'waiting_for_human') {
      throw new RuntimeStoreError('invalid-transition', 'waiting_for_human checkpoints must use waiting_for_human phase');
    }
    if (!checkpoint.pendingInterventionId || !checkpoint.nextStepId || !checkpoint.resumeTokenHash || !checkpoint.expiresAt) {
      throw new RuntimeStoreError(
        'invalid-transition',
        'waiting_for_human checkpoints require pendingInterventionId, nextStepId, resumeTokenHash, and expiresAt',
      );
    }
  }

  if (isTerminal(checkpoint)) {
    if (checkpoint.phase !== 'terminal') {
      throw new RuntimeStoreError('terminal-run-state', 'terminal checkpoints must use terminal phase');
    }
    if ('pendingInterventionId' in checkpoint || 'nextStepId' in checkpoint || 'resumeTokenHash' in checkpoint || 'expiresAt' in checkpoint) {
      throw new RuntimeStoreError('terminal-run-state', 'terminal checkpoints cannot carry pending resume/intervention fields');
    }
  }
}

export class InMemoryCheckpointStore implements CheckpointStore {
  readonly #checkpoints = new Map<string, RunCheckpoint>();
  readonly #events = new Map<string, RuntimeEvent[]>();

  async create(checkpoint: RunCheckpoint, acceptedTransitionEvent?: RuntimeEvent): Promise<RunCheckpoint> {
    assertCheckpointInvariant(checkpoint);
    const runId = String(checkpoint.runId);
    if (this.#checkpoints.has(runId)) {
      throw new RuntimeStoreError('invalid-transition', `checkpoint already exists for run ${runId}`);
    }
    if (acceptedTransitionEvent) {
      assertEventRunMatches(runId, acceptedTransitionEvent);
    }

    const stored = clone(redactCheckpoint(checkpoint));
    const storedEvent = acceptedTransitionEvent ? redactEvent(acceptedTransitionEvent) : undefined;
    this.#checkpoints.set(runId, stored);
    if (storedEvent) appendStoredEvent(this.#events, storedEvent);
    return clone(stored);
  }

  async get(runId: string): Promise<RunCheckpoint | undefined> {
    const checkpoint = this.#checkpoints.get(runId);
    return checkpoint ? clone(checkpoint) : undefined;
  }

  async update(runId: string, patch: CheckpointPatch, acceptedTransitionEvent?: RuntimeEvent): Promise<RunCheckpoint> {
    const current = this.#checkpoints.get(runId);
    if (!current) {
      throw new RuntimeStoreError('checkpoint-not-found', `checkpoint not found for run ${runId}`);
    }
    if (acceptedTransitionEvent) {
      assertEventRunMatches(runId, acceptedTransitionEvent);
    }
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== current.version) {
      throw new RuntimeStoreError('stale-checkpoint-version', `checkpoint version mismatch for run ${runId}`);
    }
    if (isTerminal(current)) {
      throw new RuntimeStoreError('terminal-run-state', `cannot update terminal checkpoint for run ${runId}`);
    }

    const { expectedVersion: _expectedVersion, clearPendingResumeFields, ...patchValues } = patch;
    const merged = {
      ...current,
      ...patchValues,
      evidenceRefs: patch.evidenceRefs ? [...patch.evidenceRefs] : current.evidenceRefs,
      artifactRefs: patch.artifactRefs ? [...patch.artifactRefs] : current.artifactRefs,
      diagnostics: patch.diagnostics ? redactDiagnostics(patch.diagnostics) : current.diagnostics,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
      version: current.version + 1,
    } as RunCheckpoint;
    const updated = clearPendingResumeFieldsForTerminal(
      clearPendingResumeFields ? clearPendingResumeFieldsAfterAuth(merged) : merged,
    );

    assertCheckpointInvariant(updated);
    const stored = clone(redactCheckpoint(updated));
    const storedEvent = acceptedTransitionEvent ? redactEvent(acceptedTransitionEvent) : undefined;
    this.#checkpoints.set(runId, stored);
    if (storedEvent) appendStoredEvent(this.#events, storedEvent);
    return clone(stored);
  }

  async appendEvent(event: RuntimeEvent): Promise<void> {
    appendStoredEvent(this.#events, redactEvent(event));
  }

  async listEvents(runId: string): Promise<RuntimeEvent[]> {
    return clone(this.#events.get(runId) ?? []);
  }

  async listWaiting(now: string): Promise<RunCheckpoint[]> {
    const nowMs = Date.parse(now);
    return [...this.#checkpoints.values()]
      .filter((checkpoint) => {
        if (checkpoint.status !== 'waiting_for_human') return false;
        if (!checkpoint.expiresAt) return true;
        const expiresAtMs = Date.parse(checkpoint.expiresAt);
        return Number.isNaN(nowMs) || Number.isNaN(expiresAtMs) || expiresAtMs > nowMs;
      })
      .map((checkpoint) => clone(checkpoint));
  }
}
