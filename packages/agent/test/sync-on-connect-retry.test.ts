import { describe, it, expect, vi } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { peerIdFromString } from '@libp2p/peer-id';
import { runSyncOnConnect } from '../src/sync/on-connect/sync-on-connect.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

/**
 * Same rotating bank used by p2p-resilience.test.ts — these are
 * syntactically valid libp2p peer IDs, so `peerIdFromString` succeeds.
 * No real dial ever lands because every libp2p call we depend on is
 * either spied or short-circuited by the test harness.
 */
const SYNTHETIC_PEER_IDS = [
  '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M',
  '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw',
  '12D3KooWPyTpqBBtU1AvzSsd5rWXCQzFcGtG44qDmeYenWcpzsge',
  '12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ',
  '12D3KooWCV9mkCJkKkyNLvvPNRTsvpGMstN5E4C5jtXUK61S3xan',
];
let peerIdCounter = 0;
function freshPeerIdString(): string {
  const id = SYNTHETIC_PEER_IDS[peerIdCounter % SYNTHETIC_PEER_IDS.length];
  peerIdCounter++;
  return id;
}

const noopLog = (_ctx: OperationContext, _message: string) => {};

describe('runSyncOnConnect callbacks', () => {
  it('fires onPeerSkippedNoSync when the peer does not advertise PROTOCOL_SYNC', async () => {
    const remotePeer = freshPeerIdString();
    const skipped: Array<{ peerId: string; protocols: string[] }> = [];
    const synced: string[] = [];
    const syncFromPeer = vi.fn().mockResolvedValue(0);

    await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => ['/ipfs/id/1.0.0', '/meshsub/1.1.0'],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer,
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => 0,
      logInfo: noopLog,
      onPeerSkippedNoSync: (peerId, protocols) => {
        skipped.push({ peerId, protocols: [...protocols] });
      },
      onPeerSynced: (peerId) => {
        synced.push(peerId);
      },
    });

    expect(skipped).toEqual([{ peerId: remotePeer, protocols: ['/ipfs/id/1.0.0', '/meshsub/1.1.0'] }]);
    expect(synced).toEqual([]);
    expect(syncFromPeer).not.toHaveBeenCalled();
  });

  it('fires onPeerSynced after a successful sync', async () => {
    const remotePeer = freshPeerIdString();
    const skipped: string[] = [];
    const synced: string[] = [];

    await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => 7,
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => 0,
      logInfo: noopLog,
      onPeerSkippedNoSync: (peerId) => skipped.push(peerId),
      onPeerSynced: (peerId) => synced.push(peerId),
    });

    expect(skipped).toEqual([]);
    expect(synced).toEqual([remotePeer]);
  });
});

