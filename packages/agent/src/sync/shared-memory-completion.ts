import type { SharedMemoryPhaseFailureCause } from './shared-memory-diagnostics.js';

/** One coherent internal outcome for bounded shared-memory work. */
export type SharedMemoryWorkOutcome =
  | 'completed'
  | 'timed-out'
  | 'local-budget-yield'
  | 'incomplete';

/** Compatibility fields exposed by existing page/result boundaries. */
export type SharedMemoryCompletionFields =
  | { readonly completed: true; readonly timedOut: false; readonly localYield?: never }
  | { readonly completed: false; readonly timedOut: true; readonly localYield?: never }
  | { readonly completed: false; readonly timedOut: false; readonly localYield: true }
  | { readonly completed: false; readonly timedOut: false; readonly localYield?: never };

/** Derive the internal outcome once from compatibility-facing result fields. */
export function sharedMemoryWorkOutcome(
  fields: SharedMemoryCompletionFields,
): SharedMemoryWorkOutcome {
  if (fields.completed) return 'completed';
  if (fields.localYield === true) return 'local-budget-yield';
  if (fields.timedOut) return 'timed-out';
  return 'incomplete';
}

/** Adapt an internal outcome to the existing public result fields at the edge. */
export function sharedMemoryCompletionFields(
  outcome: SharedMemoryWorkOutcome,
): SharedMemoryCompletionFields {
  switch (outcome) {
    case 'completed':
      return { completed: true, timedOut: false };
    case 'timed-out':
      return { completed: false, timedOut: true };
    case 'local-budget-yield':
      return { completed: false, timedOut: false, localYield: true };
    case 'incomplete':
      return { completed: false, timedOut: false };
  }
}

/** Aggregate evidence is a boolean, independent of any single work outcome. */
export function mergeLocalBudgetYieldEvidence(
  a: true | undefined,
  b: true | undefined,
): true | undefined {
  return a === true || b === true ? true : undefined;
}

interface RecoverContextGraphSwmResultFields {
  /** Attribution for the single incomplete recovery phase emitted by the lifecycle. */
  readonly localYieldFailedPhases?: number;
  readonly replacedRoots: number;
  readonly replacedGraphs: number;
  readonly insertedDataQuads: number;
  readonly insertedMetaQuads: number;
  readonly droppedDataTriples: number;
  /** Verified immutable snapshot refs ready in the local cache after this round. */
  readonly readySnapshots: number;
  /** Manifest-bound progress across rounds; retry accounting, not permission to reuse a ref. */
  readonly cumulativeResolvedSnapshots?: number;
  /** Total immutable snapshot refs declared by the recovered SWM metadata. */
  readonly totalSnapshots: number;
}

/** Recovery completion cannot simultaneously carry a local-yield outcome. */
export type RecoverContextGraphSwmResult = RecoverContextGraphSwmResultFields & (
  | { readonly completed: true; readonly localYield?: never; readonly phaseFailureCause?: never }
  | {
      readonly completed: false;
      readonly localYield?: true;
      /** Direct internal cause consumed by lifecycle aggregation. */
      readonly phaseFailureCause: SharedMemoryPhaseFailureCause;
    }
);

/** Completed no-op recovery has the same full accounting shape as an applied round. */
export function emptySwmRecoveryResult(): RecoverContextGraphSwmResult {
  return {
    replacedRoots: 0,
    replacedGraphs: 0,
    insertedDataQuads: 0,
    insertedMetaQuads: 0,
    droppedDataTriples: 0,
    readySnapshots: 0,
    totalSnapshots: 0,
    completed: true,
  };
}
