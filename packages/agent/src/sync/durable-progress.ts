import type { DurableSyncResult } from '../dkg-agent-types.js';

/**
 * The common progress counters emitted by durable and shared-memory sync.
 * Fields are optional so older callers and diagnostic projections can be
 * classified without first manufacturing a full requester result.
 */
export interface DurableProgressSummary {
  readonly insertedTriples?: number;
  readonly insertedDataTriples?: number;
  readonly insertedMetaTriples?: number;
  readonly metaOnlyResponses?: number;
  readonly verifiedPrivateOnlyResponses?: number;
  readonly dataRejectedMissingMeta?: number;
  readonly rejectedKcs?: number;
  readonly resumedPhases?: number;
  readonly completedPhases?: number;
  readonly checkpointAdvances?: number;
  readonly timedOutPhases?: number;
  readonly failedPeers?: number;
  readonly failedPhases?: number;
  readonly deniedPhases?: number;
  readonly backoffWorthyFailures?: number;
  readonly deferredBackpressure?: number;
}

/** Explicit durable-only lifecycle state; generic/shared-memory callers omit it. */
export interface DurableProgressClassificationOptions {
  readonly complete?: boolean;
}

/** Typed policy decisions shared by reconnect and explicit catch-up paths. */
export interface DurableProgressClassification {
  readonly insertedDataTriples: number;
  readonly hasInsertedData: boolean;
  readonly hasMetadataEvidence: boolean;
  readonly hasVerifiedPrivateOnlyResponse: boolean;
  readonly hasCleanVerifiedPrivateOnlyCompletion: boolean;
  readonly integrityRejected: boolean;
  readonly metadataOnly: boolean;
  readonly timedOut: boolean;
  readonly transportFailed: boolean;
  readonly phaseFailed: boolean;
  readonly denied: boolean;
  readonly deferredByBackpressure: boolean;
  readonly hasBlockingFailure: boolean;
  readonly backoffWorthyFailure: boolean;
  readonly madeReconnectProgress: boolean;
  readonly madeReadinessProgress: boolean;
  readonly completedWithoutFailure: boolean;
  readonly completedReadinessCleanly: boolean;
  readonly cleanNonMetadataResponse: boolean;
}

/**
 * Normalize durable progress once, then let callers apply their local action
 * (peer freshness, catch-up success, or subscription readiness) to named
 * decisions instead of rebuilding the counter predicates independently.
 */
export function classifyDurableProgress(
  progress: DurableProgressSummary | null | undefined,
  options: DurableProgressClassificationOptions = {},
): DurableProgressClassification {
  const insertedTriples = progress?.insertedTriples ?? 0;
  const insertedMetaTriples = progress?.insertedMetaTriples ?? 0;
  const metaOnlyResponses = progress?.metaOnlyResponses ?? 0;
  const completedPhases = progress?.completedPhases ?? 0;
  const checkpointAdvances = progress?.checkpointAdvances ?? 0;
  const resumedPhases = progress?.resumedPhases ?? 0;
  const verifiedPrivateOnlyResponses = progress?.verifiedPrivateOnlyResponses ?? 0;

  const timedOut = (progress?.timedOutPhases ?? 0) > 0;
  const transportFailed = (progress?.failedPeers ?? 0) > 0;
  const phaseFailed = (progress?.failedPhases ?? 0) > 0;
  const denied = (progress?.deniedPhases ?? 0) > 0;
  const deferredByBackpressure = (progress?.deferredBackpressure ?? 0) > 0;
  const integrityRejected = (progress?.dataRejectedMissingMeta ?? 0) > 0
    || (progress?.rejectedKcs ?? 0) > 0;
  const hasVerifiedPrivateOnlyResponse = verifiedPrivateOnlyResponses > 0;
  const hasMetadataEvidence = insertedMetaTriples > 0 || metaOnlyResponses > 0;
  const hasBlockingFailure = timedOut
    || transportFailed
    || phaseFailed
    || denied
    || integrityRejected
    || deferredByBackpressure;

  // Reconnect freshness treats the private-only signal as authoritative only
  // when the durable phase that produced it is itself clean. Backpressure is
  // handled separately by reconnect accounting, matching the pre-classifier
  // policy while keeping partial-deferral progress observable.
  const hasCleanVerifiedPrivateOnlyCompletion = hasVerifiedPrivateOnlyResponse
    && options.complete !== false
    && metaOnlyResponses === 0
    && completedPhases > 0
    && !timedOut
    && !transportFailed
    && !phaseFailed
    && !denied
    && !integrityRejected;

  const metadataOnly = !hasCleanVerifiedPrivateOnlyCompletion
    && (progress?.insertedDataTriples ?? 0) === 0
    && (
      metaOnlyResponses > 0
      || (insertedMetaTriples > 0 && insertedTriples > 0)
    );
  const insertedDataTriples = progress?.insertedDataTriples
    ?? (metadataOnly ? 0 : insertedTriples);
  const hasInsertedData = insertedDataTriples > 0;

  const madeReconnectProgress = !integrityRejected && (
    hasInsertedData
    || hasCleanVerifiedPrivateOnlyCompletion
    || (!metadataOnly && (completedPhases > 0 || checkpointAdvances > 0))
  );

  // Explicit catch-up historically also treats a resumed completed phase as
  // progress. Keep that policy distinct from reconnect progress so neither
  // caller silently changes semantics during this consolidation.
  const madeReadinessProgress = (progress?.insertedDataTriples ?? insertedTriples) > 0
    || hasVerifiedPrivateOnlyResponse
    || checkpointAdvances > 0
    || (completedPhases > 0 && resumedPhases > 0);

  const completedWithoutFailure = progress != null
    && options.complete !== false
    && completedPhases > 0
    && !hasBlockingFailure;

  return {
    insertedDataTriples,
    hasInsertedData,
    hasMetadataEvidence,
    hasVerifiedPrivateOnlyResponse,
    hasCleanVerifiedPrivateOnlyCompletion,
    integrityRejected,
    metadataOnly,
    timedOut,
    transportFailed,
    phaseFailed,
    denied,
    deferredByBackpressure,
    hasBlockingFailure,
    backoffWorthyFailure: (progress?.backoffWorthyFailures ?? 0) > 0
      || transportFailed
      || timedOut,
    madeReconnectProgress,
    madeReadinessProgress,
    completedWithoutFailure,
    completedReadinessCleanly: completedWithoutFailure
      && (hasInsertedData || hasVerifiedPrivateOnlyResponse),
    cleanNonMetadataResponse: !transportFailed
      && !phaseFailed
      && !timedOut
      && !denied
      && !integrityRejected
      && !metadataOnly,
  };
}

