// SPDX-License-Identifier: Apache-2.0

export interface ProjectSyncedReadinessPayload {
  contextGraphId: string;
  dataSynced: number;
  sharedMemorySynced: number;
  /** Assets of clean shared-memory rounds that found nothing missing: already held here. */
  sharedMemoryHeldAssets: number;
  /** Assets of clean durable rounds that found their whole generation stored and current. */
  durableHeldAssets: number;
  verifiedPrivateOnlyResponses: number;
}

export function parseProjectSyncedReadinessPayload(
  data: unknown,
): ProjectSyncedReadinessPayload | null {
  if (!data || typeof data !== 'object') return null;
  const candidate = data as Partial<ProjectSyncedReadinessPayload>;
  if (
    typeof candidate.contextGraphId !== 'string' ||
    typeof candidate.dataSynced !== 'number' ||
    !Number.isFinite(candidate.dataSynced) ||
    typeof candidate.sharedMemorySynced !== 'number' ||
    !Number.isFinite(candidate.sharedMemorySynced) ||
    (
      candidate.sharedMemoryHeldAssets !== undefined
      && (typeof candidate.sharedMemoryHeldAssets !== 'number' || !Number.isFinite(candidate.sharedMemoryHeldAssets))
    ) ||
    (
      candidate.durableHeldAssets !== undefined
      && (typeof candidate.durableHeldAssets !== 'number' || !Number.isFinite(candidate.durableHeldAssets))
    ) ||
    (
      candidate.verifiedPrivateOnlyResponses !== undefined
      && (
        typeof candidate.verifiedPrivateOnlyResponses !== 'number'
        || !Number.isFinite(candidate.verifiedPrivateOnlyResponses)
      )
    )
  ) {
    return null;
  }
  return {
    contextGraphId: candidate.contextGraphId,
    dataSynced: candidate.dataSynced,
    sharedMemorySynced: candidate.sharedMemorySynced,
    sharedMemoryHeldAssets: candidate.sharedMemoryHeldAssets ?? 0,
    durableHeldAssets: candidate.durableHeldAssets ?? 0,
    verifiedPrivateOnlyResponses: candidate.verifiedPrivateOnlyResponses ?? 0,
  };
}
