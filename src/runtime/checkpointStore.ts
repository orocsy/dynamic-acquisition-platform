import type { CheckpointPatch, RunCheckpoint, RuntimeEvent } from './types';

export interface CheckpointStore {
  /**
   * When acceptedTransitionEvent is provided, the store must commit the checkpoint
   * and event together or reject before either is changed.
   */
  create(checkpoint: RunCheckpoint, acceptedTransitionEvent?: RuntimeEvent): Promise<RunCheckpoint>;
  get(runId: string): Promise<RunCheckpoint | undefined>;
  /**
   * When acceptedTransitionEvent is provided, the store must commit the checkpoint
   * update and event together or reject before either is changed.
   */
  update(runId: string, patch: CheckpointPatch, acceptedTransitionEvent?: RuntimeEvent): Promise<RunCheckpoint>;
  appendEvent(event: RuntimeEvent): Promise<void>;
  listEvents(runId: string): Promise<RuntimeEvent[]>;
  listWaiting(now: string): Promise<RunCheckpoint[]>;
}
