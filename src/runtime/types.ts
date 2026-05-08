export type Brand<TValue, TBrand extends string> = TValue & { readonly __brand: TBrand };

export type RunId = Brand<string, 'RunId'>;
export type InterventionRequestId = Brand<string, 'InterventionRequestId'>;
export type RuntimeEventId = Brand<string, 'RuntimeEventId'>;
export type RuntimeStepId = Brand<string, 'RuntimeStepId'>;
export type ResumeTokenHash = Brand<string, 'ResumeTokenHash'>;
export type BrowserSessionRef = Brand<string, 'BrowserSessionRef'>;
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

export const RUN_STATUSES = [
  'created',
  'running',
  'waiting_for_human',
  'running_after_resume',
  'expired',
  'failed',
  'completed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = ['failed', 'completed', 'cancelled'] as const satisfies readonly RunStatus[];
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];
export type ActiveRunStatus = Exclude<RunStatus, TerminalRunStatus | 'waiting_for_human'>;

export const RUN_PHASES = [
  'intent_accepted',
  'target_opened',
  'auth_boundary_detected',
  'waiting_for_human',
  'auth_state_recheck',
  'discovering_network',
  'normalizing_evidence',
  'finalizing',
  'terminal',
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];
export type ActiveRunPhase = Exclude<RunPhase, 'terminal'>;

export const HUMAN_INTERVENTION_KINDS = [
  'login-required',
  'mfa-required',
  'consent-required',
  'captcha-required',
  'decision-required',
] as const;

export type HumanInterventionKind = (typeof HUMAN_INTERVENTION_KINDS)[number];

export const HUMAN_INTERVENTION_STATUSES = ['pending', 'completed', 'expired', 'cancelled'] as const;
export type HumanInterventionStatus = (typeof HUMAN_INTERVENTION_STATUSES)[number];

export const HUMAN_INTERVENTION_COMPLETION_RESULTS = ['completed', 'cancelled', 'unsafe', 'expired'] as const;
export type HumanInterventionCompletionResult = (typeof HUMAN_INTERVENTION_COMPLETION_RESULTS)[number];

export const HUMAN_INTERVENTION_COMPLETED_BY_VALUES = ['human', 'agent', 'system'] as const;
export type HumanInterventionCompletedBy = (typeof HUMAN_INTERVENTION_COMPLETED_BY_VALUES)[number];

