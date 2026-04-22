import { describe, it, expect } from 'vitest';
import { createCatchupRunner } from '../src/catchup-runner.js';

describe('catchup runner worker loader', () => {
  it('creates a worker-backed catchup runner in source/test mode', async () => {
    const fakeAgent = {
      eventBus: { emit() {} },
      node: { libp2p: { getConnections: () => [] } },
      isPrivateContextGraph: async () => false,
      resolvePreferredSyncPeerId: async () => undefined,
      ensurePeerConnected: async () => undefined,
      primeCatchupConnections: async () => undefined,
      selectCatchupPeers: () => [],
      waitForSyncProtocol: async () => false,
      syncFromPeerDetailed: async () => ({
        insertedTriples: 0,
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
      }),
      syncSharedMemoryFromPeerDetailed: async () => ({
        insertedTriples: 0,
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
      }),
      refreshMetaSyncedFlags: async () => undefined,
    } as any;

    const runner = createCatchupRunner(fakeAgent);
    expect(runner).toBeDefined();
    await runner.close();
  });
});
