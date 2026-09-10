// SPDX-License-Identifier: Apache-2.0

import type { CatchupPassDecisionReason } from './catchup-pass-policy.js';
import {
  mergeSharedMemoryLocalYield,
  type SharedMemoryLocalYield,
} from './shared-memory-completion.js';

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
  readonly localYield?: SharedMemoryLocalYield;
  readonly snapshotPlaneIncomplete: number;
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

/** Canonical in-process accumulator/result: every additive counter is concrete. */
export type SharedMemorySyncAggregate = SharedMemorySyncResult & {
  backoffWorthyFailures: number;
  deferredBackpressure: number;
  metadataContinuationYields: number;
  continuationPasses: number;
  resolvedSnapshotPlaneIncomplete: number;
  resolvedMetadataContinuationYields: number;
  replayPhaseBytesReceived: number;
  snapshotPhaseBytesReceived: number;
};

/** Requester terminology retained as an alias of the canonical aggregate. */
export type SharedMemorySyncSummary = SharedMemorySyncAggregate;

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
export function emptySharedMemorySyncResult(failedPeers = 0): SharedMemorySyncAggregate {
  return {
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
  a: SharedMemorySyncDiagnostics,
  b: SharedMemorySyncDiagnostics,
): SharedMemorySyncAggregate {
  return mergeSharedMemoryDiagnostics(a, b, 'max');
}

/** Merge observations across a fleet; each failed peer is counted. */
export function mergeFleetSharedMemoryDiagnostics(
  a: SharedMemorySyncDiagnostics,
  b: SharedMemorySyncDiagnostics,
): SharedMemorySyncAggregate {
  return mergeSharedMemoryDiagnostics(a, b, 'sum');
}

function mergeSharedMemoryDiagnostics(
  a: SharedMemorySyncDiagnostics,
  b: SharedMemorySyncDiagnostics,
  failedPeers: 'max' | 'sum',
): SharedMemorySyncAggregate {
  const sum = (key: keyof SharedMemorySyncDiagnostics): number =>
    Number(a[key] ?? 0) + Number(b[key] ?? 0);
  const swmCoverage = selectSwmSnapshotCoverage(a.swmCoverage, b.swmCoverage);
  return {
    localYield: mergeSharedMemoryLocalYield(a.localYield, b.localYield),
    snapshotPlaneIncomplete: sum('snapshotPlaneIncomplete'),
    insertedTriples: Number('insertedTriples' in a ? a.insertedTriples : 0)
      + Number('insertedTriples' in b ? b.insertedTriples : 0),
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
    deniedPhases: Number('deniedPhases' in a ? a.deniedPhases : 0)
      + Number('deniedPhases' in b ? b.deniedPhases : 0),
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
