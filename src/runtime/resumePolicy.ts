import { RuntimeCoordinatorError } from './runtimeErrors';
import type { RuntimeDiagnostic, RuntimeSafeData } from './types';

export const DEFAULT_RESUME_ENTRY_STEP_ID = 'auth_state_recheck';

export function isDefaultResumeEntryStep(stepId: string): boolean {
  return stepId === DEFAULT_RESUME_ENTRY_STEP_ID;
}

export function createInvalidResumeEntryDiagnostic(input: {
  runId: string;
  requestId: string;
  nextStepId: string;
}): RuntimeDiagnostic {
  return {
    level: 'error',
    code: 'invalid-transition',
    message: 'Rejected resume: the first resumed step must recheck auth state.',
    data: {
      runId: input.runId,
      requestId: input.requestId,
      nextStepId: input.nextStepId,
      requiredStepId: DEFAULT_RESUME_ENTRY_STEP_ID,
    } satisfies Record<string, RuntimeSafeData>,
  };
}

export function assertDefaultResumeEntryStep(input: { runId: string; requestId: string; nextStepId: string }): void {
  if (isDefaultResumeEntryStep(input.nextStepId)) return;

  throw new RuntimeCoordinatorError(
    'invalid-transition',
    `resume entry step must be ${DEFAULT_RESUME_ENTRY_STEP_ID}; got ${input.nextStepId}`,
    createInvalidResumeEntryDiagnostic(input),
  );
}
