import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { runRandomSamplingExactRepair } from '../src/sync/recovery/random-sampling-exact-repair.js';

describe('Random Sampling proof-time exact repair', () => {
  it('rotates through the bounded provider window until an exact asset is found', async () => {
    const peers = ['peer-0001', 'peer-0002', 'peer-0003', 'peer-0004'];
    const syncExactKnowledgeAssetsFromPeerDetailed = vi.fn(async (peerId: string) => ({
      disposition: peerId === 'peer-0003' ? 'found' : 'clean-absent',
      result: { insertedTriples: peerId === 'peer-0003' ? 12 : 0 },
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
    const expectedUal = 'did:dkg:base:8453/0x0000000000000000000000000000000000001234/7';

    await (LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset as any).call(
      agentLike,
      { kaId, cgId: 1n, expectedRoot, expectedLeafCount: 12n },
    );

    expect(syncExactKnowledgeAssetsFromPeerDetailed).toHaveBeenCalledTimes(3);
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
      .toEqual(['peer-0001', 'peer-0002', 'peer-0003']);
    expect(agentLike.selectCatchupPeerWindow).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ maxPeers: 3, peerRotationKey: 'rs-proof:food-safety' }),
    );
    for (const call of syncExactKnowledgeAssetsFromPeerDetailed.mock.calls) {
      expect(call[1]).toBe('food-safety');
      expect(call[2]).toEqual([expectedUal]);
      expect(call[3]).toEqual(expect.objectContaining({
        signal: expect.any(AbortSignal),
        expectedCommitments: [{
          assetUal: expectedUal,
          merkleRootHex: `0x${'11'.repeat(32)}`,
          merkleLeafCount: 12n,
        }],
      }));
    }
    expect(agentLike.ensurePeerAdmittedForRecovery.mock.calls[0]?.[3])
      .toBeInstanceOf(AbortSignal);
    expect(agentLike.ensurePeerConnected.mock.calls[0]?.[1])
      .toEqual({ signal: expect.any(AbortSignal) });
    expect(agentLike.waitForSyncProtocol.mock.calls[0]?.[1])
      .toBeInstanceOf(AbortSignal);
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
