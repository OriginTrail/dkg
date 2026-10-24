import type { CatchupJobResult } from '../../src/catchup-runner.js';

type Diagnostics = NonNullable<CatchupJobResult['diagnostics']>;
export type ReadinessResult = CatchupJobResult & Required<Pick<CatchupJobResult, 'diagnostics' | 'cleanPlaneCompletions'>>;

export function durableDiagnostics(overrides: Partial<Diagnostics['durable']> = {}): Diagnostics['durable'] {
  return {
    fetchedMetaTriples: 0, fetchedDataTriples: 0, insertedMetaTriples: 0, insertedDataTriples: 0,
    bytesReceived: 0, resumedPhases: 0, timedOutPhases: 0, completedPhases: 0,
    checkpointAdvances: 0, emptyResponses: 0, metaOnlyResponses: 0, verifiedPrivateOnlyResponses: 0,
    dataRejectedMissingMeta: 0, rejectedKcs: 0, failedPeers: 0, failedPhases: 0,
    deferredBackpressure: 0, deniedPhases: 0, ...overrides,
  };
}

export function sharedMemoryDiagnostics(overrides: Partial<Diagnostics['sharedMemory']> = {}): Diagnostics['sharedMemory'] {
  return {
    fetchedMetaTriples: 0, fetchedDataTriples: 0, insertedMetaTriples: 0, insertedDataTriples: 0,
    bytesReceived: 0, resumedPhases: 0, timedOutPhases: 0, completedPhases: 0,
    checkpointAdvances: 0, emptyResponses: 0, droppedDataTriples: 0, failedPeers: 0, failedPhases: 0,
    deferredBackpressure: 0, deniedPhases: 0, snapshotPlaneIncomplete: 0, continuationPasses: 0,
    replayPhaseBytesReceived: 0, snapshotPhaseBytesReceived: 0, ...overrides,
  };
}

/** An unresponsive round, with complete typed diagnostics for scenario-specific edits. */
export function catchupReadinessResult(overrides: Partial<ReadinessResult> = {}): ReadinessResult {
  return {
    connectedPeers: 0, totalPeers: 0, selectedPeers: 0, syncCapablePeers: 0,
    peersTried: 0, peersResponded: 0, peersSucceeded: 0, deferredBackpressure: 0,
    dataSynced: 0, sharedMemorySynced: 0, denied: false, deniedPeers: 0,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 0, verifiedPrivateOnlyPeers: 0, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
    },
    diagnostics: { noProtocolPeers: 0, durable: durableDiagnostics(), sharedMemory: sharedMemoryDiagnostics() },
    ...overrides,
  };
}
