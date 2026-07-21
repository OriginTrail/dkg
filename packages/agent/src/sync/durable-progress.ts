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

  // Reconnect freshness treats the private-only signal as authoritative only
  // when the durable phase that produced it is itself clean. Backpressure is
  // handled separately by reconnect accounting, matching the pre-classifier
  // policy while keeping partial-deferral progress observable.
  const hasCleanVerifiedPrivateOnlyCompletion = hasVerifiedPrivateOnlyResponse
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
    && completedPhases > 0
    && !timedOut
    && !transportFailed
    && !phaseFailed
    && !integrityRejected
    && !deferredByBackpressure
    && !denied;

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
