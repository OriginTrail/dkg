import type {
  SharedMemorySyncDiagnostics,
  SharedMemorySyncResult,
} from '../dkg-agent-types.js';
import {
  classifyDurableProgress,
  type DurableProgressClassification,
  type DurableProgressClassificationOptions,
  type DurableProgressSummary,
} from './durable-progress.js';

export interface SharedMemoryFreshnessSummary extends DurableProgressSummary {
  readonly snapshotPlaneIncomplete?: number;
  readonly resolvedSnapshotPlaneIncomplete?: number;
  readonly metadataContinuationYields?: number;
  readonly resolvedMetadataContinuationYields?: number;
}

/**
 * Terminal verdict produced only by the priority selected-SWM lane.
 *
 * This contract lives with the shared-memory freshness domain rather than an
 * orchestration consumer so every producer and consumer shares the same
 * fail-closed, discriminated result shape.
 */
export interface SelectedSharedMemorySyncResult {
  readonly kind: 'selected-shared-memory';
  /** Full diagnostics stay available even though completion is lane-specific. */
  readonly shared: SharedMemorySyncResult;
  /** Terminal verdict for the selected-public subset. */
  readonly selectedScopeComplete: boolean;
  /** Terminal verdict for the exact public/private RFC-64 recovery request. */
  readonly recoveryPlanComplete: boolean;
}

/**
 * Producer-side evidence that a later selected-provider continuation resolved
 * historical voluntary snapshot yields from the same invocation.
 */
export interface SelectedSwmFreshnessResolution {
  readonly recoverableSnapshotYieldFailures: number;
  readonly recoverableMetadataContinuationYields?: number;
}

export interface SelectedSwmRoundFreshness {
  readonly recoverableSnapshotYieldFailures: number;
  readonly recoverableMetadataContinuationYields: number;
  readonly snapshotPlaneComplete: boolean;
}

/**
 * Classify one selected public-SWM round for freshness supersession.
 *
 * A yield is recoverable only when it is the round's sole failure signal and
 * the provider supplied a coherent, incomplete snapshot manifest. Completion
 * is deliberately stricter: the same Context Graph must be fully materialized
 * and the ordinary progress classifier must find no blocking failure.
 */
export function classifySelectedSwmRoundFreshness(
  contextGraphId: string,
  result: SharedMemorySyncResult,
): SelectedSwmRoundFreshness {
  const progress = classifyDurableProgress(result);
  const coverage = result.swmCoverage;
  const incomplete = Math.min(
    result.snapshotPlaneIncomplete ?? 0,
    result.failedPhases ?? 0,
  );
  const recoverableSnapshotYieldFailures = incomplete > 0
    && result.failedPeers === 0
    && result.timedOutPhases === 0
    && result.deniedPhases === 0
    && (result.backoffWorthyFailures ?? 0) === 0
    && (result.deferredBackpressure ?? 0) === 0
    && result.failedPhases === incomplete
    && coverage?.contextGraphId === contextGraphId
    && coverage?.manifestComplete === true
    && coverage.descriptorsAuthoritative === true
    && coverage.materializationFailures === 0
    && coverage.snapshotsResolved < coverage.snapshotsTotal
      ? incomplete
      : 0;
  const metadataYields = result.metadataContinuationYields ?? 0;
  const recoverableMetadataContinuationYields = metadataYields > 0
    && result.failedPeers === 0
    && result.failedPhases === 0
    && result.deniedPhases === 0
    && (result.backoffWorthyFailures ?? 0) === 0
    && (result.deferredBackpressure ?? 0) === 0
    && result.timedOutPhases === metadataYields
      ? metadataYields
      : 0;

  return {
    recoverableSnapshotYieldFailures,
    recoverableMetadataContinuationYields,
    snapshotPlaneComplete: coverage?.contextGraphId === contextGraphId
      && coverage.manifestComplete
      && coverage.descriptorsAuthoritative === true
      && coverage.materializationFailures === 0
      && coverage.snapshotsResolved === coverage.snapshotsTotal
      && progress.completedWithoutFailure,
  };
}

