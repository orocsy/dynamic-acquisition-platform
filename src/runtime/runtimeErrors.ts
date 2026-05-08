import type { RuntimeDiagnostic, RuntimeErrorCode } from './types';

export class RuntimeStoreError extends Error {
  readonly code: RuntimeErrorCode | string;

  constructor(code: RuntimeErrorCode | string, message: string) {
    super(message);
    this.name = 'RuntimeStoreError';
    this.code = code;
  }
}

export class RuntimeCoordinatorError extends RuntimeStoreError {
  readonly diagnostic: RuntimeDiagnostic;

  constructor(code: RuntimeErrorCode | string, message: string, diagnostic: RuntimeDiagnostic) {
    super(code, message);
    this.name = 'RuntimeCoordinatorError';
    this.diagnostic = diagnostic;
  }
}

export function isRuntimeStoreError(error: unknown): error is RuntimeStoreError {
  return error instanceof RuntimeStoreError;
}

export function isRuntimeCoordinatorError(error: unknown): error is RuntimeCoordinatorError {
  return error instanceof RuntimeCoordinatorError;
}
