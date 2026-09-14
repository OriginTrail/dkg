// SPDX-License-Identifier: Apache-2.0

import {
  classifyDurableProgress,
  type DurableProgressClassification,
} from './durable-progress.js';
import {
  emptySharedMemorySyncResult,
  mergeFleetSharedMemoryDiagnostics,
  type SharedMemorySyncAggregate,
  type SharedMemorySyncResult,
} from './shared-memory-diagnostics.js';

export interface SharedMemoryCatchupPeerSets {
  readonly responded: Set<string>;
  readonly succeeded: Set<string>;
  readonly denied: Set<string>;
  readonly completedCleanly: Set<string>;
}

export interface SharedMemoryCatchupRoundAggregation {
  diagnostics: SharedMemorySyncAggregate;
  insertedDataTriples: number;
  jobDeferredBackpressure: number;
  cleanDataTriples: number;
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
    peers: {
      responded: peers.responded ?? new Set<string>(),
      succeeded: peers.succeeded ?? new Set<string>(),
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
  /** Combined durable plus SWM rounds let their caller own the joint success verdict. */
  readonly trackSucceeded?: boolean;
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
  aggregate.diagnostics = mergeFleetSharedMemoryDiagnostics(
    aggregate.diagnostics,
    options.diagnosticsResult ?? shared,
  );
  aggregate.insertedDataTriples += shared.insertedDataTriples;
  if (options.countJobDeferral !== false) {
    aggregate.jobDeferredBackpressure += shared.deferredBackpressure ?? 0;
  }

  if (progress.completedWithoutFailure) {
    aggregate.peers.completedCleanly.add(peerId);
    if (shared.insertedDataTriples > 0) {
      aggregate.cleanDataTriples += shared.insertedDataTriples;
    }
  }
  if (progress.denied) aggregate.peers.denied.add(peerId);

  const responded = !progress.transportFailed
    && (!progress.deferredByBackpressure || (
      shared.bytesReceived > 0
      || shared.completedPhases > 0
      || shared.emptyResponses > 0
      || shared.insertedMetaTriples > 0
      || shared.insertedDataTriples > 0
    ));
  if (responded) aggregate.peers.responded.add(peerId);

  if (
    options.trackSucceeded !== false
    && responded
    && !progress.phaseFailed
    && !progress.denied
    && !progress.deferredByBackpressure
    && !progress.timedOut
    && !progress.integrityRejected
    && (progress.madeReadinessProgress || !progress.hasMetadataEvidence)
  ) {
    aggregate.peers.succeeded.add(peerId);
  }
  return progress;
}

export function sharedMemoryCatchupPlaneProven(
  aggregate: SharedMemoryCatchupRoundAggregation,
): boolean {
  return aggregate.cleanDataTriples > 0;
}