/** Keep the freshness-only diagnostic additive when per-round results merge. */
export function mergeSharedMemoryFreshnessDiagnostics(
  a: SharedMemorySyncDiagnostics,
  b: SharedMemorySyncDiagnostics,
): Pick<
  SharedMemorySyncDiagnostics,
  'resolvedSnapshotPlaneIncomplete' | 'resolvedMetadataContinuationYields'
> {
  return {
    resolvedSnapshotPlaneIncomplete:
      (a.resolvedSnapshotPlaneIncomplete ?? 0)
      + (b.resolvedSnapshotPlaneIncomplete ?? 0),
    resolvedMetadataContinuationYields:
      (a.resolvedMetadataContinuationYields ?? 0)
      + (b.resolvedMetadataContinuationYields ?? 0),
  };
}

/**
 * Attach a selected-SWM freshness resolution to its final raw diagnostics.
 * The producer cannot emit an unbounded or non-integral supersession count.
 */
export function applySelectedSwmFreshnessResolution(
  result: SharedMemorySyncResult,
  resolution: SelectedSwmFreshnessResolution,
): SharedMemorySyncResult {
  const requested = resolution.recoverableSnapshotYieldFailures;
  const incomplete = result.snapshotPlaneIncomplete ?? 0;
  const failed = result.failedPhases;
  const countersAreValid = Number.isSafeInteger(requested)
    && requested > 0
    && Number.isSafeInteger(incomplete)
    && incomplete >= 0
    && Number.isSafeInteger(failed)
    && failed >= 0
    && incomplete <= failed;
  const resolvedSnapshotPlaneIncomplete = countersAreValid
    ? Math.min(
      requested,
      incomplete,
      failed,
    )
    : 0;
  const requestedMetadata = resolution.recoverableMetadataContinuationYields ?? 0;
  const metadataYields = result.metadataContinuationYields ?? 0;
  const timedOut = result.timedOutPhases;
  const metadataCountersAreValid = Number.isSafeInteger(requestedMetadata)
    && requestedMetadata > 0
    && Number.isSafeInteger(metadataYields)
    && metadataYields >= 0
    && Number.isSafeInteger(timedOut)
    && timedOut >= 0
    && metadataYields <= timedOut;
  const resolvedMetadataContinuationYields = metadataCountersAreValid
    ? Math.min(requestedMetadata, metadataYields, timedOut)
    : 0;
  return {
    ...result,
    resolvedSnapshotPlaneIncomplete,
    resolvedMetadataContinuationYields,
  };
}

/**
 * Canonical shared-memory freshness classification.
 *
 * Raw diagnostics remain unchanged for telemetry. Only a bounded resolution
 * produced by the selected-SWM continuation may supersede matching historical
 * voluntary-yield failures for this classification; every other failure
 * remains authoritative.
 */
export function classifySharedMemoryFreshness(
  result: SharedMemoryFreshnessSummary,
  options: DurableProgressClassificationOptions = {},
): DurableProgressClassification {
  const resolved = result.resolvedSnapshotPlaneIncomplete ?? 0;
  const incomplete = result.snapshotPlaneIncomplete ?? 0;
  const failed = result.failedPhases ?? 0;
  const normalized = Number.isSafeInteger(resolved)
    && resolved > 0
    && resolved <= incomplete
    && incomplete <= failed
      ? { ...result, failedPhases: failed - resolved }
      : result;
  const resolvedMetadata = result.resolvedMetadataContinuationYields ?? 0;
  const metadataYields = result.metadataContinuationYields ?? 0;
  const timedOut = normalized.timedOutPhases ?? 0;
  const metadataNormalized = Number.isSafeInteger(resolvedMetadata)
    && resolvedMetadata > 0
    && resolvedMetadata <= metadataYields
    && metadataYields <= timedOut
      ? { ...normalized, timedOutPhases: timedOut - resolvedMetadata }
      : normalized;
  return classifyDurableProgress(metadataNormalized, options);
}
