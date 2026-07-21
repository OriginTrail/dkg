import { describe, expect, it } from 'vitest';
import type { CatchupJobResult } from '../src/catchup-runner.js';
import { classifyContextGraphCatchupReadiness } from '../src/context-graph-readiness.js';

function mixedPeerResult(verifiedDataPeers: number): CatchupJobResult {
  return {
    connectedPeers: 2,
    totalPeers: 2,
    selectedPeers: 2,
    syncCapablePeers: 2,
    peersTried: 2,
    peersResponded: 2,
    peersSucceeded: verifiedDataPeers > 0 ? 1 : 0,
    dataSynced: 5,
    sharedMemorySynced: 0,
    denied: true,
    deniedPeers: 1,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
    },
    diagnostics: {
      noProtocolPeers: 0,
      durable: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 5,
        insertedMetaTriples: 0,
        insertedDataTriples: 5,
        bytesReceived: 50,
        resumedPhases: 0,
        timedOutPhases: 1,
        completedPhases: 1,
        checkpointAdvances: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
        failedPhases: 0,
        deniedPhases: 1,
      },
      sharedMemory: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        timedOutPhases: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
        failedPhases: 0,
        deniedPhases: 0,
      },
    },
  };
}

describe('context graph catch-up readiness classification', () => {
  const readinessBeforeCatchup = {
    version: 0,
    durableVerified: false,
    sharedMemoryVerified: false,
    updatedAt: 0,
  };

  it('uses a clean per-peer completion even when aggregate diagnostics contain denial and timeout', () => {
    const classification = classifyContextGraphCatchupReadiness({
      result: mixedPeerResult(1),
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: true,
      readinessBeforeCatchup,
    });

    expect(classification).toMatchObject({
      jobStatus: 'done',
      statePatch: {
        synced: true,
        sharedMemorySynced: false,
      },
      readinessPatch: {
        durableVerified: true,
        sharedMemoryVerified: false,
      },
    });
  });

  it('uses a clean private-only durable completion even when another peer denies and times out', () => {
    const result = mixedPeerResult(0);
    result.dataSynced = 0;
    result.peersSucceeded = 1;
    if (!result.cleanPlaneCompletions || !result.diagnostics?.durable) {
      throw new Error('durable completion evidence missing');
    }
    result.cleanPlaneCompletions.durable.verifiedPrivateOnlyPeers = 1;
    result.diagnostics.durable.fetchedDataTriples = 0;
    result.diagnostics.durable.insertedDataTriples = 0;
    result.diagnostics.durable.verifiedPrivateOnlyResponses = 1;

    const classification = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: true,
      readinessBeforeCatchup,
    });

    expect(classification).toMatchObject({
      jobStatus: 'done',
      statePatch: {
        synced: true,
        sharedMemorySynced: false,
      },
      readinessPatch: {
        durableVerified: true,
        sharedMemoryVerified: false,
      },
      eventPayload: {
        dataSynced: 0,
        sharedMemorySynced: 0,
        verifiedPrivateOnlyResponses: 1,
      },
    });
  });

  it('accepts legacy-runner diagnostics for a clean verified private-only durable response', () => {
    const result = mixedPeerResult(0);
    delete result.cleanPlaneCompletions;
    result.dataSynced = 0;
    result.denied = false;
    result.deniedPeers = 0;
    result.peersSucceeded = 1;
    if (!result.diagnostics?.durable) throw new Error('durable diagnostics missing');
    result.diagnostics.durable.fetchedMetaTriples = 8;
    result.diagnostics.durable.fetchedDataTriples = 0;
    result.diagnostics.durable.insertedMetaTriples = 8;
    result.diagnostics.durable.insertedDataTriples = 0;
    result.diagnostics.durable.verifiedPrivateOnlyResponses = 1;
    result.diagnostics.durable.timedOutPhases = 0;
    result.diagnostics.durable.deniedPhases = 0;

    const classification = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: true,
      readinessBeforeCatchup,
    });

    expect(classification).toMatchObject({
      jobStatus: 'done',
      readinessPatch: {
        durableVerified: true,
        sharedMemoryVerified: false,
      },
      eventPayload: {
        verifiedPrivateOnlyResponses: 1,
      },
    });
  });

  it('keeps same-peer partial progress unready when no peer completed cleanly', () => {
    const result = mixedPeerResult(0);
    // The worker may count a peer that committed useful partial progress as a
    // liveness success. That counter is deliberately not readiness evidence.
    result.peersSucceeded = 1;
    const classification = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: true,
      readinessBeforeCatchup,
    });

    expect(classification).toMatchObject({
      jobStatus: 'unreachable',
      readinessPatch: {
        durableVerified: false,
        sharedMemoryVerified: false,
      },
    });
    expect(classification.eventPayload).toBeUndefined();
  });

  it('accepts a public clean-empty peer when another peer denies', () => {
    const result = mixedPeerResult(0);
    result.dataSynced = 0;
    result.peersSucceeded = 1;
    if (!result.cleanPlaneCompletions || !result.diagnostics?.durable) {
      throw new Error('durable completion evidence missing');
    }
    result.cleanPlaneCompletions.durable.emptyPeers = 1;
    result.diagnostics.durable.fetchedDataTriples = 0;
    result.diagnostics.durable.insertedDataTriples = 0;
    result.diagnostics.durable.emptyResponses = 1;

    const classification = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    });

    expect(classification).toMatchObject({
      jobStatus: 'done',
      statePatch: {
        synced: true,
        sharedMemorySynced: false,
      },
      readinessPatch: {
        durableVerified: true,
        sharedMemoryVerified: false,
      },
    });
  });
});