describe('DKGAgent sync retry — event-driven via peer:update', () => {
  it('retries trySyncFromPeer when a previously-skipped peer now advertises PROTOCOL_SYNC', async () => {
    const agent = await DKGAgent.create({
      name: 'PeerUpdateRetry',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const remotePeer = freshPeerIdString();
      // Pretend sync-on-connect ran earlier and skipped this peer because
      // identify hadn't completed (the libp2p race we're fixing).
      (agent as any).skippedNoSyncPeers.add(remotePeer);

      const calls: string[] = [];
      (agent as any).trySyncFromPeer = async (peerId: string) => {
        calls.push(peerId);
      };

      // Synthesize the libp2p peer:update event with a protocol list
      // that now includes the sync protocol — this is what would happen
      // when identify finally lands.
      agent.node.libp2p.dispatchEvent(new CustomEvent('peer:update', {
        detail: {
          peer: {
            id: { toString: () => remotePeer },
            protocols: ['/ipfs/id/1.0.0', PROTOCOL_SYNC],
          },
        },
      } as any));

      // Listener uses setTimeout(..., 0); allow the microtask + macrotask drain.
      for (let i = 0; i < 50 && calls.length === 0; i++) {
        await new Promise(r => setTimeout(r, 10));
      }

      expect(calls).toEqual([remotePeer]);
      expect((agent as any).skippedNoSyncPeers.has(remotePeer)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not retry when the updated protocol list still lacks PROTOCOL_SYNC', async () => {
    const agent = await DKGAgent.create({
      name: 'PeerUpdateNoRetry',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const remotePeer = freshPeerIdString();
      (agent as any).skippedNoSyncPeers.add(remotePeer);

      const calls: string[] = [];
      (agent as any).trySyncFromPeer = async (peerId: string) => {
        calls.push(peerId);
      };

      agent.node.libp2p.dispatchEvent(new CustomEvent('peer:update', {
        detail: {
          peer: {
            id: { toString: () => remotePeer },
            // identify completed but this peer genuinely doesn't speak sync
            protocols: ['/ipfs/id/1.0.0', '/meshsub/1.1.0'],
          },
        },
      } as any));

      await new Promise(r => setTimeout(r, 100));

      expect(calls).toEqual([]);
      // peer is still in the skipped set so the reconciler can decide later
      expect((agent as any).skippedNoSyncPeers.has(remotePeer)).toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not retry when the peer was not previously skipped', async () => {
    const agent = await DKGAgent.create({
      name: 'PeerUpdateUnskipped',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const remotePeer = freshPeerIdString();

      const calls: string[] = [];
      (agent as any).trySyncFromPeer = async (peerId: string) => {
        calls.push(peerId);
      };

      // peer:update arrives but we never skipped this peer in the first
      // place — sync-on-connect either succeeded or was never attempted.
      // Either way, peer:update should be a no-op for the retry path.
      agent.node.libp2p.dispatchEvent(new CustomEvent('peer:update', {
        detail: {
          peer: {
            id: { toString: () => remotePeer },
            protocols: ['/ipfs/id/1.0.0', PROTOCOL_SYNC],
          },
        },
      } as any));

      await new Promise(r => setTimeout(r, 100));

      expect(calls).toEqual([]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});

describe('DKGAgent sync retry — periodic reconciler', () => {
  it('retries connected peers with no successful sync on record', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerNeverSynced',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const peerA = freshPeerIdString();
      const peerB = freshPeerIdString();

      const origGetPeers = agent.node.libp2p.getPeers.bind(agent.node.libp2p);
      vi.spyOn(agent.node.libp2p, 'getPeers').mockImplementation(
        () => [...origGetPeers(), peerIdFromString(peerA), peerIdFromString(peerB)],
      );

      const calls: string[] = [];
      (agent as any).trySyncFromPeer = async (peerId: string) => {
        calls.push(peerId);
      };

      await (agent as any).reconcileSyncFromConnectedPeers();
      // trySyncFromPeer is fire-and-forget inside the reconciler.
      await new Promise(r => setTimeout(r, 50));

      expect(calls.sort()).toEqual([peerA, peerB].sort());
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('skips connected peers whose lastSuccessfulSyncAt is within the staleness threshold', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerSkipsFresh',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const freshPeer = freshPeerIdString();
      const stalePeer = freshPeerIdString();

      const origGetPeers = agent.node.libp2p.getPeers.bind(agent.node.libp2p);
      vi.spyOn(agent.node.libp2p, 'getPeers').mockImplementation(
        () => [...origGetPeers(), peerIdFromString(freshPeer), peerIdFromString(stalePeer)],
      );

      // freshPeer synced 30s ago — within the 10-minute threshold
      (agent as any).lastSuccessfulSyncAt.set(freshPeer, Date.now() - 30_000);
      // stalePeer synced 20 minutes ago — well past the threshold
      (agent as any).lastSuccessfulSyncAt.set(stalePeer, Date.now() - 20 * 60_000);

      const calls: string[] = [];
      (agent as any).trySyncFromPeer = async (peerId: string) => {
        calls.push(peerId);
      };

      await (agent as any).reconcileSyncFromConnectedPeers();
      await new Promise(r => setTimeout(r, 50));

      expect(calls).toEqual([stalePeer]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('skips peers that are currently being synced (re-entrancy guard)', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerSkipsInFlight',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const peerA = freshPeerIdString();

      const origGetPeers = agent.node.libp2p.getPeers.bind(agent.node.libp2p);
      vi.spyOn(agent.node.libp2p, 'getPeers').mockImplementation(
        () => [...origGetPeers(), peerIdFromString(peerA)],
      );

      // Simulate a sync already in flight for this peer.
      (agent as any).syncingPeers.add(peerA);

      const calls: string[] = [];
      (agent as any).trySyncFromPeer = async (peerId: string) => {
        calls.push(peerId);
      };

      await (agent as any).reconcileSyncFromConnectedPeers();
      await new Promise(r => setTimeout(r, 50));

      expect(calls).toEqual([]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});

describe('DKGAgent sync state lifecycle', () => {
  it('clears skippedNoSyncPeers and lastSuccessfulSyncAt on connection:close', async () => {
    const agent = await DKGAgent.create({
      name: 'ConnectionCloseClearsState',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const remotePeer = freshPeerIdString();
      (agent as any).skippedNoSyncPeers.add(remotePeer);
      (agent as any).lastSuccessfulSyncAt.set(remotePeer, Date.now());

      // Stub getPeers so the close handler considers the peer fully gone.
      vi.spyOn(agent.node.libp2p, 'getPeers').mockReturnValue([]);

      agent.node.libp2p.dispatchEvent(new CustomEvent('connection:close', {
        detail: {
          remotePeer: { toString: () => remotePeer },
          remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/1234' },
          direction: 'inbound',
          timeline: { open: Date.now() - 1000, close: Date.now() },
        },
      } as any));

      expect((agent as any).skippedNoSyncPeers.has(remotePeer)).toBe(false);
      expect((agent as any).lastSuccessfulSyncAt.has(remotePeer)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});