/**
 * Canonical whole-run completion policy for durable requester lanes.
 * Callers provide only whether their lane reached its own terminal boundary;
 * the shared classifier owns every diagnostic counter that can invalidate it.
 */
export function isDurableSyncComplete(
  progress: DurableProgressSummary | null | undefined,
  reachedTerminalBoundary: boolean,
): boolean {
  return reachedTerminalBoundary
    && classifyDurableProgress(progress).completedWithoutFailure;
}

export interface DurableTerminalBoundaryOptions {
  /** Count this clean lane boundary as a completed diagnostic phase. */
  readonly countCompletedPhase?: boolean;
  /** Hide fallback phase completions when the authoritative lane is incomplete. */
  readonly clearCompletedPhasesWhenIncomplete?: boolean;
}

export type DurableSyncCounterReducer = 'sum' | 'max';

/**
 * Canonical runtime metadata for every numeric field in DurableSyncResult.
 * The satisfies clause makes a newly added counter a compile error until its
 * aggregation policy is declared here. Consumers can also reuse this table for
 * zero construction and normalized projections instead of duplicating fields.
 */
export const DURABLE_SYNC_COUNTER_REDUCERS = {
  insertedTriples: 'sum',
  fetchedMetaTriples: 'sum',
  fetchedDataTriples: 'sum',
  insertedMetaTriples: 'sum',
  insertedDataTriples: 'sum',
  bytesReceived: 'sum',
  resumedPhases: 'sum',
  timedOutPhases: 'sum',
  completedPhases: 'sum',
  checkpointAdvances: 'sum',
  emptyResponses: 'sum',
  metaOnlyResponses: 'sum',
  verifiedPrivateOnlyResponses: 'sum',
  dataRejectedMissingMeta: 'sum',
  rejectedKcs: 'sum',
  failedPeers: 'max',
  failedPhases: 'sum',
  deniedPhases: 'sum',
  backoffWorthyFailures: 'sum',
  deferredBackpressure: 'sum',
} as const satisfies Readonly<Record<
  Exclude<keyof DurableSyncResult, 'complete'>,
  DurableSyncCounterReducer
>>;

export type DurableSyncCounterKey = keyof typeof DURABLE_SYNC_COUNTER_REDUCERS;

/**
 * Internal durable aggregation state. The public `complete` verdict is absent
 * here by design: boundary aggregation and a finalized result must not share
 * one boolean whose meaning changes midway through a run.
 */
export interface DurableSyncAccumulator {
  diagnostics: InitializedDurableSyncDiagnostics;
  allTerminalBoundariesReached: boolean;
  observedTerminalBoundaries: number;
}

/** Start a neutral internal fold. It is never exposed as a public result. */
export function createDurableSyncAccumulator(): DurableSyncAccumulator {
  return {
    diagnostics: createDurableSyncDiagnosticsBase(),
    allTerminalBoundariesReached: true,
    observedTerminalBoundaries: 0,
  };
}

