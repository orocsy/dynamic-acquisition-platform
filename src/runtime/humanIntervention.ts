import type {
  HumanInterventionCompletedBy,
  HumanInterventionCompletionResult,
  HumanInterventionKind,
  HumanInterventionRequest,
  IssuedResumeToken,
  RunCheckpoint,
  RuntimeDiagnostic,
  RuntimeSafeData,
} from './types';

export const DEFAULT_HUMAN_INTERVENTION_TIMEOUT_MS = 15 * 60 * 1000;

export type RuntimeCoordinatorRequestHumanInterventionInput = {
  runId: string;
  expectedVersion: number;
  kind: HumanInterventionKind;
  reason: string;
  instructions: readonly string[];
  nextStepId: string;
  timeoutMs?: number;
  expiresAt?: string;
  now?: string;
  url?: string;
  safeToRetry?: boolean;
  browserSessionRef?: string;
  lastCompletedStepId?: string;
  evidenceRefs?: readonly string[];
  artifactRefs?: readonly string[];
  diagnostics?: readonly RuntimeDiagnostic[];
  eventData?: Record<string, RuntimeSafeData>;
};

export type RuntimeCoordinatorRequestHumanInterventionResult = {
  checkpoint: RunCheckpoint;
  request: HumanInterventionRequest;
  resumeToken: string;
};

export type RuntimeCoordinatorCompleteHumanInterventionInput = {
  runId: string;
  requestId: string;
  expectedVersion: number;
  resumeToken: string;
  result: HumanInterventionCompletionResult;
  completedBy: HumanInterventionCompletedBy;
  browserSessionRef?: string;
  notes?: string;
  completedAt?: string;
  now?: string;
  diagnostics?: readonly RuntimeDiagnostic[];
  eventData?: Record<string, RuntimeSafeData>;
};

export type RuntimeCoordinatorCompleteHumanInterventionResult = {
  checkpoint: RunCheckpoint;
  request: HumanInterventionRequest;
};

export type RuntimeCoordinatorResumeRunInput = {
  runId: string;
  expectedVersion: number;
  requestId?: string;
  now?: string;
  eventData?: Record<string, RuntimeSafeData>;
};

export type ResumeTokenIssuer = () => IssuedResumeToken;

export function resolveHumanInterventionTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs ?? DEFAULT_HUMAN_INTERVENTION_TIMEOUT_MS;
}

export function expiresAtFromTimeout(now: string, timeoutMs: number): string {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid ISO timestamp: ${now}`);
  }
  return new Date(nowMs + timeoutMs).toISOString();
}

export function hasMeaningfulInstructions(instructions: readonly string[]): boolean {
  return instructions.some((instruction) => instruction.trim().length > 0);
}
