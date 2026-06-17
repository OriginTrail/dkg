import { describe, it, expect } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createOperationContext, PROTOCOL_SYNC, PROTOCOL_ACCESS } from '@origintrail-official/dkg-core';
import { peerIdFromString } from '@libp2p/peer-id';
import { runSyncOnConnect, SyncOnConnectPostSyncError } from '../src/sync/on-connect/sync-on-connect.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

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
    const syncFromPeer = recorder(async () => 0);

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
    expect(syncFromPeer.calls).toEqual([]);
  });

  it('fires onPeerSynced after a successful sync', async () => {
    const remotePeer = freshPeerIdString();
    const skipped: string[] = [];
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

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
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(skipped).toEqual([]);
    expect(synced).toEqual([{ peerId: remotePeer, fresh: true }]);
  });

  it('does not fire onPeerSynced when detailed sync summaries only time out', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        timedOutPhases: 1,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([]);
  });

  it('fires onPeerSynced when detailed sync summaries are clean but empty', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['cg-clean-empty'],
      syncFromPeer: async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: true }]);
  });

  it('does not fire onPeerSynced when clean empty accounting later times out', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['cg-clean-then-timeout'],
      syncFromPeer: async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        timedOutPhases: 1,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([]);
  });

  it('marks denial-only sync as backoff-clearing but not fresh or progress', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined; progress: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 1,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh, progress: outcome?.progress }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false, progress: false }]);
  });

  it('does not fire onPeerSynced when denial-only accounting also has a timeout', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['cg-timeout'],
      syncFromPeer: async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 1,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        timedOutPhases: 1,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([]);
  });

  it('fires onPeerSynced when a detailed sync summary advances a checkpoint', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 1,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: true }]);
  });

  it('marks progress-with-timeout as backoff-clearing but not fresh', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => ({
        insertedTriples: 3,
        completedPhases: 1,
        checkpointAdvances: 1,
        timedOutPhases: 1,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false }]);
  });

  it('treats inserted triples as progress even when optional phase counters are omitted', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined; progress: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => ({
        insertedTriples: 3,
        timedOutPhases: 1,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh, progress: outcome?.progress }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false, progress: true }]);
  });

  it('does not treat metadata-only summaries as progress or clean freshness', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => ({
        insertedTriples: 1,
        insertedDataTriples: 0,
        insertedMetaTriples: 1,
        metaOnlyResponses: 1,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([]);
  });

  it('does not let clean shared-memory accounting make durable metadata-only sync fresh', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['cg-metadata-only'],
      syncFromPeer: async () => ({
        insertedTriples: 1,
        insertedDataTriples: 0,
        insertedMetaTriples: 1,
        metaOnlyResponses: 1,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([]);
  });

  it('does not let shared-memory metadata-only accounting veto clean durable freshness', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['cg-shared-meta-only'],
      syncFromPeer: async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 1,
        insertedDataTriples: 0,
        insertedMetaTriples: 1,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: true }]);
  });

  it('does not stamp fresh when shared-memory has a post-response phase failure', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['cg-shared-phase-failure'],
      syncFromPeer: async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        failedPhases: 0,
        deniedPhases: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => ({
        insertedTriples: 0,
        insertedDataTriples: 0,
        insertedMetaTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        failedPhases: 1,
        deniedPhases: 0,
      }),
      logInfo: noopLog,
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false }]);
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
    const syncFromPeerResults: Array<() => Promise<number>> = [
      async () => 7,
      async () => { throw secondDurableError; },
    ];
    const syncFromPeer = recorder((..._args: unknown[]) => {
      const next = syncFromPeerResults.shift() ?? (async () => 0);
      return next();
    });
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
    expect(syncFromPeer.calls).toContainEqual([remotePeer]);
    expect(syncFromPeer.calls).toContainEqual([remotePeer, ['cg-b']]);
  });

  it('can skip shared-memory catch-up on connect while still running durable sync', async () => {
    const remotePeer = freshPeerIdString();
    const syncFromPeer = recorder(async () => 3);
    const syncSharedMemoryFromPeer = recorder(async () => 11);
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

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
      onPeerSynced: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(syncFromPeer.calls).toHaveLength(1);
    expect(syncSharedMemoryFromPeer.calls).toEqual([]);
    expect(synced).toEqual([{ peerId: remotePeer, fresh: true }]);
  });

  it('returns already-syncing without running duplicate work', async () => {
    const remotePeer = freshPeerIdString();
    const syncingPeers = new Set([remotePeer]);
    const syncFromPeer = recorder(async () => 0);

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
    expect(syncFromPeer.calls).toEqual([]);
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
      (agent.node.libp2p as any).getPeers = recorder(
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
      (agent.node.libp2p as any).getPeers = recorder(
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

  it('retries a freshly synced peer after a same-tick disconnect event', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerFreshButDisconnected',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const remotePeer = freshPeerIdString();
      const origGetPeers = agent.node.libp2p.getPeers.bind(agent.node.libp2p);
      (agent.node.libp2p as any).getPeers = recorder(
        () => [...origGetPeers(), peerIdFromString(remotePeer)],
      );

      const now = Date.now();
      (agent as any).lastSuccessfulSyncAt.set(remotePeer, now - 30_000);
      (agent as any).lastSyncDisconnectedAt.set(remotePeer, now - 30_000);

      const calls: string[] = [];
      (agent as any).trySyncFromPeer = async (peerId: string) => {
        calls.push(peerId);
      };

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();

      expect(calls).toEqual([remotePeer]);
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
      (agent.node.libp2p as any).getPeers = recorder(
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
      (agent.node.libp2p as any).getPeers = recorder(
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
      (agent.node.libp2p as any).getPeers = recorder(
        () => [...origGetPeers(), peerIdFromString(peerA)],
      );
      (agent as any).getPeerProtocols = recorder(async () => [PROTOCOL_SYNC]);
      const trySync = recorder(async () => undefined);
      (agent as any).trySyncFromPeer = trySync;

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

      expect(trySync.calls).toHaveLength(1);
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
      (agent.node.libp2p as any).getPeers = recorder(
        () => [...origGetPeers(), peerIdFromString(peerA)],
      );
      const getPeerProtocols = recorder(async () => ['/ipfs/id/1.0.0']);
      (agent as any).getPeerProtocols = getPeerProtocols;
      const origTrySync = (agent as any).trySyncFromPeer.bind(agent);
      const trySync = recorder((...a: unknown[]) => origTrySync(...a));
      (agent as any).trySyncFromPeer = trySync;

      const backoffMap = (agent as any).syncReconcilerBackoff as Map<
        string,
        { failures: number; nextRetryAt: number }
      >;

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();
      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();

      expect(trySync.calls).toHaveLength(2);
      expect(getPeerProtocols.calls.length).toBeGreaterThanOrEqual(2);
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
      (agent.node.libp2p as any).getPeers = recorder(
        () => [...origGetPeers(), peerIdFromString(peerA)],
      );
      (agent as any).getPeerProtocols = recorder(async () => [PROTOCOL_SYNC]);
      (agent as any).trySyncFromPeer = recorder(async () => 'already-syncing');

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
      (agent.node.libp2p as any).getPeers = recorder(
        () => [...origGetPeers(), peerIdFromString(peerA)],
      );
      (agent as any).getPeerProtocols = recorder(async () => [PROTOCOL_SYNC]);
      (agent as any).trySyncFromPeer = recorder(async () => {
        throw new SyncOnConnectPostSyncError(peerA, new Error('discovery failed'), { backoffEligible: false });
      });

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
      (agent.node.libp2p as any).getPeers = recorder(
        () => [...origGetPeers(), peerIdFromString(peerA)],
      );
      (agent as any).getPeerProtocols = recorder(async () => [PROTOCOL_SYNC]);
      (agent as any).trySyncFromPeer = recorder(async () => {
        throw new SyncOnConnectPostSyncError(peerA, new Error('shared memory failed'), { backoffEligible: true });
      });

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
      (agent.node.libp2p as any).getPeers = recorder(() => connectedPeers);

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
  it('retains sync cooldown and backoff on connection:close but clears no-sync retry state', async () => {
    const agent = await DKGAgent.create({
      name: 'ConnectionCloseRetainsBackoff',
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
      (agent.node.libp2p as any).getPeers = recorder(() => []);

      agent.node.libp2p.dispatchEvent(new CustomEvent('connection:close', {
        detail: {
          remotePeer: { toString: () => remotePeer },
          remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/1234' },
          direction: 'inbound',
          timeline: { open: Date.now() - 1000, close: Date.now() },
        },
      } as any));

      expect((agent as any).skippedNoSyncPeers.has(remotePeer)).toBe(false);
      expect((agent as any).lastSuccessfulSyncAt.has(remotePeer)).toBe(true);
      expect((agent as any).syncReconcilerBackoff.has(remotePeer)).toBe(true);
      expect((agent as any).lastSyncDisconnectedAt.has(remotePeer)).toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('suppresses connection:open catch-up when the last clean sync is fresh', async () => {
    const agent = await DKGAgent.create({
      name: 'ConnectionOpenFreshSyncSuppressed',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const remotePeer = freshPeerIdString();
      (agent as any).lastSuccessfulSyncAt.set(remotePeer, Date.now() - 30_000);
      const calls: string[] = [];
      (agent as any).trySyncFromPeer = async (peerId: string) => {
        calls.push(peerId);
      };

      agent.node.libp2p.dispatchEvent(new CustomEvent('connection:open', {
        detail: {
          remotePeer: { toString: () => remotePeer },
          remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/1234' },
          direction: 'inbound',
          timeline: { open: Date.now() },
        },
      } as any));

      expect((agent as any).catchupOnConnectAt.has(remotePeer)).toBe(false);
      await new Promise(r => setTimeout(r, 100));
      expect(calls).toEqual([]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not suppress connection:open catch-up with a pre-disconnect sync timestamp', async () => {
    const agent = await DKGAgent.create({
      name: 'ConnectionOpenAfterDisconnectNotSuppressed',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const remotePeer = freshPeerIdString();
      const sameTickBoundary = Date.now() - 30_000;
      (agent as any).lastSuccessfulSyncAt.set(remotePeer, sameTickBoundary);
      (agent as any).catchupOnConnectAt.set(remotePeer, sameTickBoundary);
      (agent as any).lastSyncDisconnectedAt.set(remotePeer, sameTickBoundary);
      const calls: string[] = [];
      (agent as any).trySyncFromPeer = async (peerId: string) => {
        calls.push(peerId);
      };

      agent.node.libp2p.dispatchEvent(new CustomEvent('connection:open', {
        detail: {
          remotePeer: { toString: () => remotePeer },
          remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/1234' },
          direction: 'inbound',
          timeline: { open: Date.now() },
        },
      } as any));

      expect((agent as any).catchupOnConnectAt.get(remotePeer)).toBeGreaterThan(sameTickBoundary);
      await new Promise(r => setTimeout(r, 3100));
      expect(calls).toEqual([remotePeer]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('prunes stale disconnected sync state on reconciler janitor ticks', async () => {
    const agent = await DKGAgent.create({
      name: 'SyncStateJanitor',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const remotePeer = freshPeerIdString();
      const now = Date.now();
      (agent as any).catchupOnConnectAt.set(remotePeer, now - 20 * 60_000);
      (agent as any).lastSuccessfulSyncAt.set(remotePeer, now - 20 * 60_000);
      (agent as any).lastSyncProgressAt.set(remotePeer, now - 20 * 60_000);
      (agent as any).syncReconcilerBackoff.set(remotePeer, {
        failures: 2,
        nextRetryAt: now - 20 * 60_000,
      });
      (agent as any).lastSyncDisconnectedAt.set(remotePeer, now - 20 * 60_000);
      (agent.node.libp2p as any).getPeers = recorder(() => []);

      (agent as any).pruneSyncReconcilerState(now);

      expect((agent as any).catchupOnConnectAt.has(remotePeer)).toBe(false);
      expect((agent as any).lastSuccessfulSyncAt.has(remotePeer)).toBe(false);
      expect((agent as any).lastSyncProgressAt.has(remotePeer)).toBe(false);
      expect((agent as any).syncReconcilerBackoff.has(remotePeer)).toBe(false);
      expect((agent as any).lastSyncDisconnectedAt.has(remotePeer)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not recreate reconciler backoff for denial-only sync without writing the long progress cooldown', async () => {
    const agent = await DKGAgent.create({
      name: 'DenialOnlyNoProgressCooldown',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const remotePeer = freshPeerIdString();
      (agent.node.libp2p as any).getPeers = recorder(() => [peerIdFromString(remotePeer)]);
      (agent as any).getPeerProtocols = recorder(async () => [PROTOCOL_SYNC]);
      (agent as any).skippedNoSyncPeers.add(remotePeer);
      (agent as any).syncReconcilerBackoff.set(remotePeer, {
        failures: 2,
        nextRetryAt: Date.now() - 60_000,
      });

      const syncFromPeerDetailed = recorder(async () => ({
        insertedTriples: 0,
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        timedOutPhases: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
        failedPhases: 0,
        deniedPhases: 1,
      }));
      (agent as any).syncFromPeerDetailed = syncFromPeerDetailed;
      (agent as any).syncSharedMemoryFromPeerDetailed = async () => ({
        insertedTriples: 0,
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        timedOutPhases: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
        failedPhases: 0,
        deniedPhases: 0,
      });
      (agent as any).refreshMetaSyncedFlags = async () => undefined;
      (agent as any).discoverContextGraphsFromStore = async () => 0;

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();
      await new Promise(r => setTimeout(r, 0));

      expect(syncFromPeerDetailed.calls).toHaveLength(1);
      expect((agent as any).skippedNoSyncPeers.has(remotePeer)).toBe(false);
      expect((agent as any).syncReconcilerBackoff.has(remotePeer)).toBe(false);
      expect((agent as any).lastSuccessfulSyncAt.has(remotePeer)).toBe(false);
      expect((agent as any).lastSyncProgressAt.has(remotePeer)).toBe(false);

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();
      await new Promise(r => setTimeout(r, 0));

      expect(syncFromPeerDetailed.calls).toHaveLength(2);
      expect((agent as any).syncReconcilerBackoff.has(remotePeer)).toBe(false);
      expect((agent as any).lastSuccessfulSyncAt.has(remotePeer)).toBe(false);
      expect((agent as any).lastSyncProgressAt.has(remotePeer)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not back off when an attempt records progress without a fresh success', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerProgressNoFreshNoBackoff',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();

      const peerA = freshPeerIdString();
      const origGetPeers = agent.node.libp2p.getPeers.bind(agent.node.libp2p);
      (agent.node.libp2p as any).getPeers = recorder(
        () => [...origGetPeers(), peerIdFromString(peerA)],
      );

      const calls: string[] = [];
      (agent as any).trySyncFromPeer = async (peerId: string) => {
        calls.push(peerId);
        const progressAt = Math.max(Date.now(), ((agent as any).lastSyncProgressAt.get(peerId) ?? 0) + 1);
        (agent as any).lastSyncProgressAt.set(peerId, progressAt);
        (agent as any).syncReconcilerBackoff.delete(peerId);
        return 'synced';
      };

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();

      expect(calls).toEqual([peerA]);
      expect((agent as any).lastSuccessfulSyncAt.has(peerA)).toBe(false);
      expect((agent as any).lastSyncProgressAt.has(peerA)).toBe(true);
      expect((agent as any).syncReconcilerBackoff.has(peerA)).toBe(false);

      await (agent as any).reconcileSyncFromConnectedPeers();
      await flushMicrotasks();

      expect(calls).toEqual([peerA]);
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
      const sendToPeer = recorder(async (..._args: unknown[]) => new Uint8Array(0));
      const sendReliable = recorder(async (..._args: unknown[]) => {
        throw new Error('sync requester must not use sendReliable');
      });
      (agent as any).messenger = { sendToPeer, sendReliable };
      (agent as any).buildSyncRequest = recorder(async (..._args: unknown[]) => new Uint8Array([1, 2, 3]));

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
      expect(sendToPeer.calls).toHaveLength(1);
      expect(sendToPeer.calls[0][1]).toBe(PROTOCOL_SYNC);
      expect(sendReliable.calls).toEqual([]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});
