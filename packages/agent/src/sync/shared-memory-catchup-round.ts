// SPDX-License-Identifier: Apache-2.0

import {
  classifyDurableProgress,
  type DurableProgressClassification,
  type DurableProgressSummary,
} from './durable-progress.js';
import {
  emptySharedMemorySyncResult,
  mergeFleetSharedMemoryDiagnostics,
  sharedMemoryRoundFoundNothingMissing,
  type SharedMemorySyncAggregate,
  type SharedMemorySyncResult,
} from './shared-memory-diagnostics.js';

/** Normalized per-round content proof; consumers derive totals or peer counts from this record. */
export interface SharedMemoryRoundContentEvidence {
  readonly cleanDataTriples: number;
  readonly cleanHeldAssets: number;
  readonly verifiedPrivateOnly: boolean;
  readonly emptyResponse: boolean;
  readonly incompleteResponder: boolean;
}
export interface SharedMemoryRoundClassification extends DurableProgressClassification {
  readonly contentEvidence: SharedMemoryRoundContentEvidence;
}
type SharedMemoryRoundSummary = DurableProgressSummary & Pick<SharedMemorySyncResult,
  'alreadyHeldAssets' | 'catalogDeferredAssets' | 'supersededUnprovenAssets' | 'swmCoverage'>;

/** Normalize content once, retaining the selected-provider classifier's freshness verdict. */
export function classifySharedMemoryRound(shared: SharedMemoryRoundSummary,
  progress: DurableProgressClassification = classifyDurableProgress(shared)): SharedMemoryRoundClassification {
  const clean = progress.completedWithoutFailure;
  return { ...progress, contentEvidence: {
    cleanDataTriples: clean ? progress.insertedDataTriples : 0,
    cleanHeldAssets: clean && sharedMemoryRoundFoundNothingMissing(shared) ? shared.alreadyHeldAssets ?? 0 : 0,
    verifiedPrivateOnly: clean && (shared.verifiedPrivateOnlyResponses ?? 0) > 0,
    emptyResponse: clean && (shared.emptyResponses ?? 0) > 0,
    incompleteResponder: !clean && (shared.failedPeers ?? 0) === 0,
  } };
}

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
  peers: Partial<SharedMemoryCatchupPeerSets> = {},
): SharedMemoryCatchupRoundAggregation {
  return {
    diagnostics: emptySharedMemorySyncResult(),
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
): SharedMemoryRoundClassification {
  const progress = classifySharedMemoryRound(shared, options.progress);
  aggregate.diagnostics = mergeFleetSharedMemoryDiagnostics(aggregate.diagnostics, shared);
  aggregate.insertedDataTriples += progress.insertedDataTriples;
  if (options.countJobDeferral !== false) {
    aggregate.jobDeferredBackpressure += shared.deferredBackpressure ?? 0;
  }

  if (progress.completedWithoutFailure) aggregate.peers.completedCleanly.add(peerId);
  aggregate.cleanHeldAssets += progress.contentEvidence.cleanHeldAssets;
  aggregate.cleanDataTriples += progress.contentEvidence.cleanDataTriples;
  if (progress.denied) aggregate.peers.denied.add(peerId);

  if (progress.responded) aggregate.peers.responded.add(peerId);

  return progress;
}

export function sharedMemoryCatchupPlaneProven(
  aggregate: SharedMemoryCatchupRoundAggregation,
): boolean {
  return aggregate.cleanDataTriples > 0 || aggregate.cleanHeldAssets > 0;
}
