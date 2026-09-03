import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  SwmTargetExecutorV1,
  type SwmTargetExecutorPortsV1,
} from '../src/sync/requester/swm-target-executor.js';

describe('SwmTargetExecutorV1 private recovery wiring', () => {
  const stores: OxigraphStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it('pins recovery authorization and the lease signal on private page fetches', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const controller = new AbortController();
    const fetchSyncPages = vi.fn<SwmTargetExecutorPortsV1['fetchSyncPages']>(
      async (_ctx, _peerId, _contextGraphId, _includeSharedMemory, phase) => ({
        quads: [],
        bytesReceived: 0,
        resumedFromOffset: 0,
        nextOffset: 0,
        checkpointKey: `private:${phase}`,
        completed: true,
      }),
    );
    const executor = new SwmTargetExecutorV1({
      store,
      writeLocks: new Map(),
      listSubGraphs: async () => [],
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages,
      processSharedMemoryBatch: async () => ({
        verifiedData: [],
        verifiedMeta: [],
        totalFetchedDataQuads: 0,
        totalFetchedMetaQuads: 0,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
      recordDrops: () => undefined,
      invalidateListContextGraphsCache: () => undefined,
      markMetaProjectionDirty: () => undefined,
      setCheckpoint: () => undefined,
      deleteCheckpoint: () => undefined,
      deletePublicCheckpoint: () => undefined,
      ensureOwnedMap: () => new Map(),
      retireFinalizedSwmTwin: async () => undefined,
      logInfo: () => undefined,
      logWarn: () => undefined,
      logDebug: () => undefined,
    });

    await expect(executor.recoverPrivateTarget({
      remotePeerId: '12D3KooWCompletePrivateProvider',
      contextGraphId: 'private-rfc64-context-graph',
      recoveryGuard: {
        signal: controller.signal,
        assertCurrent: () => undefined,
      },
    })).resolves.toMatchObject({ completed: true });

    expect(fetchSyncPages).toHaveBeenCalled();
    for (const call of fetchSyncPages.mock.calls) {
      expect(call[7]).toMatchObject({
        recovery: true,
        signal: controller.signal,
      });
    }
  });
});
