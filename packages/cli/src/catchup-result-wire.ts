/** Per-plane clean-completion evidence safe to expose on the status wire. */
export interface CatchupPlaneCompletionEvidence {
  verifiedDataPeers: number;
  verifiedPrivateOnlyPeers?: number;
  emptyPeers: number;
  authorityEmptyPeers?: number;
  incompleteResponders?: number;
}

/** Stable per-attempt result exposed by the catch-up status API. */
export interface CatchupJobResult {
  connectedPeers: number;
  totalPeers?: number;
  selectedPeers?: number;
  syncCapablePeers: number;
  peersTried: number;
  /** Peers that reached a responder without collapsing into transport failure. */
  peersResponded: number;
  /** Peers whose requested sync round completed cleanly. */
  peersSucceeded: number;
  /** Sync-capable peers skipped after an earlier wave proved every requested plane. */
  peersNotAttempted?: number;
  /** Context Graph phases deferred by this node's local sync scheduler. */
  deferredBackpressure: number;
  dataSynced: number;
  sharedMemorySynced: number;
  denied: boolean;
  deniedPeers: number;
  cleanPlaneCompletions?: {
    durable: CatchupPlaneCompletionEvidence & { verifiedPrivateOnlyPeers: number };
    sharedMemory: CatchupPlaneCompletionEvidence;
  };
  diagnostics?: {
    noProtocolPeers: number;
    durable: {
      fetchedMetaTriples: number;
      fetchedDataTriples: number;
      insertedMetaTriples: number;
      insertedDataTriples: number;
      bytesReceived: number;
      resumedPhases: number;
      timedOutPhases: number;
      completedPhases: number;
      checkpointAdvances: number;
      emptyResponses: number;
      metaOnlyResponses: number;
      /** Cryptographically verified V2 responses whose public graph is intentionally empty. */
      verifiedPrivateOnlyResponses: number;
      dataRejectedMissingMeta: number;
      rejectedKcs: number;
      failedPeers: number;
      failedPhases: number;
      deferredBackpressure: number;
      deniedPhases?: number;
      authorityUnanswered?: boolean;
    };
    sharedMemory: {
      fetchedMetaTriples: number;
      fetchedDataTriples: number;
      insertedMetaTriples: number;
      insertedDataTriples: number;
      bytesReceived: number;
      resumedPhases: number;
      timedOutPhases: number;
      completedPhases: number;
      checkpointAdvances: number;
      emptyResponses: number;
      droppedDataTriples: number;
      failedPeers: number;
      failedPhases: number;
      deferredBackpressure: number;
      deniedPhases?: number;
      authorityUnanswered?: boolean;
    };
  };
}
