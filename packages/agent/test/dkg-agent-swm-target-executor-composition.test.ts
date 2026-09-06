import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

import {
  SwmTargetExecutorV1,
  SwmTargetExecutorSessionFactoryV1,
  type SwmTargetExecutorPortsV1,
} from '../src/sync/requester/swm-target-executor.js';
import { createSwmRecoveryMutationRuntimeV1 } from
  '../src/sync/requester/swm-recovery-apply.js';

describe('SWM target executor session factory', () => {
  it('reuses typed stable ports while isolating each session cache', async () => {
    const store = new OxigraphStore();
    const listSubGraphs = vi.fn(async () => []);
    const ports: SwmTargetExecutorPortsV1 = {
      store,
      writeLocks: new Map(),
      listSubGraphs,
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_ctx, _peer, _cg, _swm, phase) => ({
        quads: [],
        bytesReceived: 0,
        resumedFromOffset: 0,
        nextOffset: 0,
        checkpointKey: `factory:${phase}`,
        completed: true,
      }),
      processSharedMemoryBatch: async () => ({
        verifiedData: [],
        verifiedMeta: [],
        totalFetchedDataQuads: 0,
        totalFetchedMetaQuads: 0,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
      recordDrops: () => {},
      invalidateListContextGraphsCache: () => {},
      markMetaProjectionDirty: () => {},
      recoveryMutation: createSwmRecoveryMutationRuntimeV1({
        store,
        recordDrops: () => {},
        invalidateListContextGraphsCache: () => {},
        markMetaProjectionDirty: () => {},
      }),
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
      deletePublicCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      retireFinalizedSwmTwin: async () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    };
    const factory = new SwmTargetExecutorSessionFactoryV1(ports);

    const first = factory.createSession();
    const second = factory.createSession();

    expect(first).toBeInstanceOf(SwmTargetExecutorV1);
    expect(second).toBeInstanceOf(SwmTargetExecutorV1);
    expect(second).not.toBe(first);
    await first.recoverPrivateTarget({
      remotePeerId: '12D3KooWFactoryProvider',
      contextGraphId: 'factory-cg',
    });
    await second.recoverPrivateTarget({
      remotePeerId: '12D3KooWFactoryProvider',
      contextGraphId: 'factory-cg',
    });
    expect(listSubGraphs).toHaveBeenCalledTimes(2);
    await store.close();
  });
});
