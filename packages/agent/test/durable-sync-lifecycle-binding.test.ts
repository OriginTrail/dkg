import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function graphScopedAsset(
  root: Uint8Array,
  assertionVersion: bigint = 2n,
): VerifiedGraphScopedAsset {
  const rootHex = Array.from(root, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    contextGraphId,
    ual,
    assertionVersion,
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
        object: `"0x${assertionVersion.toString(16).padStart(64, '0')}"`,
        graph: metaGraph,
      },
    ],
  };
}

async function captureGraphScopedStore(
  chain: ChainAdapter,
  warn: ReturnType<typeof vi.fn> = vi.fn(),
  totalTimeoutMs?: number,
) {
  const agentLike: any = {
    config: {},
    chain,
    store: {},
    subscribedContextGraphs: new Map(),
    wireIdToLocalCgId: new Map(),
    bindSubscriptionOnChainId: vi.fn(),
    persistContextGraphSubscriptionState: vi.fn(),
    processDurableBatchInWorker: async () => ({}),
    insertSyncedQuadsAndInvalidateListCache: async () => {},
    syncCheckpoints: new Map(),
    oversizeTombstoneLog: { record: () => {} },
    invalidateListContextGraphsCache: vi.fn(),
    contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
    log: { info: () => {}, warn, debug: () => {} },
  };
  agentLike.createContextGraphSyncDeadline = (
    LifecycleSyncMethods.prototype as any
  ).createContextGraphSyncDeadline;
  agentLike.createGraphScopedAuthenticationDeadline = (
    LifecycleSyncMethods.prototype as any
  ).createGraphScopedAuthenticationDeadline;
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    totalTimeoutMs,
  );
  return mockedRunDurableSync.mock.calls[0]![0].storeGraphScopedAsset!;
}

