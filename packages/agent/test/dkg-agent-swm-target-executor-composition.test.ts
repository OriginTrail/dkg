import { resolvePrivateSwmRecoveryBudgetMs } from '../src/sync/requester/private-swm-recovery-budget.js';
import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

import {
  SwmTargetExecutorV1,
  SwmTargetExecutorSessionFactoryV1,
  type SwmTargetExecutorPortsV1,
} from '../src/sync/requester/swm-target-executor.js';
import { createSwmRecoveryMutationRuntimeV1 } from
  '../src/sync/requester/swm-recovery-apply.js';

describe('SWM target executor session factory', () => {
  it.each([
    { configuredBudgetMs: 0, expectedRounds: 1 },
    { configuredBudgetMs: 100, expectedRounds: 2 },
  ])('wires the $configuredBudgetMs ms environment budget through a real agent', async ({ configuredBudgetMs, expectedRounds }) => {
    vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', String(configuredBudgetMs));
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: `PrivateRecoveryBudget${configuredBudgetMs}`,
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: new MockChainAdapter(),
      store,
    });
    const fetchSyncPages = vi.spyOn(agent as any, 'fetchSyncPages').mockImplementation(async () => {
      elapsed += 60;
      return {
        quads: [], bytesReceived: 0, resumedFromOffset: 0, nextOffset: 0,
        checkpointKey: 'agent-composition:meta', completed: false, timedOut: true,
      };
    });
    try {
      const executor = (agent as any).createSwmTargetExecutorSessionV1() as SwmTargetExecutorV1;
      await executor.recoverPrivateTarget({
        remotePeerId: '12D3KooWAgentCompositionProvider',
        contextGraphId: 'agent-composition-cg',
      });
      expect(fetchSyncPages).toHaveBeenCalledTimes(expectedRounds);
    } finally {
      await store.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it('reuses typed stable ports while isolating each session cache', async () => {
    const store = new OxigraphStore();
    const listSubGraphs = vi.fn(async () => []);
    const ports: SwmTargetExecutorPortsV1 = {
      privateRecoveryBudgetMs: resolvePrivateSwmRecoveryBudgetMs(),
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
        timedOut: false,
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
