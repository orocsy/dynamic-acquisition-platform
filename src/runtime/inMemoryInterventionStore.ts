import type { InterventionStore } from './interventionStore';
import { RuntimeStoreError } from './runtimeErrors';
import { sanitizeRuntimeUrl, stripRuntimeSecretFields } from './runtimeRedaction';
import type { HumanInterventionCompletion, HumanInterventionRequest, PendingHumanInterventionRequest } from './types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertPending(request: HumanInterventionRequest, action: string): asserts request is PendingHumanInterventionRequest {
  if (request.status !== 'pending') {
    throw new RuntimeStoreError('invalid-transition', `cannot ${action} ${request.status} intervention ${request.id}`);
  }
}

function sanitizeRequest(request: HumanInterventionRequest): HumanInterventionRequest {
  const stripped = stripRuntimeSecretFields(request);
  return stripped.url ? ({ ...stripped, url: sanitizeRuntimeUrl(stripped.url) } as HumanInterventionRequest) : stripped;
}

function assertRequestInvariant(request: HumanInterventionRequest): void {
  if (request.status === 'pending' && ('completedAt' in request || 'cancelledAt' in request)) {
    throw new RuntimeStoreError('invalid-transition', 'pending intervention requests cannot have terminal timestamps');
  }
  if (request.status === 'completed' && !request.completedAt) {
    throw new RuntimeStoreError('invalid-transition', 'completed intervention requests require completedAt');
  }
  if (request.status === 'cancelled' && !request.cancelledAt) {
    throw new RuntimeStoreError('invalid-transition', 'cancelled intervention requests require cancelledAt');
  }
}

export class InMemoryInterventionStore implements InterventionStore {
  readonly #requests = new Map<string, HumanInterventionRequest>();

  async create(request: HumanInterventionRequest): Promise<HumanInterventionRequest> {
    assertRequestInvariant(request);
    const requestId = String(request.id);
    if (this.#requests.has(requestId)) {
      throw new RuntimeStoreError('invalid-transition', `intervention already exists: ${requestId}`);
    }

    const stored = clone(sanitizeRequest(request));
    this.#requests.set(requestId, stored);
    return clone(stored);
  }

  async get(requestId: string): Promise<HumanInterventionRequest | undefined> {
    const request = this.#requests.get(requestId);
    return request ? clone(request) : undefined;
  }

  async complete(input: HumanInterventionCompletion): Promise<HumanInterventionRequest> {
    const current = this.#requests.get(String(input.requestId));
    if (!current) {
      throw new RuntimeStoreError('intervention-not-found', `intervention not found: ${input.requestId}`);
    }
    if (String(current.runId) !== String(input.runId)) {
      throw new RuntimeStoreError('invalid-transition', `intervention ${input.requestId} does not belong to run ${input.runId}`);
    }
    assertPending(current, 'complete');

    let updated: HumanInterventionRequest;
    if (input.result === 'completed') {
      updated = { ...current, status: 'completed', completedAt: input.completedAt };
    } else if (input.result === 'expired') {
      updated = { ...current, status: 'expired' };
    } else {
      updated = { ...current, status: 'cancelled', cancelledAt: input.completedAt };
    }

    assertRequestInvariant(updated);
    const stored = clone(updated);
    this.#requests.set(String(input.requestId), stored);
    return clone(stored);
  }

  async expire(requestId: string, now: string): Promise<HumanInterventionRequest> {
    const current = this.#requests.get(requestId);
    if (!current) {
      throw new RuntimeStoreError('intervention-not-found', `intervention not found: ${requestId}`);
    }
    assertPending(current, 'expire');

    const updated: HumanInterventionRequest = { ...current, status: 'expired', expiresAt: now };
    const stored = clone(updated);
    this.#requests.set(requestId, stored);
    return clone(stored);
  }

  async cancel(requestId: string, now: string): Promise<HumanInterventionRequest> {
    const current = this.#requests.get(requestId);
    if (!current) {
      throw new RuntimeStoreError('intervention-not-found', `intervention not found: ${requestId}`);
    }
    assertPending(current, 'cancel');

    const updated: HumanInterventionRequest = { ...current, status: 'cancelled', cancelledAt: now };
    const stored = clone(updated);
    this.#requests.set(requestId, stored);
    return clone(stored);
  }
}