describe('durable sync lifecycle chain binding', () => {
  beforeEach(() => {
    mockedRunDurableSync.mockClear();
    mockedMaterialize.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts a fresh bounded authentication phase after network fetch', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await captureGraphScopedStore({ chainId: 'none' } as ChainAdapter);

    const syncContext = mockedRunDurableSync.mock.calls[0]![0];
    expect(syncContext.durableSyncBudget.fetchDeadline(1))
      .toBe(1_800_000_120_000);
    vi.mocked(Date.now).mockReturnValue(1_800_000_300_000);
    expect(syncContext.durableSyncBudget.graphScopedAuthenticationDeadline())
      .toBe(1_800_000_420_000);
  });

  it('threads a caller-supplied authentication budget through the lifecycle', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await captureGraphScopedStore(
      { chainId: 'none' } as ChainAdapter,
      vi.fn(),
      299_000,
    );

    const syncContext = mockedRunDurableSync.mock.calls[0]![0];
    expect(syncContext.durableSyncBudget.graphScopedAuthenticationDeadline())
      .toBe(1_800_000_299_000);
  });

  it('gives exact VM recovery a full standard transfer phase', async () => {
    const runLegacyDurableSync = vi.fn(async () => ({}));
    const agentLike = { runLegacyDurableSync };
    const exactUal = 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/1';

    await LifecycleSyncMethods.prototype.syncExactKnowledgeAssetsFromPeer.call(
      agentLike as any,
      '12D3KooWExactRecoveryPeer',
      '0x1111111111111111111111111111111111111111/blackbox',
      [exactUal],
    );

    expect(runLegacyDurableSync).toHaveBeenCalledTimes(1);
    expect(runLegacyDurableSync.mock.calls[0]?.[6]).toMatchObject({
      exactAssetUals: [exactUal],
      stopOnBackoffWorthyFailure: true,
      totalTimeoutMs: 120_000,
      priority: 1_000,
    });
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
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const firstMaterialization = storeGraphScopedAsset!(asset, Date.now() + 120_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(getContextGraphNameHash).toHaveBeenCalledTimes(1);
      expect(bindSubscriptionOnChainId).not.toHaveBeenCalled();
      expect(persistContextGraphSubscriptionState).not.toHaveBeenCalled();
      expect(mockedMaterialize).not.toHaveBeenCalled();
      expect(agentLike.invalidateListContextGraphsCache).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_099);
      expect(getContextGraphNameHash).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(firstMaterialization).resolves.toBe('applied');
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
    await expect(storeGraphScopedAsset!(asset, Date.now() + 60_000)).resolves.toBe('applied');

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

    await expect(storeGraphScopedAsset!(asset(1), Date.now() + 60_000)).resolves.toBe('applied');
    await expect(storeGraphScopedAsset!(asset(2), Date.now() + 60_000)).rejects.toMatchObject({
      code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH',
    });

    expect(getContextGraphNameHash).toHaveBeenCalledTimes(2);
    expect(getContextGraphNameHash.mock.calls.map(([id]) => id)).toEqual([14n, 15n]);
    expect(mockedMaterialize).toHaveBeenCalledTimes(1);
  });

  it('cancels and retries a hung root read within the graph deadline', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const signals: AbortSignal[] = [];
      const getLatestMerkleRoot = vi.fn((
        _kaId: bigint,
        options?: { signal?: AbortSignal },
      ) => new Promise<Uint8Array>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) throw new Error('authentication root read received no abort signal');
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      const chain = {
        chainId: 'otp:2043',
        getLatestMerkleRoot,
        getMerkleRootCount: async () => 2n,
        getKAContextGraphId: async () => 14n,
      } as ChainAdapter;
      const warnings = vi.fn();
      const storeGraphScopedAsset = await captureGraphScopedStore(chain, warnings);
      const pending = storeGraphScopedAsset(
        graphScopedAsset(new Uint8Array(32)),
        Date.now() + 120_000,
      );
      const rejection = expect(pending).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });

      await vi.runAllTimersAsync();
      await rejection;
      expect(getLatestMerkleRoot).toHaveBeenCalledTimes(5);
      expect(signals).toHaveLength(5);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(warnings).toHaveBeenCalledTimes(4);
      expect(mockedMaterialize).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('cancels and retries a hung V1 publish provenance read within the graph deadline', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const root = new Uint8Array(32);
      root[31] = 1;
      const signals: AbortSignal[] = [];
      const resolvePublishByTxHash = vi.fn((
        _txHash: string,
        options?: { signal?: AbortSignal },
      ) => new Promise<never>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) throw new Error('V1 provenance read received no abort signal');
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      const chain = {
        chainId: 'otp:2043',
        getLatestMerkleRoot: async () => root,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 14n,
        getContextGraphNameHash: async () => ethers.keccak256(
          ethers.toUtf8Bytes(contextGraphId),
        ),
        resolvePublishByTxHash,
      } as ChainAdapter;
      const warnings = vi.fn();
      const storeGraphScopedAsset = await captureGraphScopedStore(chain, warnings);
      const pending = storeGraphScopedAsset(
        graphScopedAsset(root, 1n),
        Date.now() + 120_000,
      );
      const rejection = expect(pending).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });

      await vi.runAllTimersAsync();
      await rejection;
      expect(resolvePublishByTxHash).toHaveBeenCalledTimes(5);
      expect(signals).toHaveLength(5);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(warnings).toHaveBeenCalledTimes(4);
      expect(mockedMaterialize).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not retry deterministic chain evidence mismatches', async () => {
    const expectedRoot = new Uint8Array(32);
    const actualRoot = new Uint8Array(32);
    actualRoot[31] = 1;
    const getLatestMerkleRoot = vi.fn(async () => actualRoot);
    const warnings = vi.fn();
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
    } as ChainAdapter;
    const storeGraphScopedAsset = await captureGraphScopedStore(chain, warnings);

    await expect(storeGraphScopedAsset(
      graphScopedAsset(expectedRoot),
      Date.now() + 60_000,
    )).rejects.toMatchObject({ code: 'VM_CHAIN_ROOT_MISMATCH' });
    expect(getLatestMerkleRoot).toHaveBeenCalledTimes(1);
    expect(warnings).not.toHaveBeenCalled();
    expect(mockedMaterialize).not.toHaveBeenCalled();
  });

  it('cancels sibling chain reads when one authentication read fails early', async () => {
    const deterministicError = Object.assign(new Error('contract view reverted'), {
      code: 'CALL_EXCEPTION',
    });
    let siblingSignal: AbortSignal | undefined;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => { throw deterministicError; },
      getMerkleRootCount: (
        _kaId: bigint,
        options?: { signal?: AbortSignal },
      ) => new Promise<bigint>((_resolve, reject) => {
        siblingSignal = options?.signal;
        siblingSignal?.addEventListener(
          'abort',
          () => reject(siblingSignal?.reason),
          { once: true },
        );
      }),
      getKAContextGraphId: async () => 14n,
    } as ChainAdapter;
    const storeGraphScopedAsset = await captureGraphScopedStore(chain);

    await expect(storeGraphScopedAsset(
      graphScopedAsset(new Uint8Array(32)),
      Date.now() + 60_000,
    )).rejects.toBe(deterministicError);
    expect(siblingSignal?.aborted).toBe(true);
    expect(mockedMaterialize).not.toHaveBeenCalled();
  });
});
