import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  tripleContentV10,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { createRandomSamplingRepairOperation } from '@origintrail-official/dkg-random-sampling';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  LifecycleSyncMethods,
  authenticateChallengePinnedGraphScopedAssetWithinDeadline,
} from '../src/dkg-agent-lifecycle.js';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import {
  runRandomSamplingExactRepair,
  startRandomSamplingExactRepair,
} from '../src/sync/recovery/random-sampling-exact-repair.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { processDurableBatchForWire } from '../src/sync-verify-worker-impl.js';
import type { DurableBatchVerificationMode } from '../src/sync-verify-worker.js';

function processDurableBatchWithRealVerifier(
  dataQuads: Quad[],
  metaQuads: Quad[],
  _ctx: OperationContext,
  acceptUnverified: boolean,
  mode: DurableBatchVerificationMode,
) {
  const {
    verifiedDataIndexes,
    verifiedMetaIndexes,
    ...summary
  } = processDurableBatchForWire(dataQuads, metaQuads, acceptUnverified, mode);
  return Promise.resolve({
    ...summary,
    verifiedData: verifiedDataIndexes.map((index) => dataQuads[index]!),
    verifiedMeta: verifiedMetaIndexes.map((index) => metaQuads[index]!),
  });
}

describe('Random Sampling proof-time exact repair', () => {
  it('rotates through the bounded provider window until an exact asset is found', async () => {
    const peers = ['peer-0001', 'peer-0002', 'peer-0003', 'peer-0004'];
    const expectedUal = 'did:dkg:base:8453/0x0000000000000000000000000000000000001234/7';
    const historicalQuad = {
      subject: 'urn:historical',
      predicate: 'urn:value',
      object: '"proof"',
      graph: 'urn:historical-graph',
    };
    const proofMaterial = {
      contents: [tripleContentV10(
        historicalQuad.subject,
        historicalQuad.predicate,
        historicalQuad.object,
      )],
      privateRoots: [],
    };
    const syncExactKnowledgeAssetsFromPeerDetailed = vi.fn(async (peerId: string) => ({
      disposition: peerId === 'peer-0003' ? 'found' : 'clean-absent',
      result: { insertedTriples: 0 },
      ...(peerId === 'peer-0003'
        ? {
            authenticatedAssets: [{
              asset: {
                ual: expectedUal,
                dataQuads: [historicalQuad],
              },
              privateRoots: [],
            }],
          }
        : {}),
    }));
    const agentLike = {
      started: true,
      peerId: 'self',
      chain: {
        chainId: 'base:8453',
        getDKGKnowledgeAssetsAddress: vi.fn(async () =>
          '0x00000000000000000000000000000000000000aa'),
      },
      node: {
        stopSignal: undefined,
        libp2p: { getConnections: () => [] },
      },
      log: { info: vi.fn() },
      resolveLocalCgIdByOnChainId: vi.fn(() => 'food-safety'),
      resolveRandomSamplingLocalContextGraphId: vi.fn(async () => 'food-safety'),
      resolveCuratorPeerIdsForCg: vi.fn(async () => ({ peerIds: [] })),
      vmReconcileObservedCandidatePeerIds: vi.fn(() => peers),
      preferredSyncPeers: new Map(),
      selectCatchupPeerWindow: vi.fn((candidates: Array<{ toString(): string }>) =>
        candidates.slice(0, 3)),
      ensurePeerAdmittedForRecovery: vi.fn(async () => true),
      ensurePeerConnected: vi.fn(async () => undefined),
      waitForSyncProtocol: vi.fn(async () => true),
      syncExactKnowledgeAssetsFromPeerDetailed,
    };
    const kaId = (0x1234n << 96n) | 7n;
    const expectedRoot = new Uint8Array(32).fill(0x11);

    await expect(
      (LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset as any).call(
        agentLike,
        { kaId, cgId: 1n, expectedRoot, expectedLeafCount: 12n },
      ).result,
    ).resolves.toEqual(proofMaterial);

    expect(syncExactKnowledgeAssetsFromPeerDetailed).toHaveBeenCalledTimes(3);
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
      .toEqual(['peer-0001', 'peer-0002', 'peer-0003']);
    expect(agentLike.selectCatchupPeerWindow).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ maxPeers: 3, peerRotationKey: 'rs-proof:food-safety' }),
    );
    for (const call of syncExactKnowledgeAssetsFromPeerDetailed.mock.calls) {
      expect(call[1]).toBe('food-safety');
      expect(call[2]).toEqual({
        kind: 'challenge-pinned',
        commitments: [{
          assetUal: expectedUal,
          merkleRootHex: '11'.repeat(32),
          merkleLeafCount: 12n,
        }],
      });
      expect(call[3]).toEqual(expect.objectContaining({
        signal: expect.any(AbortSignal),
      }));
    }
    expect(agentLike.ensurePeerAdmittedForRecovery.mock.calls[0]?.[3])
      .toBeInstanceOf(AbortSignal);
    expect(agentLike.ensurePeerConnected.mock.calls[0]?.[1])
      .toEqual({ signal: expect.any(AbortSignal) });
    expect(agentLike.waitForSyncProtocol.mock.calls[0]?.[1])
      .toBeInstanceOf(AbortSignal);
  });

  it('discovers and dials a registry provider with an empty local cache and no connection', async () => {
    const providerPeerId = '12D3KooWRegistryProofProvider';
    const expectedUal =
      'did:dkg:base:8453/0x0000000000000000000000000000000000001234/7';
    const resolveCuratorPeerIdsForCg = vi.fn(async () => ({
      peerIds: [providerPeerId],
      curatorIsLocal: false,
      legacyTripleResolved: false,
    }));
    const ensurePeerConnected = vi.fn(async () => undefined);
    const syncExactKnowledgeAssetsFromPeerDetailed = vi.fn(async () => ({
      disposition: 'found' as const,
      result: { insertedTriples: 0 },
      authenticatedAssets: [{
        asset: { ual: expectedUal, dataQuads: [] },
        privateRoots: [],
      }],
    }));
    const agentLike = {
      started: true,
      peerId: 'self',
      chain: {
        chainId: 'base:8453',
        getDKGKnowledgeAssetsAddress: vi.fn(async () =>
          '0x00000000000000000000000000000000000000aa'),
      },
      node: {
        stopSignal: undefined,
        libp2p: { getConnections: () => [] },
      },
      log: { info: vi.fn() },
      resolveLocalCgIdByOnChainId: vi.fn(() => 'food-safety'),
      resolveRandomSamplingLocalContextGraphId: vi.fn(async () => 'food-safety'),
      resolveCuratorPeerIdsForCg,
      vmReconcileObservedCandidatePeerIds: vi.fn(() => []),
      preferredSyncPeers: new Map(),
      selectCatchupPeerWindow: vi.fn((peers: Array<{ toString(): string }>) => peers),
      ensurePeerAdmittedForRecovery: vi.fn(async () => true),
      ensurePeerConnected,
      waitForSyncProtocol: vi.fn(async () => true),
      syncExactKnowledgeAssetsFromPeerDetailed,
    };

    await expect(
      (LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset as any).call(
        agentLike,
        {
          kaId: (0x1234n << 96n) | 7n,
          cgId: 1n,
          expectedRoot: new Uint8Array(32).fill(0x11),
          expectedLeafCount: 1n,
        },
      ).result,
    ).resolves.toEqual({ contents: [], privateRoots: [] });

    expect(resolveCuratorPeerIdsForCg).toHaveBeenCalledWith(
      'food-safety',
      expect.objectContaining({
        maxPeerIds: expect.any(Number),
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      }),
    );
    expect(ensurePeerConnected).toHaveBeenCalledWith(
      providerPeerId,
      { signal: expect.any(AbortSignal) },
    );
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls[0]?.[0])
      .toBe(providerPeerId);
  });

  it('terminates challenge authentication when a chain read ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const contextGraphId = 'proof-deadline';
      const storageAddress = '0x1111111111111111111111111111111111111111';
      const assetUal = `did:dkg:otp:2043/${storageAddress}/1`;
      const assertionGraph = knowledgeAssetLayerGraphUri(
        contextGraphId,
        MemoryLayer.VerifiableMemory,
        createGraphKnowledgeAssetScope(assetUal, '1'),
      );
      const dataQuad: Quad = {
        subject: 'urn:historical',
        predicate: 'urn:value',
        object: '"proof-deadline"',
        graph: assertionGraph,
      };
      const expectedRoot = computeFlatKCRootV10([dataQuad], []);
      const metadataQuads = generateGraphKnowledgeAssetMetadata({
        ual: assetUal,
        contextGraphId,
        merkleRoot: expectedRoot,
        publisherPeerId: 'historical-provider',
        accessPolicy: 'public',
        timestamp: new Date(0),
        assertionVersion: '1',
        publicTripleCount: 1,
        privateTripleCount: 0,
        assertionGraph,
      }, { status: 'tentative' });
      let chainReadSignal: AbortSignal | undefined;
      const getKAContextGraphId = vi.fn((
        _kaId: bigint,
        options?: { signal?: AbortSignal },
      ) => {
        chainReadSignal = options?.signal;
        return new Promise<bigint>(() => undefined);
      });
      const verifyContextGraphBinding = vi.fn(async () => true);
      const pending = authenticateChallengePinnedGraphScopedAssetWithinDeadline({
        chain: {
          chainId: 'otp:2043',
          getKAContextGraphId,
        } as never,
        asset: {
          contextGraphId,
          ual: assetUal,
          assertionVersion: 1n,
          assertionGraph,
          metaGraph: `${contextGraphId}/_meta`,
          dataQuads: [dataQuad],
          metadataQuads,
        },
        commitment: {
          assetUal,
          merkleRootHex: [...expectedRoot]
            .map((value) => value.toString(16).padStart(2, '0'))
            .join(''),
          merkleLeafCount: 1n,
        },
        verifyContextGraphBinding,
        authenticationDeadline: Date.now() + 25,
      });
      const rejection = expect(pending).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });

      await vi.waitFor(() => expect(getKAContextGraphId).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(25);
      await rejection;

      expect(chainReadSignal?.aborted).toBe(true);
      expect(verifyContextGraphBinding).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues to a later provider after an ordinary peer failure', async () => {
    const stopController = new AbortController();
    const attemptedPeers: string[] = [];
    const observedSignals: AbortSignal[] = [];
    const logInfo = vi.fn();
    const proofMaterial = {
      contents: ['urn:historical urn:value "recovered"'],
      privateRoots: [],
    };

    const repaired = await runRandomSamplingExactRepair({
      chainId: 'base:8453',
      maxPeers: 2,
      stopSignal: stopController.signal,
      timeoutMs: 30_000,
      resolveStorageAddress: async (signal) => {
        observedSignals.push(signal);
        return '0x0000000000000000000000000000000000001234';
      },
      resolveLocalContextGraphId: () => 'food-safety',
      resolveCandidatePeerIds: async () => ['peer-0001', 'peer-0002'],
      selectPeerWindow: (peerIds) => peerIds,
      preparePeer: async (peerId, signal) => {
        attemptedPeers.push(peerId);
        observedSignals.push(signal);
        if (peerId === 'peer-0001') throw new Error('connection reset');
        return true;
      },
      fetchExactKnowledgeAsset: async (_peerId, _cgId, _commitment, signal) => {
        observedSignals.push(signal);
        return {
          kind: 'found',
          material: proofMaterial,
        };
      },
      logInfo,
    }, {
      kaId: 7n,
      cgId: 1n,
      expectedRoot: new Uint8Array(32).fill(0x11),
      expectedLeafCount: 1n,
    });

    expect(repaired).toEqual(proofMaterial);
    expect(attemptedPeers).toEqual(['peer-0001', 'peer-0002']);
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining(
      'eer-0001 failed: connection reset',
    ));
    expect(stopController.signal.aborted).toBe(false);
    expect(observedSignals.length).toBeGreaterThan(0);
    expect(observedSignals.every((signal) => signal === observedSignals[0])).toBe(true);
    expect(observedSignals[0]?.aborted).toBe(false);
  });

  it('authenticates historical bytes cryptographically and rejects a tampered payload', async () => {
    const localContextGraphId = 'proof-only-history';
    const storageAddress = '0x1111111111111111111111111111111111111111';
    const kaId = (BigInt(storageAddress) << 96n) | 1n;
    const assetUal = `did:dkg:otp:2043/${storageAddress}/1`;
    const assertionGraph = knowledgeAssetLayerGraphUri(
      localContextGraphId,
      MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(assetUal, '1'),
    );
    const historicalQuad: Quad = {
      subject: 'urn:historical',
      predicate: 'urn:value',
      object: '"proof-only"',
      graph: assertionGraph,
    };
    const privateRoot = new Uint8Array(32).fill(0x33);
    const expectedRoot = computeFlatKCRootV10([historicalQuad], [privateRoot]);
    const metadata = generateGraphKnowledgeAssetMetadata({
      ual: assetUal,
      contextGraphId: localContextGraphId,
      merkleRoot: expectedRoot,
      publisherPeerId: 'historical-provider',
      accessPolicy: 'public',
      timestamp: new Date(0),
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 1,
      privateMerkleRoot: privateRoot,
      assertionGraph,
    }, { status: 'tentative' });
    const makeAgent = (fetchedQuad: Quad) => {
      const insertSyncedQuadsAndInvalidateListCache = vi.fn(async () => {
        throw new Error('proof-only historical asset reached durable insertion');
      });
      const submitProof = vi.fn();
      const page = (phase: 'data' | 'meta'): SyncPageResult => {
        const quads = phase === 'data' ? [fetchedQuad] : metadata;
        return {
          quads,
          bytesReceived: 100,
          resumedFromOffset: 0,
          nextOffset: quads.length,
          checkpointKey: `proof-only:${phase}`,
          completed: true,
          timedOut: false,
        };
      };
      const agentLike: any = {
        started: true,
        config: {},
        peerId: 'self',
        chain: {
          chainId: 'otp:2043',
          getDKGKnowledgeAssetsAddress: vi.fn(async () => storageAddress),
          getKAContextGraphId: vi.fn(async () => 14n),
          submitProof,
        },
        node: {
          stopSignal: undefined,
          libp2p: { getConnections: () => [] },
        },
        log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        resolveLocalCgIdByOnChainId: vi.fn(() => localContextGraphId),
        resolveRandomSamplingLocalContextGraphId: vi.fn(async () => localContextGraphId),
        resolveCuratorPeerIdsForCg: vi.fn(async () => ({ peerIds: [] })),
        vmReconcileObservedCandidatePeerIds: vi.fn(() => ['peer-history']),
        preferredSyncPeers: new Map(),
        selectCatchupPeerWindow: vi.fn((peers: Array<{ toString(): string }>) => peers),
        ensurePeerAdmittedForRecovery: vi.fn(async () => true),
        ensurePeerConnected: vi.fn(async () => undefined),
        waitForSyncProtocol: vi.fn(async () => true),
        fetchSyncPages: vi.fn(async (
          _ctx: OperationContext,
          _peerId: string,
          _contextGraphId: string,
          _includeSharedMemory: boolean,
          phase: 'data' | 'meta',
        ) => page(phase)),
        processDurableBatchInWorker: vi.fn(processDurableBatchWithRealVerifier),
        insertSyncedQuadsAndInvalidateListCache,
        subscribedContextGraphs: new Map([[localContextGraphId, { subscribed: true }]]),
        contextGraphBindingState: new ContextGraphBindingState(),
        graphScopedStoreClosed: false,
        graphScopedStorePhysicalRuns: new Set<Promise<unknown>>(),
        syncCheckpoints: {
          delete: vi.fn(),
          set: vi.fn(),
          setManifestBoundOffset: vi.fn(),
        },
        requireLocalCgMatchesOnChainSlot: vi.fn(async () => true),
      };
      agentLike.runLegacyDurableSyncDetailed = async (
        ctx: OperationContext,
        peerId: string,
        contextGraphIds: string[],
        _onPhase: unknown,
        _onAccessDenied: unknown,
        _sinceBatchIdFor: unknown,
        options: unknown,
      ) => LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraphDetailed.call(
        agentLike,
        ctx,
        peerId,
        contextGraphIds[0]!,
        1,
        options as never,
      );
      agentLike.syncExactKnowledgeAssetsFromPeerDetailed =
        LifecycleSyncMethods.prototype.syncExactKnowledgeAssetsFromPeerDetailed;
      return { agentLike, insertSyncedQuadsAndInvalidateListCache, submitProof };
    };

    const clean = makeAgent(historicalQuad);
    const repaired = await LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset.call(
      clean.agentLike,
      { kaId, cgId: 14n, expectedRoot, expectedLeafCount: 1n },
    ).result;

    expect(repaired.contents).toEqual([
      tripleContentV10(
        historicalQuad.subject,
        historicalQuad.predicate,
        historicalQuad.object,
      ),
    ]);
    expect(repaired.privateRoots).toEqual([privateRoot]);
    expect(clean.insertSyncedQuadsAndInvalidateListCache).not.toHaveBeenCalled();
    expect(clean.agentLike.graphScopedStorePhysicalRuns.size).toBe(0);

    const tampered = makeAgent({ ...historicalQuad, object: '"tampered"' });
    await expect(LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset.call(
      tampered.agentLike,
      { kaId, cgId: 14n, expectedRoot, expectedLeafCount: 1n },
    ).result).rejects.toThrow('did not recover');
    expect(tampered.agentLike.chain.getKAContextGraphId).not.toHaveBeenCalled();
    expect(tampered.submitProof).not.toHaveBeenCalled();
    expect(tampered.insertSyncedQuadsAndInvalidateListCache).not.toHaveBeenCalled();
  });

  it('fails closed when no local on-chain CG binding exists', async () => {
    const agentLike = {
      chain: {},
      node: { stopSignal: undefined },
      log: { info: vi.fn() },
      resolveLocalCgIdByOnChainId: vi.fn(() => undefined),
      resolveRandomSamplingLocalContextGraphId: vi.fn(async () => undefined),
    };

    await expect(
      (LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset as any).call(
        agentLike,
        {
          kaId: 7n,
          cgId: 1n,
          expectedRoot: new Uint8Array(32),
          expectedLeafCount: 1n,
        },
      ).result,
    ).rejects.toThrow('cannot resolve local CG 1');
  });

  it('awaits the required cold-binding resolver before provider discovery', async () => {
    const resolverSignal: AbortSignal[] = [];
    const resolveRandomSamplingLocalContextGraphId = vi.fn(async (
      _cgId: bigint,
      signal: AbortSignal,
    ) => {
      resolverSignal.push(signal);
      return 'cold-public-proof-cg';
    });
    const resolveCuratorPeerIdsForCg = vi.fn(async () => ({ peerIds: [] }));
    const agentLike = {
      started: true,
      peerId: 'self',
      chain: {
        chainId: 'base:8453',
        getDKGKnowledgeAssetsAddress: vi.fn(async () =>
          '0x00000000000000000000000000000000000000aa'),
      },
      node: {
        stopSignal: undefined,
        libp2p: { getConnections: () => [] },
      },
      log: { info: vi.fn() },
      resolveRandomSamplingLocalContextGraphId,
      resolveCuratorPeerIdsForCg,
      vmReconcileObservedCandidatePeerIds: vi.fn(() => []),
      preferredSyncPeers: new Map(),
      selectCatchupPeerWindow: vi.fn((peers: Array<{ toString(): string }>) => peers),
    };

    await expect(
      (LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset as any).call(
        agentLike,
        {
          kaId: 7n,
          cgId: 317n,
          expectedRoot: new Uint8Array(32),
          expectedLeafCount: 1n,
        },
      ).result,
    ).rejects.toThrow('no providers for cold-public-proof-cg');

    expect(resolveRandomSamplingLocalContextGraphId).toHaveBeenCalledWith(
      317n,
      expect.any(AbortSignal),
    );
    expect(resolveCuratorPeerIdsForCg).toHaveBeenCalledWith(
      'cold-public-proof-cg',
      expect.objectContaining({ signal: resolverSignal[0] }),
    );
  });

  it('recovers a cold public CG binding from the durable ontology index', async () => {
    const localContextGraphId = '0x9Eb3a49f91670f6b8EFC138Df0003F0ae0A23Dd0/cold-public-proof-cg';
    const store = new OxigraphStore();
    await store.insert([{
      subject: `did:dkg:context-graph:${localContextGraphId}`,
      predicate: 'https://dkg.network/ontology#ContextGraphOnChainId',
      object: '"317"',
      graph: 'did:dkg:context-graph:ontology',
    }]);
    const committedNameHash = ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId));
    const agentLike = {
      store,
      config: { syncContextGraphs: [] },
      chain: {
        getContextGraphNameHash: vi.fn(async () => committedNameHash),
        isContextGraphActiveOnChain: vi.fn(async () => true),
        getContextGraphAccessPolicy: vi.fn(async () => 0),
      },
      subscribedContextGraphs: new Map(),
      resolveLocalCgIdByOnChainId: vi.fn(() => null),
      contextGraphNameCommitment: (id: string) =>
        ethers.keccak256(ethers.toUtf8Bytes(id)),
      isWireIdKeyedSubscription: () => false,
    };

    await expect(
      (ContextGraphResolveMethods.prototype.resolveRandomSamplingLocalContextGraphId as any).call(
        agentLike,
        317n,
      ),
    ).resolves.toBe(localContextGraphId);

    expect(agentLike.chain.getContextGraphNameHash).toHaveBeenCalledWith(317n, undefined);
    expect(agentLike.chain.isContextGraphActiveOnChain).toHaveBeenCalledWith(317n, undefined);
    expect(agentLike.chain.getContextGraphAccessPolicy).toHaveBeenCalledWith(317n, undefined);
    await store.close();
  });

  it('falls back to local graph discovery when the durable binding is absent', async () => {
    const localContextGraphId = 'cold-public-proof-cg';
    const store = new OxigraphStore();
    await store.insert([{
      subject: 'urn:local-marker',
      predicate: 'urn:value',
      object: '"present"',
      graph: `did:dkg:context-graph:${localContextGraphId}`,
    }]);
    const agentLike = {
      store,
      config: { syncContextGraphs: [] },
      chain: {
        getContextGraphNameHash: vi.fn(async () =>
          ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId))),
        isContextGraphActiveOnChain: vi.fn(async () => true),
        getContextGraphAccessPolicy: vi.fn(async () => 0),
      },
      subscribedContextGraphs: new Map(),
      resolveLocalCgIdByOnChainId: vi.fn(() => null),
      contextGraphNameCommitment: (id: string) =>
        ethers.keccak256(ethers.toUtf8Bytes(id)),
      isWireIdKeyedSubscription: () => false,
    };

    await expect(
      (ContextGraphResolveMethods.prototype.resolveRandomSamplingLocalContextGraphId as any).call(
        agentLike,
        380n,
      ),
    ).resolves.toBe(localContextGraphId);
    await store.close();
  });

  it('does not infer a private CG name without an active local subscription', async () => {
    const localContextGraphId = 'cold-private-proof-cg';
    const agentLike = {
      store: {},
      config: { syncContextGraphs: [localContextGraphId] },
      chain: {
        getContextGraphNameHash: vi.fn(async () =>
          ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId))),
        isContextGraphActiveOnChain: vi.fn(async () => true),
        getContextGraphAccessPolicy: vi.fn(async () => 1),
      },
      subscribedContextGraphs: new Map(),
      resolveLocalCgIdByOnChainId: vi.fn(() => null),
      contextGraphNameCommitment: (id: string) =>
        ethers.keccak256(ethers.toUtf8Bytes(id)),
      isWireIdKeyedSubscription: () => false,
    };

    await expect(
      (ContextGraphResolveMethods.prototype.resolveRandomSamplingLocalContextGraphId as any).call(
        agentLike,
        318n,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a stale local name whose commitment differs from the challenged slot', async () => {
    const agentLike = {
      store: { listGraphs: vi.fn(async () => []) },
      config: { syncContextGraphs: ['stale-local-name'] },
      chain: {
        getContextGraphNameHash: vi.fn(async () =>
          ethers.keccak256(ethers.toUtf8Bytes('different-live-name'))),
        isContextGraphActiveOnChain: vi.fn(async () => true),
        getContextGraphAccessPolicy: vi.fn(async () => 0),
      },
      subscribedContextGraphs: new Map(),
      resolveLocalCgIdByOnChainId: vi.fn(() => null),
      contextGraphNameCommitment: (id: string) =>
        ethers.keccak256(ethers.toUtf8Bytes(id)),
      isWireIdKeyedSubscription: () => false,
    };

    await expect(
      (ContextGraphResolveMethods.prototype.resolveRandomSamplingLocalContextGraphId as any).call(
        agentLike,
        319n,
      ),
    ).resolves.toBeUndefined();
    expect(agentLike.chain.isContextGraphActiveOnChain).not.toHaveBeenCalled();
    expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('rejects a stale subscription hash that does not commit the local cleartext name', async () => {
    const localContextGraphId = 'stale-cleartext-name';
    const liveCommitment = ethers.keccak256(ethers.toUtf8Bytes('different-live-name'));
    const agentLike = {
      store: { listGraphs: vi.fn(async () => []) },
      config: { syncContextGraphs: [] },
      chain: {
        getContextGraphNameHash: vi.fn(async () => liveCommitment),
        isContextGraphActiveOnChain: vi.fn(async () => true),
        getContextGraphAccessPolicy: vi.fn(async () => 0),
      },
      subscribedContextGraphs: new Map([[
        localContextGraphId,
        { subscribed: true, onChainHash: liveCommitment },
      ]]),
      resolveLocalCgIdByOnChainId: vi.fn(() => null),
      contextGraphNameCommitment: (id: string) =>
        ethers.keccak256(ethers.toUtf8Bytes(id)),
      isWireIdKeyedSubscription: () => false,
    };

    await expect(
      (ContextGraphResolveMethods.prototype.resolveRandomSamplingLocalContextGraphId as any).call(
        agentLike,
        381n,
      ),
    ).resolves.toBeUndefined();
    expect(agentLike.chain.isContextGraphActiveOnChain).not.toHaveBeenCalled();
    expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('accepts a host-only hash key only when subscription metadata proves wire-keying', async () => {
    const committedNameHash = ethers.keccak256(ethers.toUtf8Bytes('host-only-graph'));
    const agentLike = {
      store: { listGraphs: vi.fn(async () => []) },
      config: { syncContextGraphs: [] },
      chain: {
        getContextGraphNameHash: vi.fn(async () => committedNameHash),
        isContextGraphActiveOnChain: vi.fn(async () => true),
        getContextGraphAccessPolicy: vi.fn(async () => 0),
      },
      subscribedContextGraphs: new Map([[
        committedNameHash,
        { subscribed: true, onChainHash: committedNameHash },
      ]]),
      resolveLocalCgIdByOnChainId: vi.fn(() => null),
      contextGraphNameCommitment: (id: string) =>
        ethers.keccak256(ethers.toUtf8Bytes(id)),
      isWireIdKeyedSubscription: (id: string) => id === committedNameHash,
    };

    await expect(
      (ContextGraphResolveMethods.prototype.resolveRandomSamplingLocalContextGraphId as any).call(
        agentLike,
        384n,
      ),
    ).resolves.toBe(committedNameHash);
  });

  it('fails closed when a matching challenged slot is inactive', async () => {
    const localContextGraphId = 'inactive-public-proof-cg';
    const agentLike = {
      store: {
        query: vi.fn(async () => ({ type: 'bindings' as const, bindings: [] })),
      },
      config: { syncContextGraphs: [localContextGraphId] },
      chain: {
        getContextGraphNameHash: vi.fn(async () =>
          ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId))),
        isContextGraphActiveOnChain: vi.fn(async () => false),
        getContextGraphAccessPolicy: vi.fn(async () => 0),
      },
      subscribedContextGraphs: new Map(),
      resolveLocalCgIdByOnChainId: vi.fn(() => null),
      contextGraphNameCommitment: (id: string) =>
        ethers.keccak256(ethers.toUtf8Bytes(id)),
      isWireIdKeyedSubscription: () => false,
    };

    await expect(
      (ContextGraphResolveMethods.prototype.resolveRandomSamplingLocalContextGraphId as any).call(
        agentLike,
        382n,
      ),
    ).resolves.toBeUndefined();
    expect(agentLike.chain.isContextGraphActiveOnChain).toHaveBeenCalledWith(382n, undefined);
  });

  it('physically settles when the final chain attestation reads ignore cancellation', async () => {
    const localContextGraphId = 'stalled-policy-proof-cg';
    const observedSignals: AbortSignal[] = [];
    const stalledRead = (_id: bigint, options?: { signal?: AbortSignal }) => {
      if (options?.signal) observedSignals.push(options.signal);
      return new Promise<never>(() => undefined);
    };
    const resolverHost = {
      store: {
        query: vi.fn(async () => ({ type: 'bindings' as const, bindings: [] })),
      },
      config: { syncContextGraphs: [localContextGraphId] },
      chain: {
        getContextGraphNameHash: vi.fn(async () =>
          ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId))),
        isContextGraphActiveOnChain: vi.fn(stalledRead),
        getContextGraphAccessPolicy: vi.fn(stalledRead),
      },
      subscribedContextGraphs: new Map(),
      resolveLocalCgIdByOnChainId: vi.fn(() => null),
      contextGraphNameCommitment: (id: string) =>
        ethers.keccak256(ethers.toUtf8Bytes(id)),
      isWireIdKeyedSubscription: () => false,
    };
    const repair = startRandomSamplingExactRepair({
      chainId: 'base:8453',
      maxPeers: 1,
      timeoutMs: 10,
      resolveStorageAddress: async () =>
        '0x00000000000000000000000000000000000000aa',
      resolveLocalContextGraphId: (cgId, signal) =>
        (ContextGraphResolveMethods.prototype.resolveRandomSamplingLocalContextGraphId as any)
          .call(resolverHost, cgId, signal),
      resolveCandidatePeerIds: async () => ['unreachable'],
      selectPeerWindow: (peers) => peers,
      preparePeer: async () => true,
      fetchExactKnowledgeAsset: async () => ({
        kind: 'miss',
        disposition: 'clean-absent',
      }),
      logInfo: vi.fn(),
    }, {
      kaId: 7n,
      cgId: 383n,
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 1n,
    });

    await expect(repair.result).rejects.toThrow();
    await expect(Promise.race([
      repair.settled.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 100)),
    ])).resolves.toBe('settled');
    expect(observedSignals).toHaveLength(2);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it('aborts a stalled peer-setup stage under the shared deadline', async () => {
    let setupSignal: AbortSignal | undefined;
    const repair = runRandomSamplingExactRepair({
      chainId: 'base:8453',
      maxPeers: 3,
      timeoutMs: 10,
      resolveStorageAddress: async () =>
        '0x00000000000000000000000000000000000000aa',
      resolveLocalContextGraphId: () => 'food-safety',
      resolveCandidatePeerIds: async () => ['peer-stalled'],
      selectPeerWindow: (peers) => peers,
      preparePeer: async (_peerId, signal) => {
        setupSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return true;
      },
      fetchExactKnowledgeAsset: async () => ({
        kind: 'found',
        material: { contents: [], privateRoots: [] },
      }),
      logInfo: vi.fn(),
    }, {
      kaId: 7n,
      cgId: 1n,
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 1n,
    });

    await expect(repair).rejects.toThrow();
    expect(setupSignal?.aborted).toBe(true);
  });

  it('bounds a hanging storage-address lookup with the repair deadline', async () => {
    let addressSignal: AbortSignal | undefined;
    const repair = runRandomSamplingExactRepair({
      chainId: 'base:8453',
      maxPeers: 1,
      timeoutMs: 10,
      resolveStorageAddress: (signal) => {
        addressSignal = signal;
        return new Promise<string>(() => undefined);
      },
      resolveLocalContextGraphId: () => 'food-safety',
      resolveCandidatePeerIds: async () => ['unreachable'],
      selectPeerWindow: (peers) => peers,
      preparePeer: async () => true,
      fetchExactKnowledgeAsset: async () => ({
        kind: 'miss',
        disposition: 'clean-absent',
      }),
      logInfo: vi.fn(),
    }, {
      kaId: 7n,
      cgId: 1n,
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 1n,
    });

    await expect(repair).rejects.toThrow();
    expect(addressSignal?.aborted).toBe(true);
  });

  it('reports owner cancellation promptly while exposing one physical settlement boundary', async () => {
    let addressStarted!: () => void;
    const started = new Promise<void>((resolve) => { addressStarted = resolve; });
    let settleAddress!: (address: string) => void;
    const resolveCandidatePeerIds = vi.fn(async () => ['unreachable']);
    const repair = startRandomSamplingExactRepair({
      chainId: 'base:8453',
      maxPeers: 1,
      timeoutMs: 60_000,
      resolveStorageAddress: () => {
        addressStarted();
        return new Promise<string>((resolve) => { settleAddress = resolve; });
      },
      resolveLocalContextGraphId: () => 'food-safety',
      resolveCandidatePeerIds,
      selectPeerWindow: (peers) => peers,
      preparePeer: async () => true,
      fetchExactKnowledgeAsset: async () => ({
        kind: 'miss',
        disposition: 'clean-absent',
      }),
      logInfo: vi.fn(),
    }, {
      kaId: 7n,
      cgId: 1n,
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 1n,
    });

    await started;
    const reason = new Error('prover stopped');
    repair.cancel(reason);
    await expect(repair.result).rejects.toThrow('prover stopped');
    await expect(Promise.race([
      repair.settled.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ])).resolves.toBe('pending');
    settleAddress('0x00000000000000000000000000000000000000aa');
    await expect(repair.settled).resolves.toBeUndefined();
    expect(resolveCandidatePeerIds).not.toHaveBeenCalled();
  });

  it('keeps a timed-out prover installed and starts only a later replacement after it settles', async () => {
    const originalTimeout = DKGAgentBase.RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS;
    Object.defineProperty(DKGAgentBase, 'RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS', {
      configurable: true,
      value: 10,
    });
    let settleOld!: () => void;
    const oldSettled = new Promise<void>((resolve) => { settleOld = resolve; });
    const oldStop = vi.fn(() => oldSettled);
    const oldHandle = {
      enabled: true,
      start: vi.fn(),
      stop: oldStop,
      getStatus: vi.fn(() => ({ disabledReason: null })),
    };
    const freshAfterTimeout = {
      enabled: true,
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({ disabledReason: null })),
    };
    const installedReplacement = {
      enabled: true,
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({ disabledReason: null })),
    };
    const createRandomSamplingHandle = vi.fn()
      .mockResolvedValueOnce(freshAfterTimeout)
      .mockResolvedValueOnce(installedReplacement);
    const agentLike = {
      started: true,
      config: { nodeRole: 'core' },
      chain: {
        chainId: 'base:8453',
        isRandomSamplingReady: () => true,
        getIdentityId: vi.fn(async () => 42n),
        isShardingTableMember: vi.fn(async () => true),
      },
      store: {},
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      randomSamplingHandle: oldHandle,
      randomSamplingIdentityId: 0n,
      randomSamplingDisabledReason: 'not_started',
      randomSamplingLogger: vi.fn(() => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      })),
      createRandomSamplingHandle,
      repairRandomSamplingKnowledgeAsset: vi.fn(),
      clearRandomSamplingBindRetry: vi.fn(),
    };

    try {
      await expect(
        (LifecycleSyncMethods.prototype.tryStartRandomSamplingProver as any).call(
          agentLike,
          { operation: 'start', id: 'rs-replacement-timeout' },
          false,
        ),
      ).resolves.toBe('retryable');
      expect(agentLike.randomSamplingHandle).toBe(oldHandle);
      expect(oldStop).toHaveBeenCalledOnce();
      expect(freshAfterTimeout.stop).toHaveBeenCalledOnce();
      expect(freshAfterTimeout.start).not.toHaveBeenCalled();

      settleOld();
      await expect(
        (LifecycleSyncMethods.prototype.tryStartRandomSamplingProver as any).call(
          agentLike,
          { operation: 'start', id: 'rs-replacement-retry' },
          false,
        ),
      ).resolves.toBe('started');
      expect(oldStop).toHaveBeenCalledTimes(2);
      expect(agentLike.randomSamplingHandle).toBe(installedReplacement);
      expect(installedReplacement.start).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(DKGAgentBase, 'RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS', {
        configurable: true,
        value: originalTimeout,
      });
    }
  });

  it('wires the lifecycle repair callback through the production prover binding', async () => {
    const expectedRoot = new Uint8Array(32).fill(0x33);
    const repairRandomSamplingKnowledgeAsset = vi.fn(() =>
      createRandomSamplingRepairOperation(async () => {
        throw new Error('expected test repair miss');
      }));
    const agentLike = {
      started: true,
      config: {
        nodeRole: 'core',
        randomSamplingUseWorkerThread: false,
        randomSamplingTickIntervalMs: 60_000,
      },
      chain: {
        chainId: 'base:8453',
        isRandomSamplingReady: () => true,
        getIdentityId: vi.fn(async () => 42n),
        isShardingTableMember: vi.fn(async () => true),
        getActiveProofPeriodStatus: vi.fn(async () => ({
          activeProofPeriodStartBlock: 1000n,
          proofingPeriodDurationInBlocks: 50n,
          isValid: true,
        })),
        getNodeChallenge: vi.fn(async () => null),
        createChallenge: vi.fn(async () => ({
          challenge: {
            knowledgeAssetId: 7n,
            chunkId: 0n,
            knowledgeAssetStorageContract: '0x0',
            epoch: 1n,
            activeProofPeriodStartBlock: 1000n,
            proofingPeriodDurationInBlocks: 50n,
            solved: false,
            isCurated: false,
            challengeLeafCount: 1n,
            challengeRoot: expectedRoot,
          },
          contextGraphId: 1n,
          hash: '0xchallenge',
          blockNumber: 1000,
          success: true,
        })),
        getKAContextGraphId: vi.fn(async () => 1n),
        submitProof: vi.fn(),
      },
      store: new OxigraphStore(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      randomSamplingHandle: null,
      randomSamplingIdentityId: 0n,
      randomSamplingDisabledReason: 'not_started',
      randomSamplingLogger: LifecycleSyncMethods.prototype.randomSamplingLogger,
      createRandomSamplingHandle: LifecycleSyncMethods.prototype.createRandomSamplingHandle,
      repairRandomSamplingKnowledgeAsset,
      clearRandomSamplingBindRetry: vi.fn(),
    };

    await expect(
      (LifecycleSyncMethods.prototype.tryStartRandomSamplingProver as any).call(
        agentLike,
        { operation: 'start', id: 'rs-bind-test' },
        true,
      ),
    ).resolves.toBe('started');
    await vi.waitFor(() => expect(repairRandomSamplingKnowledgeAsset).toHaveBeenCalledOnce());
    expect(repairRandomSamplingKnowledgeAsset).toHaveBeenCalledWith({
      kaId: 7n,
      cgId: 1n,
      expectedRoot,
      expectedLeafCount: 1n,
    });
    await agentLike.randomSamplingHandle!.stop();
  });
});
