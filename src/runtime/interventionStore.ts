import type { HumanInterventionCompletion, HumanInterventionRequest } from './types';

export interface InterventionStore {
  create(request: HumanInterventionRequest): Promise<HumanInterventionRequest>;
  get(requestId: string): Promise<HumanInterventionRequest | undefined>;
  complete(input: HumanInterventionCompletion): Promise<HumanInterventionRequest>;
  expire(requestId: string, now: string): Promise<HumanInterventionRequest>;
  cancel(requestId: string, now: string): Promise<HumanInterventionRequest>;
}
