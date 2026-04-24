import { describe, it, expect } from 'vitest';
import { createCatchupRunner } from '../src/catchup-runner.js';
import { webcrypto } from 'node:crypto';

if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}

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

  it('only marks denied when no data was synced', async () => {
    const fakeAgent = {
      eventBus: { emit() {} },
      node: { libp2p: { getConnections: () => [] } },
      isPrivateContextGraph: async () => true,
      resolvePreferredSyncPeerId: async () => undefined,
      ensurePeerConnected: async () => undefined,
      primeCatchupConnections: async () => undefined,
      selectCatchupPeers: () => [{ toString: () => 'peer-a' }, { toString: () => 'peer-b' }],
      waitForSyncProtocol: async () => true,
      syncFromPeerDetailed: async (peerId: string) => ({
        insertedTriples: peerId === 'peer-a' ? 0 : 5,
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: peerId === 'peer-a' ? 0 : 5,
        bytesReceived: 0,
        resumedPhases: 0,
        deniedPhases: peerId === 'peer-a' ? 1 : 0,
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
        bytesReceived: 0,
        resumedPhases: 0,
        deniedPhases: 0,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
      }),
      refreshMetaSyncedFlags: async () => undefined,
    } as any;

    const runner = createCatchupRunner(fakeAgent);
    const result = await runner.run({ contextGraphId: 'private-cg', includeSharedMemory: false });
    await runner.close();

    expect(result.dataSynced).toBe(5);
    expect(result.deniedPeers).toBe(1);
    expect(result.denied).toBe(false);
  });
});
