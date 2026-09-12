// SPDX-License-Identifier: Apache-2.0

import type { CatchupPassDecisionReason } from './catchup-pass-policy.js';
import { mergeLocalBudgetYieldEvidence } from './shared-memory-completion.js';

/** One peer and one round of public-SWM snapshot coverage, reduced as a unit. */
export interface SwmSnapshotCoverage {
  contextGraphId: string;
  peerIdSuffix: string;
  snapshotsResolved: number;
  snapshotsTotal: number;
  manifestComplete: boolean;
  descriptorsAuthoritative?: boolean;
  missingCount: number;
  missingSample: string[];
  materializationFailures: number;
  fromAuthority?: boolean;
}

/** Compatibility-facing diagnostic result accepted from workers and older producers. */
interface SharedMemorySyncDiagnosticsShape {
  readonly localYield?: true;
  /** Failed phases caused solely by local admission, never independent peer or materialization failures. */
  readonly localYieldFailedPhases?: number;
  readonly snapshotPlaneIncomplete?: number;
  readonly fetchedMetaTriples: number;
  readonly fetchedDataTriples: number;
  readonly insertedMetaTriples: number;
  readonly insertedDataTriples: number;
  readonly bytesReceived: number;
  readonly resumedPhases: number;
  readonly timedOutPhases: number;
  readonly completedPhases: number;
  readonly checkpointAdvances: number;
  readonly emptyResponses: number;
  readonly droppedDataTriples: number;
  readonly failedPeers: number;
  readonly failedPhases: number;
  readonly backoffWorthyFailures?: number;
  readonly deferredBackpressure?: number;
  readonly swmCoverage?: SwmSnapshotCoverage;
  readonly metadataContinuationYields?: number;
  readonly continuationPasses?: number;
  readonly resolvedSnapshotPlaneIncomplete?: number;
  readonly resolvedMetadataContinuationYields?: number;
  readonly continuationStopReason?: CatchupPassDecisionReason;
  readonly replayPhaseBytesReceived?: number;
  readonly snapshotPhaseBytesReceived?: number;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
export type SharedMemorySyncDiagnostics = Mutable<SharedMemorySyncDiagnosticsShape>;
export type SharedMemorySyncResult = SharedMemorySyncDiagnostics & {
  insertedTriples: number;
  deniedPhases: number;
};

/** Aggregate contract retaining its existing required counters for compatibility. */
export type SharedMemorySyncAggregate = SharedMemorySyncResult & {
  snapshotPlaneIncomplete: number;
  backoffWorthyFailures: number;
  deferredBackpressure: number;
  metadataContinuationYields: number;
  continuationPasses: number;
  resolvedSnapshotPlaneIncomplete: number;
  resolvedMetadataContinuationYields: number;
  replayPhaseBytesReceived: number;
  snapshotPhaseBytesReceived: number;
};

/** Canonical constructors always initialize newly added counters. */
type SharedMemorySyncAccumulator = SharedMemorySyncAggregate & { localYieldFailedPhases: number };

/** Requester terminology retained as an alias of the canonical aggregate. */
export type SharedMemorySyncSummary = SharedMemorySyncAggregate;

/** Older diagnostics may omit counters that are present on detailed results. */
type SharedMemorySyncMergeInput = SharedMemorySyncDiagnostics
  & Partial<Pick<SharedMemorySyncResult, 'insertedTriples' | 'deniedPhases'>>;

type NumericDiagnosticKey = {
  [Key in keyof SharedMemorySyncMergeInput]-?:
    NonNullable<SharedMemorySyncMergeInput[Key]> extends number ? Key : never;
}[keyof SharedMemorySyncMergeInput];

/**
 * Select a whole coverage record: authority, complete manifest, largest
 * manifest, most resolved, then peer suffix. Numerators and denominators are
 * never synthesized from different observations.
 */
export function selectSwmSnapshotCoverage(
  a: SwmSnapshotCoverage | undefined,
  b: SwmSnapshotCoverage | undefined,
): SwmSnapshotCoverage | undefined {
  if (!a) return b;
  if (!b) return a;
  if ((a.fromAuthority ?? false) !== (b.fromAuthority ?? false)) {
    return a.fromAuthority ? a : b;
  }
  if (a.manifestComplete !== b.manifestComplete) return a.manifestComplete ? a : b;
  if (a.snapshotsTotal !== b.snapshotsTotal) return a.snapshotsTotal > b.snapshotsTotal ? a : b;
  if (a.snapshotsResolved !== b.snapshotsResolved) {
    return a.snapshotsResolved > b.snapshotsResolved ? a : b;
  }
  return a.peerIdSuffix <= b.peerIdSuffix ? a : b;
}

/** Canonical zero value for requester, lifecycle, and CLI orchestration. */
export function emptySharedMemorySyncResult(failedPeers = 0): SharedMemorySyncAccumulator {
  return {
    localYieldFailedPhases: 0,
    snapshotPlaneIncomplete: 0,
    insertedTriples: 0,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 0,
    insertedMetaTriples: 0,
    insertedDataTriples: 0,
    bytesReceived: 0,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 0,
    checkpointAdvances: 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers,
    failedPhases: 0,
    deniedPhases: 0,
    backoffWorthyFailures: 0,
    deferredBackpressure: 0,
    metadataContinuationYields: 0,
    continuationPasses: 0,
    resolvedSnapshotPlaneIncomplete: 0,
    resolvedMetadataContinuationYields: 0,
    replayPhaseBytesReceived: 0,
    snapshotPhaseBytesReceived: 0,
  };
}

/** Merge rounds belonging to one peer; peer failure is a maximum. */
export function mergeSamePeerSharedMemoryDiagnostics(
  a: SharedMemorySyncMergeInput,
  b: SharedMemorySyncMergeInput,
): SharedMemorySyncAccumulator {
  return mergeSharedMemoryDiagnostics(a, b, 'max');
}

/** Merge observations across a fleet; each failed peer is counted. */
export function mergeFleetSharedMemoryDiagnostics(
  a: SharedMemorySyncMergeInput,
  b: SharedMemorySyncMergeInput,
): SharedMemorySyncAccumulator {
  return mergeSharedMemoryDiagnostics(a, b, 'sum');
}

function mergeSharedMemoryDiagnostics(
  a: SharedMemorySyncMergeInput,
  b: SharedMemorySyncMergeInput,
  failedPeers: 'max' | 'sum',
): SharedMemorySyncAccumulator {
  const sum = (key: NumericDiagnosticKey): number =>
    (a[key] ?? 0) + (b[key] ?? 0);
  const swmCoverage = selectSwmSnapshotCoverage(a.swmCoverage, b.swmCoverage);
  return {
    localYield: mergeLocalBudgetYieldEvidence(a.localYield, b.localYield),
    localYieldFailedPhases: sum('localYieldFailedPhases'),
    snapshotPlaneIncomplete: sum('snapshotPlaneIncomplete'),
    insertedTriples: sum('insertedTriples'),
    fetchedMetaTriples: sum('fetchedMetaTriples'),
    fetchedDataTriples: sum('fetchedDataTriples'),
    insertedMetaTriples: sum('insertedMetaTriples'),
    insertedDataTriples: sum('insertedDataTriples'),
    bytesReceived: sum('bytesReceived'),
    resumedPhases: sum('resumedPhases'),
    timedOutPhases: sum('timedOutPhases'),
    completedPhases: sum('completedPhases'),
    checkpointAdvances: sum('checkpointAdvances'),
    emptyResponses: sum('emptyResponses'),
    droppedDataTriples: sum('droppedDataTriples'),
    failedPeers: failedPeers === 'sum'
      ? a.failedPeers + b.failedPeers
      : Math.max(a.failedPeers, b.failedPeers),
    failedPhases: sum('failedPhases'),
    deniedPhases: sum('deniedPhases'),
    backoffWorthyFailures: sum('backoffWorthyFailures'),
    deferredBackpressure: sum('deferredBackpressure'),
    metadataContinuationYields: sum('metadataContinuationYields'),
    continuationPasses: sum('continuationPasses'),
    resolvedSnapshotPlaneIncomplete: sum('resolvedSnapshotPlaneIncomplete'),
    resolvedMetadataContinuationYields: sum('resolvedMetadataContinuationYields'),
    replayPhaseBytesReceived: sum('replayPhaseBytesReceived'),
    snapshotPhaseBytesReceived: sum('snapshotPhaseBytesReceived'),
    ...(swmCoverage === undefined ? {} : { swmCoverage }),
    ...(b.continuationStopReason === undefined && a.continuationStopReason === undefined
      ? {}
      : { continuationStopReason: b.continuationStopReason ?? a.continuationStopReason }),
  };
}
