// SPDX-License-Identifier: Apache-2.0
import type { DurableSyncDiagnostics } from '../dkg-agent-types.js';
import type { SharedMemorySyncAggregate, SharedMemorySyncDiagnostics } from './shared-memory-diagnostics.js';

export interface CatchupSyncDiagnostics {
  noProtocolPeers: number;
  durable: DurableSyncDiagnostics;
  /** Broad compatibility contract retained for older CLI/worker producers. */
  sharedMemory: SharedMemorySyncDiagnostics;
}

/** Catch-up diagnostics produced by the in-process agent path. */
export interface ContextGraphCatchupDiagnostics extends CatchupSyncDiagnostics {
  sharedMemory: SharedMemorySyncAggregate;
}

/** Fields shared by the in-process and worker-backed catch-up results. */
export interface CatchupResultCore {
  /** Ordered connected peers before caller windowing. */
  connectedPeers: number;
  syncCapablePeers: number;
  /** Distinct selected peers actually contacted. */
  peersTried: number;
  /** Reached a responder, even if it later timed out, denied access, or served only metadata. */
  peersResponded: number;
  /** Completed without blocking failure, with progress or a clean non-metadata response. */
  peersSucceeded: number;
  /**
   * Required-pass local scheduler deferrals. Extra SWM continuation-pass
   * deferrals remain in diagnostics.sharedMemory.deferredBackpressure, so they
   * do not force the daemon's deferred short-circuit before readiness is checked.
   * Zero here is not proof of readiness: completion evidence must still pass.
   */
  deferredBackpressure: number;
  dataSynced: number;
  sharedMemorySynced: number;
  denied: boolean;
  deniedPeers: number;
}

/** Canonical in-process catch-up result; CLI workers may add optional evidence. */
export interface ContextGraphCatchupResult extends CatchupResultCore {
  /** Ordered connected peers before caller windowing. */
  totalPeers: number;
  /** Peers selected and evaluated after caller windowing. */
  selectedPeers: number;
  /** A clean SWM round delivered data or proved that all of its assets were already held. */
  sharedMemoryCompletedCleanly: boolean;
  /** Immutable evidence owned by this catch-up operation and its single-flight result. */
  cleanSharedMemoryPeerIds: readonly string[];
  diagnostics: ContextGraphCatchupDiagnostics;
}
