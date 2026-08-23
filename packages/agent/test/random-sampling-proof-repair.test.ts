import { describe, expect, it, vi } from 'vitest';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

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

    await (LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset as any).call(
      agentLike,
      { kaId, cgId: 1n },
    );

    expect(syncExactKnowledgeAssetsFromPeerDetailed).toHaveBeenCalledTimes(3);
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
      .toEqual(['peer-0001', 'peer-0002', 'peer-0003']);
    expect(agentLike.selectCatchupPeerWindow).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ maxPeers: 3, peerRotationKey: 'rs-proof:food-safety' }),
    );
  });

  it('fails closed when no local on-chain CG binding exists', async () => {
    const agentLike = {
      chain: {},
      log: { info: vi.fn() },
      resolveLocalCgIdByOnChainId: vi.fn(() => undefined),
    };

    await expect(
      (LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset as any).call(
        agentLike,
        { kaId: 7n, cgId: 1n },
      ),
    ).rejects.toThrow('cannot resolve local CG 1');
  });
});