export const RUNTIME_EVENT_TYPES = [
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
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export const RUNTIME_DIAGNOSTIC_LEVELS = ['info', 'warning', 'error'] as const;
export type RuntimeDiagnosticLevel = (typeof RUNTIME_DIAGNOSTIC_LEVELS)[number];

export const RUNTIME_ERROR_CODES = [
  'checkpoint-not-found',
  'intervention-not-found',
  'invalid-transition',
  'invalid-resume-token',
  'stale-checkpoint-version',
  'terminal-run-state',
  'intervention-expired',
  'unsafe-human-result',
  'redaction-required',
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export type RuntimeSafePrimitive = string | number | boolean | null;
export type RuntimeSafeData = RuntimeSafePrimitive | RuntimeSafeData[] | { [key: string]: RuntimeSafeData };

export type RuntimeDiagnostic = {
  level: RuntimeDiagnosticLevel;
  code: RuntimeErrorCode | string;
  message: string;
  at?: IsoTimestamp | string;
  stepId?: RuntimeStepId | string;
  /**
   * Must be redacted before persistence. Phase 2.2 adds concrete redaction helpers.
   * Never include raw resume tokens, credentials, cookies, auth headers, MFA codes, or captcha answers.
   */
  data?: Record<string, RuntimeSafeData>;
};

type RunCheckpointBase = {
  runId: RunId | string;
  intentSnapshot: unknown;
  evidenceRefs: string[];
  artifactRefs: string[];
  browserSessionRef?: BrowserSessionRef | string;
  lastCompletedStepId?: RuntimeStepId | string;
  resumeAttempts: number;
  version: number;
  diagnostics: RuntimeDiagnostic[];
  createdAt: IsoTimestamp | string;
  updatedAt: IsoTimestamp | string;
};

export type ActiveRunCheckpoint = RunCheckpointBase & {
  status: ActiveRunStatus;
  phase: ActiveRunPhase;
  pendingInterventionId?: InterventionRequestId | string;
  nextStepId?: RuntimeStepId | string;
  resumeTokenHash?: ResumeTokenHash | string;
  expiresAt?: IsoTimestamp | string;
};

export type WaitingForHumanCheckpoint = RunCheckpointBase & {
  status: 'waiting_for_human';
  phase: 'waiting_for_human';
  pendingInterventionId: InterventionRequestId | string;
  nextStepId: RuntimeStepId | string;
  resumeTokenHash: ResumeTokenHash | string;
  expiresAt: IsoTimestamp | string;
};

export type TerminalRunCheckpoint = RunCheckpointBase & {
  status: TerminalRunStatus;
  phase: 'terminal';
  pendingInterventionId?: never;
  nextStepId?: never;
  resumeTokenHash?: never;
  expiresAt?: never;
};

export type RunCheckpoint = ActiveRunCheckpoint | WaitingForHumanCheckpoint | TerminalRunCheckpoint;

export type CheckpointPatch = Partial<
  Pick<
    RunCheckpoint,
    | 'status'
    | 'phase'
    | 'intentSnapshot'
    | 'browserSessionRef'
    | 'pendingInterventionId'
    | 'lastCompletedStepId'
    | 'nextStepId'
    | 'resumeTokenHash'
    | 'resumeAttempts'
    | 'expiresAt'
  >
> & {
  evidenceRefs?: readonly string[];
  artifactRefs?: readonly string[];
  diagnostics?: readonly RuntimeDiagnostic[];
  expectedVersion?: number;
  updatedAt?: IsoTimestamp | string;
  /**
   * Explicitly clears pending intervention/resume metadata after a successful
   * post-auth checkpoint update. Waiting checkpoints cannot use this flag.
   */
  clearPendingResumeFields?: boolean;
};

type HumanInterventionRequestBase = {
  id: InterventionRequestId | string;
  runId: RunId | string;
  kind: HumanInterventionKind;
  url?: string;
  reason: string;
  instructions: string[];
  resumeTokenPreview: string;
  resumeTokenHash: ResumeTokenHash | string;
  safeToRetry: boolean;
  timeoutMs: number;
  createdAt: IsoTimestamp | string;
  expiresAt: IsoTimestamp | string;
};

export type PendingHumanInterventionRequest = HumanInterventionRequestBase & {
  status: 'pending';
  completedAt?: never;
  cancelledAt?: never;
};

export type CompletedHumanInterventionRequest = HumanInterventionRequestBase & {
  status: 'completed';
  completedAt: IsoTimestamp | string;
  cancelledAt?: never;
};

export type ExpiredHumanInterventionRequest = HumanInterventionRequestBase & {
  status: 'expired';
  completedAt?: never;
  cancelledAt?: never;
};

export type CancelledHumanInterventionRequest = HumanInterventionRequestBase & {
  status: 'cancelled';
  completedAt?: never;
  cancelledAt: IsoTimestamp | string;
};

export type HumanInterventionRequest =
  | PendingHumanInterventionRequest
  | CompletedHumanInterventionRequest
  | ExpiredHumanInterventionRequest
  | CancelledHumanInterventionRequest;

export type HumanInterventionCompletion = {
  requestId: InterventionRequestId | string;
  runId: RunId | string;
  resumeToken: string;
  result: HumanInterventionCompletionResult;
  completedBy: HumanInterventionCompletedBy;
  browserSessionRef?: BrowserSessionRef | string;
  notes?: string;
  completedAt: IsoTimestamp | string;
};

export type RuntimeEvent = {
  id: RuntimeEventId | string;
  runId: RunId | string;
  type: RuntimeEventType;
  at: IsoTimestamp | string;
  /**
   * Persisted event payloads must be redacted. Never include raw resume tokens,
   * credentials, cookies, auth headers, MFA codes, or captcha answers.
   */
  data: Record<string, RuntimeSafeData>;
};

export type IssuedResumeToken = {
  resumeToken: string;
  resumeTokenHash: ResumeTokenHash | string;
  resumeTokenPreview: string;
};

export type ResumeTokenIssue = IssuedResumeToken;

export type ResumeTokenVerificationResult =
  | { ok: true }
  | { ok: false; code: Extract<RuntimeErrorCode, 'invalid-resume-token'>; message: string };