/** Convert one finalized public result into an internal fold contribution. */
export function durableSyncAccumulatorFromResult(
  result: DurableSyncResult,
): DurableSyncAccumulator {
  const { complete, ...diagnostics } = result;
  return {
    diagnostics: {
      ...createDurableSyncDiagnosticsBase(),
      ...diagnostics,
    },
    allTerminalBoundariesReached: complete === true,
    observedTerminalBoundaries: 1,
  };
}

function mergeDurableSyncDiagnostics(
  a: InitializedDurableSyncDiagnostics,
  b: InitializedDurableSyncDiagnostics,
): InitializedDurableSyncDiagnostics {
  const merged = createDurableSyncDiagnosticsBase();
  const counters = merged as Record<DurableSyncCounterKey, number>;
  for (const key of Object.keys(DURABLE_SYNC_COUNTER_REDUCERS) as DurableSyncCounterKey[]) {
    counters[key] = DURABLE_SYNC_COUNTER_REDUCERS[key] === 'max'
      ? Math.max(a[key], b[key])
      : a[key] + b[key];
  }
  return merged;
}

/** Mutate one internal aggregate with another; no public verdict is manufactured. */
export function mergeDurableSyncAccumulatorInto(
  target: DurableSyncAccumulator,
  part: DurableSyncAccumulator,
): DurableSyncAccumulator {
  Object.assign(
    target.diagnostics,
    mergeDurableSyncDiagnostics(target.diagnostics, part.diagnostics),
  );
  target.allTerminalBoundariesReached =
    target.allTerminalBoundariesReached && part.allTerminalBoundariesReached;
  target.observedTerminalBoundaries += part.observedTerminalBoundaries;
  return target;
}

/** Fold a finalized lane result into an existing internal aggregate. */
export function mergeDurableSyncResultIntoAccumulator(
  accumulator: DurableSyncAccumulator,
  result: DurableSyncResult,
): DurableSyncAccumulator {
  return mergeDurableSyncAccumulatorInto(
    accumulator,
    durableSyncAccumulatorFromResult(result),
  );
}

/**
 * Record one lane's terminal boundary in internal state. Once any requested
 * lane is incomplete, later clean lanes cannot make the whole run complete.
 *
 * Diagnostic phase synthesis also lives here so lanes never duplicate the
 * blocking-counter policy when reporting an authoritative completion.
 */
export function markDurableTerminalBoundary(
  accumulator: DurableSyncAccumulator,
  reachedTerminalBoundary: boolean,
  options: DurableTerminalBoundaryOptions = {},
): DurableSyncAccumulator {
  const result = accumulator.diagnostics;
  if (!reachedTerminalBoundary && options.clearCompletedPhasesWhenIncomplete) {
    result.completedPhases = 0;
  }
  if (
    reachedTerminalBoundary
    && options.countCompletedPhase
    && !classifyDurableProgress(result).hasBlockingFailure
  ) {
    result.completedPhases += 1;
  }
  accumulator.allTerminalBoundariesReached =
    accumulator.allTerminalBoundariesReached && reachedTerminalBoundary;
  accumulator.observedTerminalBoundaries += 1;
  return accumulator;
}

/** Assign the public completion verdict once, after every lane is folded. */
export function finalizeDurableSyncCompletion(
  accumulator: DurableSyncAccumulator,
): InitializedDurableSyncResult {
  return {
    ...accumulator.diagnostics,
    complete: accumulator.observedTerminalBoundaries > 0
      && isDurableSyncComplete(
        accumulator.diagnostics,
        accumulator.allTerminalBoundariesReached,
      ),
  };
}

export type InitializedDurableSyncResult = DurableSyncResult & Required<Pick<
  DurableSyncResult,
  'backoffWorthyFailures' | 'deferredBackpressure'
>>;

export type InitializedDurableSyncDiagnostics = Omit<InitializedDurableSyncResult, 'complete'>;

function createDurableSyncDiagnosticsBase(): InitializedDurableSyncDiagnostics {
  return Object.fromEntries(
    Object.keys(DURABLE_SYNC_COUNTER_REDUCERS).map((key) => [key, 0]),
  ) as InitializedDurableSyncDiagnostics;
}

/** No work completed, but the caller must keep retrying. */
export function createIncompleteDurableSyncResult(): InitializedDurableSyncResult {
  return { ...createDurableSyncDiagnosticsBase(), complete: false };
}

/** A peer attempt failed before producing a usable durable result. */
export function createFailedPeerDurableSyncResult(): InitializedDurableSyncResult {
  return { ...createIncompleteDurableSyncResult(), failedPeers: 1 };
}
