import type { CatchupJobResult } from '../../src/catchup-runner.js';

export function cleanEmptyResult(): CatchupJobResult {
  return {
    connectedPeers: 1,
    totalPeers: 1,
    selectedPeers: 1,
    syncCapablePeers: 1,
    peersTried: 1,
    peersResponded: 1,
    peersSucceeded: 1,
    dataSynced: 0,
    sharedMemorySynced: 0,
    denied: false,
    deniedPeers: 0,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 0, emptyPeers: 1 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 1 },
    },
    diagnostics: {
      noProtocolPeers: 0,
      durable: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        timedOutPhases: 0,
        completedPhases: 2,
        checkpointAdvances: 0,
        emptyResponses: 1,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
        failedPhases: 0,
      },
      sharedMemory: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        timedOutPhases: 0,
        completedPhases: 2,
        checkpointAdvances: 0,
        emptyResponses: 1,
        droppedDataTriples: 0,
        failedPeers: 0,
        failedPhases: 0,
      },
    },
  };
}

export function privateMetaOnlyResult(): CatchupJobResult {
  const result = cleanEmptyResult();
  if (!result.diagnostics?.durable) throw new Error('durable diagnostics missing');
  result.diagnostics.durable.emptyResponses = 0;
  result.diagnostics.durable.fetchedMetaTriples = 7;
  result.diagnostics.durable.insertedMetaTriples = 1;
  result.diagnostics.durable.metaOnlyResponses = 1;
  if (!result.cleanPlaneCompletions) throw new Error('clean completion proof missing');
  result.cleanPlaneCompletions.durable.emptyPeers = 0;
  return result;
}

export function privateDataOnlyResult(): CatchupJobResult {
  const result = cleanEmptyResult();
  if (!result.diagnostics?.durable || !result.diagnostics.sharedMemory) {
    throw new Error('catch-up diagnostics missing');
  }
  result.dataSynced = 3;
  result.diagnostics.durable.emptyResponses = 0;
  result.diagnostics.durable.fetchedDataTriples = 3;
  result.diagnostics.durable.insertedDataTriples = 3;
  result.diagnostics.sharedMemory.emptyResponses = 0;
  result.diagnostics.sharedMemory.completedPhases = 0;
  result.diagnostics.sharedMemory.timedOutPhases = 1;
  if (!result.cleanPlaneCompletions) throw new Error('clean completion proof missing');
  result.cleanPlaneCompletions.durable = { verifiedDataPeers: 1, emptyPeers: 0 };
  result.cleanPlaneCompletions.sharedMemory = { verifiedDataPeers: 0, emptyPeers: 0 };
  return result;
}

export function privateSharedMemoryOnlyResult(): CatchupJobResult {
  const result = cleanEmptyResult();
  if (!result.diagnostics?.sharedMemory) {
    throw new Error('shared-memory diagnostics missing');
  }
  result.sharedMemorySynced = 4;
  result.diagnostics.sharedMemory.emptyResponses = 0;
  result.diagnostics.sharedMemory.fetchedDataTriples = 4;
  result.diagnostics.sharedMemory.insertedDataTriples = 4;
  if (!result.cleanPlaneCompletions) throw new Error('clean completion proof missing');
  result.cleanPlaneCompletions.sharedMemory = { verifiedDataPeers: 1, emptyPeers: 0 };
  return result;
}

export function publicDurableAndSharedMemoryResult(): CatchupJobResult {
  const result = cleanEmptyResult();
  if (!result.diagnostics?.durable || !result.diagnostics.sharedMemory) {
    throw new Error('catch-up diagnostics missing');
  }
  if (!result.cleanPlaneCompletions) throw new Error('clean completion proof missing');
  result.dataSynced = 3;
  result.sharedMemorySynced = 4;
  result.diagnostics.durable.emptyResponses = 0;
  result.diagnostics.durable.fetchedDataTriples = 3;
  result.diagnostics.durable.insertedDataTriples = 3;
  result.diagnostics.sharedMemory.emptyResponses = 0;
  result.diagnostics.sharedMemory.fetchedDataTriples = 4;
  result.diagnostics.sharedMemory.insertedDataTriples = 4;
  result.cleanPlaneCompletions.durable = { verifiedDataPeers: 1, emptyPeers: 0 };
  result.cleanPlaneCompletions.sharedMemory = { verifiedDataPeers: 1, emptyPeers: 0 };
  return result;
}
