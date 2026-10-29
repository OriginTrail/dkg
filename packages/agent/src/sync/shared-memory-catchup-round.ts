// SPDX-License-Identifier: Apache-2.0

import {
  classifyDurableProgress,
  type DurableProgressClassification,
} from './durable-progress.js';
import {
  emptySharedMemorySyncResult,
  mergeFleetSharedMemoryDiagnostics,
  sharedMemoryRoundFoundNothingMissing,
  type SharedMemorySyncAggregate,
  type SharedMemorySyncResult,
} from './shared-memory-diagnostics.js';

export interface SharedMemoryCatchupPeerSets {
  readonly responded: Set<string>;
  readonly denied: Set<string>;
  readonly completedCleanly: Set<string>;
}

export interface SharedMemoryCatchupRoundAggregation {
  diagnostics: SharedMemorySyncAggregate;
  insertedDataTriples: number;
  jobDeferredBackpressure: number;
  cleanDataTriples: number;
  cleanHeldAssets: number;
  readonly peers: SharedMemoryCatchupPeerSets;
}

export function createSharedMemoryCatchupRoundAggregation(
  diagnostics: SharedMemorySyncAggregate = emptySharedMemorySyncResult(),
  peers: Partial<SharedMemoryCatchupPeerSets> = {},
): SharedMemoryCatchupRoundAggregation {
  return {
    diagnostics,
    insertedDataTriples: 0,
    jobDeferredBackpressure: 0,
    cleanDataTriples: 0,
    cleanHeldAssets: 0,
    peers: {
      responded: peers.responded ?? new Set<string>(),
      denied: peers.denied ?? new Set<string>(),
      completedCleanly: peers.completedCleanly ?? new Set<string>(),
    },
  };
}

export interface FoldSharedMemoryRoundOptions {
  /** Selected-provider freshness may resolve historical yield counters. */
  readonly progress?: DurableProgressClassification;
  /** Coverage may carry authority attribution used only in aggregate diagnostics. */
  readonly diagnosticsResult?: SharedMemorySyncResult;
  /** Extra best-effort passes cannot demote readiness earned by pass one. */
  readonly countJobDeferral?: boolean;
}

/**
 * Fold one peer SWM result into the shared catch-up state used by both drivers.
 * Every diagnostic, distinct-peer set, readiness counter, and job-level
 * deferral scalar is updated here so a new result field cannot drift between
 * the in-agent and Worker implementations.
 */
export function foldSharedMemoryRound(
  aggregate: SharedMemoryCatchupRoundAggregation,
  peerId: string,
  shared: SharedMemorySyncResult,
  options: FoldSharedMemoryRoundOptions = {},
): DurableProgressClassification {
  const progress = options.progress ?? classifyDurableProgress(shared);
  const mergedDiagnostics = mergeFleetSharedMemoryDiagnostics(
    aggregate.diagnostics,
    options.diagnosticsResult ?? shared,
  );
  // Keep the accumulator's diagnostics object stable. Both drivers seed their
  // public result with this same object; replacing it here leaves the result
  // holding a stale snapshot while later rounds continue updating the new one.
  Object.assign(aggregate.diagnostics, mergedDiagnostics);
  aggregate.insertedDataTriples += progress.insertedDataTriples;
  if (options.countJobDeferral !== false) {
    aggregate.jobDeferredBackpressure += shared.deferredBackpressure ?? 0;
  }

  if (progress.completedWithoutFailure) {
    aggregate.peers.completedCleanly.add(peerId);
    if (sharedMemoryRoundFoundNothingMissing(shared)) {
      aggregate.cleanHeldAssets += shared.alreadyHeldAssets ?? 0;
    }
    if (progress.insertedDataTriples > 0) {
      aggregate.cleanDataTriples += progress.insertedDataTriples;
    }
  }
  if (progress.denied) aggregate.peers.denied.add(peerId);

  if (progress.responded) aggregate.peers.responded.add(peerId);

  return progress;
}

export function sharedMemoryCatchupPlaneProven(
  aggregate: SharedMemoryCatchupRoundAggregation,
): boolean {
  return aggregate.cleanDataTriples > 0 || aggregate.cleanHeldAssets > 0;
}
