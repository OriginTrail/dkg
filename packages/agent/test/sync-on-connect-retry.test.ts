import { describe, it, expect, vi } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createOperationContext, PROTOCOL_SYNC, PROTOCOL_ACCESS } from '@origintrail-official/dkg-core';
import { peerIdFromString } from '@libp2p/peer-id';
import { runSyncOnConnect, SyncOnConnectPostSyncError } from '../src/sync/on-connect/sync-on-connect.js';
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('runSyncOnConnect callbacks', () => {
  it('fires onPeerSkippedNoSync when the peer does not advertise PROTOCOL_SYNC', async () => {
    const remotePeer = freshPeerIdString();
    const skipped: Array<{ peerId: string; protocols: string[] }> = [];
    const synced: string[] = [];
    const syncFromPeer = vi.fn().mockResolvedValue(0);

    const outcome = await runSyncOnConnect({
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

    expect(outcome).toBe('skipped-no-sync');
    expect(skipped).toEqual([{ peerId: remotePeer, protocols: ['/ipfs/id/1.0.0', '/meshsub/1.1.0'] }]);
    expect(synced).toEqual([]);
    expect(syncFromPeer).not.toHaveBeenCalled();
  });

  it('fires onPeerSynced after a successful sync', async () => {
    const remotePeer = freshPeerIdString();
    const skipped: string[] = [];
    const synced: string[] = [];

    const outcome = await runSyncOnConnect({
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

    expect(outcome).toBe('synced');
    expect(skipped).toEqual([]);
    expect(synced).toEqual([remotePeer]);
  });

  it('tags failures that happen after durable sync completes', async () => {
    const remotePeer = freshPeerIdString();
    const syncingPeers = new Set<string>();
    const laterError = new Error('discovery failed');
    const synced: string[] = [];
    let caught: unknown;

    try {
      await runSyncOnConnect({
        remotePeer,
        syncingPeers,
        getPeerProtocols: async () => [PROTOCOL_SYNC],
        knownCorePeerIds: new Set(),
        getSyncContextGraphs: () => [],
        syncFromPeer: async () => 7,
        refreshMetaSyncedFlags: async () => {},
        discoverContextGraphsFromStore: async () => {
          throw laterError;
        },
        syncSharedMemoryFromPeer: async () => 0,
        logInfo: noopLog,
        onPeerSynced: (peerId) => synced.push(peerId),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SyncOnConnectPostSyncError);
    expect((caught as SyncOnConnectPostSyncError).originalError).toBe(laterError);
    expect((caught as SyncOnConnectPostSyncError).backoffEligible).toBe(false);
    expect(synced).toEqual([]);
    expect(syncingPeers.has(remotePeer)).toBe(false);
  });

  it('leaves newly discovered durable sync failures eligible for peer backoff', async () => {
    const remotePeer = freshPeerIdString();
    let contextGraphs = ['cg-a'];
    const secondDurableError = new Error('newly discovered durable sync failed');
    const syncFromPeer = vi.fn()
      .mockResolvedValueOnce(7)
      .mockRejectedValueOnce(secondDurableError);
    let caught: unknown;

    try {
      await runSyncOnConnect({
        remotePeer,
        syncingPeers: new Set(),
        getPeerProtocols: async () => [PROTOCOL_SYNC],
        knownCorePeerIds: new Set(),
        getSyncContextGraphs: () => contextGraphs,
        syncFromPeer,
        refreshMetaSyncedFlags: async () => {},
        discoverContextGraphsFromStore: async () => {
          contextGraphs = ['cg-a', 'cg-b'];
          return 1;
        },
        syncSharedMemoryFromPeer: async () => 0,
        logInfo: noopLog,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(secondDurableError);
    expect(caught).not.toBeInstanceOf(SyncOnConnectPostSyncError);
    expect(syncFromPeer).toHaveBeenCalledWith(remotePeer);
    expect(syncFromPeer).toHaveBeenCalledWith(remotePeer, ['cg-b']);
  });

  it('can skip shared-memory catch-up on connect while still running durable sync', async () => {
    const remotePeer = freshPeerIdString();
    const syncFromPeer = vi.fn().mockResolvedValue(3);
    const syncSharedMemoryFromPeer = vi.fn().mockResolvedValue(11);
    const synced: string[] = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['devnet-test'],
      syncFromPeer,
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer,
      syncSharedMemoryOnConnect: false,
      logInfo: noopLog,
      onPeerSynced: (peerId) => synced.push(peerId),
    });

    expect(outcome).toBe('synced');
    expect(syncFromPeer).toHaveBeenCalledOnce();
    expect(syncSharedMemoryFromPeer).not.toHaveBeenCalled();
    expect(synced).toEqual([remotePeer]);
  });

  it('returns already-syncing without running duplicate work', async () => {
    const remotePeer = freshPeerIdString();
    const syncingPeers = new Set([remotePeer]);
    const syncFromPeer = vi.fn().mockResolvedValue(0);

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers,
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer,
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => 0,
      logInfo: noopLog,
    });

    expect(outcome).toBe('already-syncing');
    expect(syncFromPeer).not.toHaveBeenCalled();
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
      await flushMicrotasks();

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
      await flushMicrotasks();

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
      await flushMicrotasks();

      expect(calls).toEqual([]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('backs off a never-successful peer exponentially and skips it until the retry window elapses', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerBackoff',
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

      const calls: string[] = [];
      // Resolve WITHOUT stamping lastSuccessfulSyncAt: the reconciler
      // then treats every attempt as a failure (mirrors a dead /
      // stream-resetting peer that never completes a sync).
      (agent as any).trySyncFromPeer = async (peerId: string) => {
        calls.push(peerId);
      };

      const backoffMap = (agent as any).syncReconcilerBackoff as Map<
        string,
        { failures: number; nextRetryAt: number }
      >;

      // Tick 1: never synced → fires once and records failure #1.
      const t1 = Date.now();
      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();
      expect(calls).toEqual([peerA]);
      const b1 = backoffMap.get(peerA)!;
      expect(b1.failures).toBe(1);
      const delay1 = b1.nextRetryAt - t1;
      expect(delay1).toBeGreaterThan(0);

      // Tick 2 immediately: still inside the backoff window → skipped.
      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();
      expect(calls).toEqual([peerA]);
      expect(backoffMap.get(peerA)!.failures).toBe(1);

      // Force the window to have elapsed, then tick again → fires and
      // records failure #2 with a strictly larger window (exponential).
      backoffMap.set(peerA, { failures: 1, nextRetryAt: Date.now() - 1 });
      const t2 = Date.now();
      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();
      expect(calls).toEqual([peerA, peerA]);
      const b2 = backoffMap.get(peerA)!;
      expect(b2.failures).toBe(2);
      const delay2 = b2.nextRetryAt - t2;
      // failure-2 window (~10min ±25%) strictly exceeds the failure-1
      // window (~5min ±25%) even at worst-case jitter (7.5min > 6.25min).
      expect(delay2).toBeGreaterThan(delay1);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('bypasses pending backoff when the live protocol fingerprint changes', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerBackoffFingerprint',
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
      vi.spyOn(agent as any, 'getPeerProtocols').mockResolvedValue([PROTOCOL_SYNC]);
      const trySync = vi.spyOn(agent as any, 'trySyncFromPeer').mockResolvedValue(undefined);

      const backoffMap = (agent as any).syncReconcilerBackoff as Map<
        string,
        { failures: number; nextRetryAt: number; protocolsKey?: string | null; connectionKey?: string | null }
      >;
      backoffMap.set(peerA, {
        failures: 1,
        nextRetryAt: Date.now() + 100_000,
        protocolsKey: '/dkg/old/sync',
        connectionKey: null,
      });

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();

      expect(trySync).toHaveBeenCalledTimes(1);
      expect(backoffMap.get(peerA)?.failures).toBe(1);
      expect(backoffMap.get(peerA)?.protocolsKey).toBe(PROTOCOL_SYNC);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not back off a peer that still does not advertise PROTOCOL_SYNC', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerNoSyncNoBackoff',
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
      const getPeerProtocols = vi
        .spyOn(agent as any, 'getPeerProtocols')
        .mockResolvedValue(['/ipfs/id/1.0.0']);
      const trySync = vi.spyOn(agent as any, 'trySyncFromPeer');

      const backoffMap = (agent as any).syncReconcilerBackoff as Map<
        string,
        { failures: number; nextRetryAt: number }
      >;

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();
      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();

      expect(trySync).toHaveBeenCalledTimes(2);
      expect(getPeerProtocols.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect((agent as any).skippedNoSyncPeers.has(peerA)).toBe(true);
      expect(backoffMap.has(peerA)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not back off when the attempt reports already-syncing', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerAlreadySyncingNoBackoff',
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
      vi.spyOn(agent as any, 'getPeerProtocols').mockResolvedValue([PROTOCOL_SYNC]);
      vi.spyOn(agent as any, 'trySyncFromPeer').mockResolvedValue('already-syncing');

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();

      expect((agent as any).syncReconcilerBackoff.has(peerA)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not back off local post-sync bookkeeping failures', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerLocalPostSyncFailureNoBackoff',
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
      vi.spyOn(agent as any, 'getPeerProtocols').mockResolvedValue([PROTOCOL_SYNC]);
      vi.spyOn(agent as any, 'trySyncFromPeer').mockRejectedValue(
        new SyncOnConnectPostSyncError(peerA, new Error('discovery failed'), { backoffEligible: false }),
      );

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();

      expect((agent as any).syncReconcilerBackoff.has(peerA)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('backs off post-sync peer catch-up failures', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerPeerPostSyncFailureBackoff',
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
      vi.spyOn(agent as any, 'getPeerProtocols').mockResolvedValue([PROTOCOL_SYNC]);
      vi.spyOn(agent as any, 'trySyncFromPeer').mockRejectedValue(
        new SyncOnConnectPostSyncError(peerA, new Error('shared memory failed'), { backoffEligible: true }),
      );

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();

      const backoff = (agent as any).syncReconcilerBackoff.get(peerA);
      expect(backoff?.failures).toBe(1);
      expect(backoff?.nextRetryAt).toBeGreaterThan(Date.now());
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not recreate backoff after the peer disconnects while an attempt is in flight', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerBackoffDisconnectRace',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const peerA = freshPeerIdString();
      let connectedPeers = [peerIdFromString(peerA)];
      vi.spyOn(agent.node.libp2p, 'getPeers').mockImplementation(() => connectedPeers);

      let resolveAttempt!: () => void;
      const calls: string[] = [];
      (agent as any).trySyncFromPeer = (peerId: string) => {
        calls.push(peerId);
        return new Promise<void>((resolve) => {
          resolveAttempt = resolve;
        });
      };

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();
      expect(calls).toEqual([peerA]);

      // Simulate connection:close winning the race before the
      // fire-and-forget sync attempt resolves without progress.
      connectedPeers = [];
      (agent as any).syncReconcilerBackoff.delete(peerA);
      resolveAttempt();
      await flushMicrotasks();

      expect((agent as any).syncReconcilerBackoff.has(peerA)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});

describe('DKGAgent sync state lifecycle', () => {
  it('clears skippedNoSyncPeers, lastSuccessfulSyncAt and sync backoff on connection:close', async () => {
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
      (agent as any).syncReconcilerBackoff.set(remotePeer, { failures: 3, nextRetryAt: Date.now() + 100_000 });

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
      expect((agent as any).syncReconcilerBackoff.has(remotePeer)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});

describe('DKGAgent sync transport — off the messenger substrate (node-ui.db bloat fix)', () => {
  it('registers PROTOCOL_SYNC on the raw ProtocolRouter, NOT the Messenger substrate', async () => {
    const agent = await DKGAgent.create({
      name: 'SyncOffSubstrate',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const messengerHandlers = (agent as any).messenger.handlers as Map<string, unknown>;
      const routerHandlers = (agent as any).router.handlers as Map<string, unknown>;

      // Regression guard: routing sync through `messenger.register` /
      // `sendReliable` is exactly what cached large, never-reused sync
      // page responses into `message_idempotency` (the ~2.9 GB
      // node-ui.db bloat). Sync MUST live on the raw router so no
      // idempotency rows are ever written for it.
      expect(messengerHandlers.has(PROTOCOL_SYNC)).toBe(false);
      expect(routerHandlers.has(PROTOCOL_SYNC)).toBe(true);

      // Sanity: a genuine substrate protocol (private-access) IS still
      // registered through the Messenger, so the assertion above is
      // meaningful and not vacuously true.
      expect(messengerHandlers.has(PROTOCOL_ACCESS)).toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('fetches sync pages via sendToPeer and never sendReliable', async () => {
    const agent = await DKGAgent.create({
      name: 'SyncRequesterOffSubstrate',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      const sendToPeer = vi.fn(async () => new Uint8Array(0));
      const sendReliable = vi.fn(async () => {
        throw new Error('sync requester must not use sendReliable');
      });
      (agent as any).messenger = { sendToPeer, sendReliable };
      (agent as any).buildSyncRequest = vi.fn(async () => new Uint8Array([1, 2, 3]));

      const result = await (agent as any).fetchSyncPages(
        createOperationContext('sync'),
        freshPeerIdString(),
        'sync-requester-transport',
        false,
        'data',
        'urn:dkg:test:data',
        Date.now() + 5000,
      );

      expect(result.quads).toEqual([]);
      expect(sendToPeer).toHaveBeenCalledTimes(1);
      expect(sendToPeer.mock.calls[0][1]).toBe(PROTOCOL_SYNC);
      expect(sendReliable).not.toHaveBeenCalled();
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});
