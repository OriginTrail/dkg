import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { OperationContext } from '@origintrail-official/dkg-core';

vi.mock('../src/sync/requester/durable-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync/requester/durable-sync.js')>();
  return { ...actual, runDurableSync: vi.fn(async () => ({})) };
});

vi.mock('../src/sync/requester/graph-scoped-materialization.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../src/sync/requester/graph-scoped-materialization.js')
  >();
  return {
    ...actual,
    materializeVerifiedGraphScopedAsset: vi.fn(async () => 'applied' as const),
  };
});

import { DKGAgent } from '../src/dkg-agent.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { runDurableSync } from '../src/sync/requester/durable-sync.js';
import {
  materializeVerifiedGraphScopedAsset,
  type VerifiedGraphScopedAsset,
} from '../src/sync/requester/graph-scoped-materialization.js';

const DKG = 'http://dkg.io/ontology/';
const contextGraphId = 'agent-blackbox-vm';
const ual = 'did:dkg:otp:2043/0x1111111111111111111111111111111111111111/1';
const assertionGraph = `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/asset/1`;
const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
const ctx = { kind: 'sync', id: 'lifecycle-binding-test', startedAt: 0 } as OperationContext;

const mockedRunDurableSync = vi.mocked(runDurableSync);
const mockedMaterialize = vi.mocked(materializeVerifiedGraphScopedAsset);

