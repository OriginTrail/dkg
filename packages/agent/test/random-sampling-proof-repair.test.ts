import { describe, expect, it, vi } from 'vitest';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  tripleContentV10,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import { runRandomSamplingExactRepair } from '../src/sync/recovery/random-sampling-exact-repair.js';
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
      node: { stopSignal: undefined },
      log: { info: vi.fn() },
      resolveLocalCgIdByOnChainId: vi.fn(() => 'food-safety'),
      vmReconcileObservedCandidatePeerIds: vi.fn(() => peers),
      selectCatchupPeerWindow: vi.fn((candidates: Array<{ toString(): string }>) =>
        candidates.slice(0, 3)),
      ensurePeerAdmittedForRecovery: vi.fn(async () => true),
      ensurePeerConnected: vi.fn(async () => undefined),
      waitForSyncProtocol: vi.fn(async () => true),
      syncExactKnowledgeAssetsFromPeerDetailed,
    };
    const kaId = (0x1234n << 96n) | 7n;
    const expectedRoot = new Uint8Array(32).fill(0x11);

    await expect((LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset as any).call(
      agentLike,
      { kaId, cgId: 1n, expectedRoot, expectedLeafCount: 12n },
    )).resolves.toEqual(proofMaterial);

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
      observedCandidatePeerIds: () => ['peer-0001', 'peer-0002'],
      selectPeerWindow: (peerIds) => peerIds,
      ensurePeerAdmitted: async (_peerId, signal) => {
        observedSignals.push(signal);
        return true;
      },
      ensurePeerConnected: async (peerId, signal) => {
        attemptedPeers.push(peerId);
        observedSignals.push(signal);
        if (peerId === 'peer-0001') throw new Error('connection reset');
      },
      waitForSyncProtocol: async (_peerId, signal) => {
        observedSignals.push(signal);
        return true;
      },
      fetchExactKnowledgeAsset: async (_peerId, _cgId, _ual, _commitment, signal) => {
        observedSignals.push(signal);
        return {
          disposition: 'found',
          insertedTriples: 0,
          proofMaterial,
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
        node: { stopSignal: undefined },
        log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        resolveLocalCgIdByOnChainId: vi.fn(() => localContextGraphId),
        vmReconcileObservedCandidatePeerIds: vi.fn(() => ['peer-history']),
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
    );

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
    )).rejects.toThrow('did not recover');
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
      ),
    ).rejects.toThrow('cannot resolve local CG 1');
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
      observedCandidatePeerIds: () => ['peer-stalled'],
      selectPeerWindow: (peers) => peers,
      ensurePeerAdmitted: async () => true,
      ensurePeerConnected: async (_peerId, signal) => {
        setupSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      waitForSyncProtocol: async () => true,
      fetchExactKnowledgeAsset: async () => ({
        disposition: 'found',
        insertedTriples: 1,
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
      observedCandidatePeerIds: () => ['unreachable'],
      selectPeerWindow: (peers) => peers,
      ensurePeerAdmitted: async () => true,
      ensurePeerConnected: async () => undefined,
      waitForSyncProtocol: async () => true,
      fetchExactKnowledgeAsset: async () => ({
        disposition: 'clean-absent',
        insertedTriples: 0,
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

  it('aborts a hanging storage-address lookup promptly when the node stops', async () => {
    const stop = new AbortController();
    let addressStarted!: () => void;
    const started = new Promise<void>((resolve) => { addressStarted = resolve; });
    const repair = runRandomSamplingExactRepair({
      chainId: 'base:8453',
      maxPeers: 1,
      stopSignal: stop.signal,
      timeoutMs: 60_000,
      resolveStorageAddress: () => {
        addressStarted();
        return new Promise<string>(() => undefined);
      },
      resolveLocalContextGraphId: () => 'food-safety',
      observedCandidatePeerIds: () => ['unreachable'],
      selectPeerWindow: (peers) => peers,
      ensurePeerAdmitted: async () => true,
      ensurePeerConnected: async () => undefined,
      waitForSyncProtocol: async () => true,
      fetchExactKnowledgeAsset: async () => ({
        disposition: 'clean-absent',
        insertedTriples: 0,
      }),
      logInfo: vi.fn(),
    }, {
      kaId: 7n,
      cgId: 1n,
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 1n,
    });

    await started;
    const reason = new Error('node stopped');
    stop.abort(reason);
    await expect(repair).rejects.toThrow('node stopped');
  });

  it('wires the lifecycle repair callback through the production prover binding', async () => {
    const expectedRoot = new Uint8Array(32).fill(0x33);
    const repairRandomSamplingKnowledgeAsset = vi.fn(async () => {
      throw new Error('expected test repair miss');
    });
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
