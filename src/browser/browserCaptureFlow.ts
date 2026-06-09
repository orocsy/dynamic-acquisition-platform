import type { RunCheckpoint, RuntimeDiagnostic, RuntimeDiagnosticLevel, RuntimeSafeData } from '../runtime/types';
import type { RuntimeCoordinatorTransitionInput } from '../runtime/runtimeCoordinator';
import { normalizeNetworkEvidence } from '../discovery/network';
import type { NetworkEvidenceNormalizerInput, NetworkEvidenceNormalizerResult } from '../discovery/network/types';
import { mapBrowserObservationToNetworkEntry } from './mapBrowserObservationToNetworkEntry';
import type { NetworkCaptureSession } from './networkCaptureSession';
import type { PageTargetRef } from './types';

/**
 * The slice of the runtime coordinator the capture flow needs: it attaches evidence refs and
 * advances the run. The flow NEVER touches the checkpoint store directly (exit criteria 7.7).
 */
export interface EvidenceRecordingCoordinator {
  recordNormalizedEvidence(
    input: RuntimeCoordinatorTransitionInput & { evidenceRefs: readonly string[] },
  ): Promise<RunCheckpoint>;
}

export type BrowserNetworkCaptureFlowDeps = {
  session: NetworkCaptureSession;
  coordinator: EvidenceRecordingCoordinator;
  /** Injectable for tests; defaults to the real discovery normalizer (the only Evidence creator). */
  normalize?: (input: NetworkEvidenceNormalizerInput) => NetworkEvidenceNormalizerResult;
};

export type BrowserNetworkCaptureFlowInput = {
  runId: string;
  pageTargetRef: PageTargetRef | string;
  expectedVersion: number;
  now?: string;
  phase?: RuntimeCoordinatorTransitionInput['phase'];
  targetUrl?: string;
  intentId?: string;
  artifactRefs?: readonly string[];
  lastCompletedStepId?: string;
  browserSessionRef?: string;
  /** Evidence refs already on the checkpoint (creation / auth boundary); merged so the
   *  coordinator's replace-semantics don't drop them. */
  priorEvidenceRefs?: readonly string[];
};

export type BrowserNetworkCaptureFlowResult = {
  recorded: boolean;
  checkpoint?: RunCheckpoint;
  evidenceRefs: string[];
  evidenceCount: number;
  skippedCount: number;
  diagnostics: RuntimeDiagnostic[];
};

function normalizerDiagnosticData(
  diagnostic: NetworkEvidenceNormalizerResult['diagnostics'][number],
): Record<string, RuntimeSafeData> {
  // Mirrors simulatedRuntimeFlow: only the shape-describing fields (no values) carry over.
  const data: Record<string, RuntimeSafeData> = {};
  if (diagnostic.entryId) data.entryId = diagnostic.entryId;
  if (diagnostic.category) data.category = diagnostic.category;
  if (diagnostic.errors?.length) data.errors = [...diagnostic.errors];
  return data;
}

function captureDiagnosticLevel(level: unknown): RuntimeDiagnosticLevel {
  return level === 'error' || level === 'info' ? level : 'warning';
}

function mergeEvidenceRefs(prior: readonly string[] | undefined, next: readonly string[]): string[] {
  const merged = [...(prior ?? [])];
  for (const ref of next) {
    if (!merged.includes(ref)) merged.push(ref);
  }
  return merged;
}

/**
 * Phase 3.4 bridge: capture observations -> map to RawNetworkEntry[] -> normalize evidence
 * -> attach evidence refs through the coordinator. The existing normalizer stays the only
 * Evidence creator, and validation failures (an `error`-level normalizer diagnostic) STOP the
 * flow before any coordinator transition, so a failed normalization never advances the run.
 */
export async function runBrowserNetworkCaptureFlow(
  deps: BrowserNetworkCaptureFlowDeps,
  input: BrowserNetworkCaptureFlowInput,
): Promise<BrowserNetworkCaptureFlowResult> {
  const normalize = deps.normalize ?? normalizeNetworkEvidence;

  const capture = await deps.session.stop({ runId: input.runId, pageTargetRef: input.pageTargetRef, now: input.now });

  const entries = [];
  let unmappable = 0;
  for (const observation of capture.observations) {
    const entry = mapBrowserObservationToNetworkEntry(observation);
    if (entry) {
      entries.push(entry);
    } else {
      unmappable += 1;
    }
  }

  const normalized = normalize({
    entries,
    targetUrl: input.targetUrl,
    intentId: input.intentId,
    runId: input.runId,
  });

  const captureDiagnostics: RuntimeDiagnostic[] = capture.diagnostics.map((diagnostic) => ({
    level: captureDiagnosticLevel(diagnostic.level),
    code: `browser-capture.${typeof diagnostic.code === 'string' ? diagnostic.code : 'diagnostic'}`,
    message: typeof diagnostic.reason === 'string' ? diagnostic.reason : 'browser capture diagnostic',
    ...(input.now ? { at: input.now } : {}),
    ...(typeof diagnostic.observationId === 'string' ? { data: { observationId: diagnostic.observationId } } : {}),
  }));

  const normalizerDiagnostics: RuntimeDiagnostic[] = normalized.diagnostics.map((diagnostic) => ({
    level: diagnostic.level,
    code: `network.${diagnostic.code.toLowerCase().replaceAll('_', '-')}`,
    message: `Network evidence normalization: ${diagnostic.code}`,
    ...(input.now ? { at: input.now } : {}),
    data: normalizerDiagnosticData(diagnostic),
  }));

  const diagnostics = [...captureDiagnostics, ...normalizerDiagnostics];
  const newEvidenceRefs = normalized.evidence.map((evidence) => evidence.evidenceId);
  // recordNormalizedEvidence REPLACES evidenceRefs in the checkpoint patch, so merge any
  // prior refs (creation / auth boundary) with this capture's -- otherwise they are dropped.
  const evidenceRefs = mergeEvidenceRefs(input.priorEvidenceRefs, newEvidenceRefs);
  const evidenceCount = normalized.evidence.length;
  const skippedCount = normalized.skipped.length;

  // Failed validation -> do NOT transition the run (no recordNormalizedEvidence call).
  if (normalized.diagnostics.some((diagnostic) => diagnostic.level === 'error')) {
    return { recorded: false, evidenceRefs, evidenceCount, skippedCount, diagnostics };
  }

  const checkpoint = await deps.coordinator.recordNormalizedEvidence({
    runId: input.runId,
    expectedVersion: input.expectedVersion,
    now: input.now,
    phase: input.phase ?? 'normalizing_evidence',
    evidenceRefs,
    artifactRefs: input.artifactRefs,
    lastCompletedStepId: input.lastCompletedStepId,
    browserSessionRef: input.browserSessionRef,
    diagnostics,
    eventData: {
      evidenceCount,
      skippedCount,
      capturedObservationCount: capture.observations.length,
      unmappableObservationCount: unmappable,
    },
  });

  return { recorded: true, checkpoint, evidenceRefs, evidenceCount, skippedCount, diagnostics };
}