describe('durable sync lifecycle chain binding', () => {
  beforeEach(() => {
    mockedRunDurableSync.mockClear();
    mockedMaterialize.mockClear();
  });

  it('retries a transient binding read, caches only the successful proof, and persists the CG id', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const rootHex = Array.from(root, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const getContextGraphNameHash = vi.fn()
      .mockRejectedValueOnce(Object.assign(
        new Error('all configured RPC endpoints failed'),
        { code: 'RPC_ENDPOINTS_EXHAUSTED' },
      ))
      .mockResolvedValue(ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)));
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash,
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;
    const subscription: { onChainId?: string; subscribed: boolean } = { subscribed: true };
    const bindSubscriptionOnChainId = vi.fn(
      (_localId: string, sub: typeof subscription, onChainId: string) => {
        sub.onChainId = onChainId;
      },
    );
    const persistContextGraphSubscriptionState = vi.fn();
    const agentLike: any = {
      config: {},
      chain,
      store: {},
      subscribedContextGraphs: new Map([[contextGraphId, subscription]]),
      wireIdToLocalCgId: new Map(),
      bindSubscriptionOnChainId,
      persistContextGraphSubscriptionState,
      processDurableBatchInWorker: async () => ({}),
      insertSyncedQuadsAndInvalidateListCache: async () => {},
      syncCheckpoints: new Map(),
      oversizeTombstoneLog: { record: () => {} },
      invalidateListContextGraphsCache: vi.fn(),
      contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    agentLike.localCgMatchesOnChainSlot = (DKGAgent.prototype as any).localCgMatchesOnChainSlot;
    agentLike.requireLocalCgMatchesOnChainSlot = (
      DKGAgent.prototype as any
    ).requireLocalCgMatchesOnChainSlot;
    agentLike.isWireIdKeyedSubscription = (DKGAgent.prototype as any).isWireIdKeyedSubscription;
    agentLike.raceChainPolicyRead = (DKGAgent.prototype as any).raceChainPolicyRead;

    await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
      agentLike,
      ctx,
      'peer-remote',
      contextGraphId,
      1,
    );
    expect(mockedRunDurableSync).toHaveBeenCalledTimes(1);
    const storeGraphScopedAsset = mockedRunDurableSync.mock.calls[0]![0].storeGraphScopedAsset;
    expect(storeGraphScopedAsset).toBeTypeOf('function');

    const asset: VerifiedGraphScopedAsset = {
      contextGraphId,
      ual,
      assertionVersion: 2n,
      assertionGraph,
      metaGraph,
      dataQuads: [],
      metadataQuads: [
        {
          subject: ual,
          predicate: `${DKG}merkleRoot`,
          object: `"${rootHex}"`,
          graph: metaGraph,
        },
        {
          subject: ual,
          predicate: `${DKG}transactionHash`,
          object: `"0x${'02'.padStart(64, '0')}"`,
          graph: metaGraph,
        },
      ],
    };
    vi.useFakeTimers();
    try {
      const firstMaterialization = storeGraphScopedAsset!(asset);
      await vi.advanceTimersByTimeAsync(0);
      expect(getContextGraphNameHash).toHaveBeenCalledTimes(1);
      expect(bindSubscriptionOnChainId).not.toHaveBeenCalled();
      expect(persistContextGraphSubscriptionState).not.toHaveBeenCalled();
      expect(mockedMaterialize).not.toHaveBeenCalled();
      expect(agentLike.invalidateListContextGraphsCache).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      await expect(firstMaterialization).resolves.toBe('applied');
    } finally {
      vi.useRealTimers();
    }
    await expect(storeGraphScopedAsset!(asset)).resolves.toBe('applied');

    expect(getContextGraphNameHash).toHaveBeenCalledTimes(2);

    expect(bindSubscriptionOnChainId).toHaveBeenCalledWith(
      contextGraphId,
      subscription,
      '14',
    );
    expect(subscription.onChainId).toBe('14');
    expect(persistContextGraphSubscriptionState).toHaveBeenCalledWith(contextGraphId);
    expect(bindSubscriptionOnChainId.mock.invocationCallOrder[0]).toBeLessThan(
      mockedMaterialize.mock.invocationCallOrder[0]!,
    );
    expect(persistContextGraphSubscriptionState.mock.invocationCallOrder[0]).toBeLessThan(
      mockedMaterialize.mock.invocationCallOrder[0]!,
    );
    const materializedAsset = mockedMaterialize.mock.calls[0]![0].asset as unknown as Record<
      string,
      unknown
    >;
    expect('verifiedOnChainContextGraphId' in materializedAsset).toBe(false);
  });

  it('does not reuse a binding proof across different on-chain CG slots', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const rootHex = Array.from(root, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const expectedNameHash = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId));
    const getContextGraphNameHash = vi.fn(async (onChainId: bigint) => (
      onChainId === 14n
        ? expectedNameHash
        : ethers.keccak256(ethers.toUtf8Bytes('different-context-graph'))
    ));
    const kaNumberMask = (1n << 96n) - 1n;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async (kaId: bigint) => (
        (kaId & kaNumberMask) === 1n ? 14n : 15n
      ),
      getContextGraphNameHash,
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;
    const subscription: { onChainId?: string; subscribed: boolean } = { subscribed: true };
    const agentLike: any = {
      config: {},
      chain,
      store: {},
      subscribedContextGraphs: new Map([[contextGraphId, subscription]]),
      wireIdToLocalCgId: new Map(),
      bindSubscriptionOnChainId: vi.fn(
        (_localId: string, sub: typeof subscription, onChainId: string) => {
          sub.onChainId = onChainId;
        },
      ),
      persistContextGraphSubscriptionState: vi.fn(),
      processDurableBatchInWorker: async () => ({}),
      insertSyncedQuadsAndInvalidateListCache: async () => {},
      syncCheckpoints: new Map(),
      oversizeTombstoneLog: { record: () => {} },
      invalidateListContextGraphsCache: vi.fn(),
      contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    agentLike.localCgMatchesOnChainSlot = (DKGAgent.prototype as any).localCgMatchesOnChainSlot;
    agentLike.requireLocalCgMatchesOnChainSlot = (
      DKGAgent.prototype as any
    ).requireLocalCgMatchesOnChainSlot;
    agentLike.isWireIdKeyedSubscription = (DKGAgent.prototype as any).isWireIdKeyedSubscription;
    agentLike.raceChainPolicyRead = (DKGAgent.prototype as any).raceChainPolicyRead;

    await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
      agentLike,
      ctx,
      'peer-remote',
      contextGraphId,
      1,
    );
    const storeGraphScopedAsset = mockedRunDurableSync.mock.calls[0]![0].storeGraphScopedAsset;
    const asset = (kaNumber: number): VerifiedGraphScopedAsset => {
      const assetUal = `did:dkg:otp:2043/0x1111111111111111111111111111111111111111/${kaNumber}`;
      return {
        contextGraphId,
        ual: assetUal,
        assertionVersion: 2n,
        assertionGraph: `${assertionGraph}-${kaNumber}`,
        metaGraph,
        dataQuads: [],
        metadataQuads: [
          {
            subject: assetUal,
            predicate: `${DKG}merkleRoot`,
            object: `"${rootHex}"`,
            graph: metaGraph,
          },
          {
            subject: assetUal,
            predicate: `${DKG}transactionHash`,
            object: `"0x${'02'.padStart(64, '0')}"`,
            graph: metaGraph,
          },
        ],
      };
    };

    await expect(storeGraphScopedAsset!(asset(1))).resolves.toBe('applied');
    await expect(storeGraphScopedAsset!(asset(2))).rejects.toMatchObject({
      code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH',
    });

    expect(getContextGraphNameHash).toHaveBeenCalledTimes(2);
    expect(getContextGraphNameHash.mock.calls.map(([id]) => id)).toEqual([14n, 15n]);
    expect(mockedMaterialize).toHaveBeenCalledTimes(1);
  });
});
