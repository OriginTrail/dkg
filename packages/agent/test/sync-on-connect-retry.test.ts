import { describe, it, expect, vi } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createOperationContext, PROTOCOL_SYNC, PROTOCOL_ACCESS, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  runSyncOnConnect,
  SyncOnConnectPostSyncError,
  type SyncOnConnectPeerOutcome,
} from '../src/sync/on-connect/sync-on-connect.js';
import { ordinaryLane } from './_helpers/run-sync-on-connect.js';
import { resolveSyncGlobalBackpressure, withGlobalSyncBackpressure } from '../src/sync/backpressure.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function emptySyncPage(phase: string): SyncPageResult {
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: 0,
    checkpointKey: `checkpoint:${phase}`,
    completed: true,
    timedOut: false,
  };
}

function stubDurableSyncExternalIo(agent: DKGAgent): void {
  (agent as any).processDurableBatchInWorker = async () => ({
    verifiedData: [],
    verifiedMeta: [],
    totalFetchedDataQuads: 0,
    totalFetchedMetaQuads: 0,
    rejectedKcs: 0,
    emptyResponses: 1,
    metaOnlyResponses: 0,
    verifiedPrivateOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
  });
}

function allowAllNetworkAdmission(agent: DKGAgent): void {
  const coordinator = (agent as any).networkAdmissionCoordinator;
  coordinator.isAcceptedPeer = () => true;
  coordinator.isRejectedPeer = () => false;
  coordinator.ensureAdmitted = async () => true;
}

describe('runSyncOnConnect callbacks', () => {
  it('runs selected-provider shared memory before unrelated durable and ordinary SWM history', async () => {
    const remotePeer = freshPeerIdString();
    const order: string[] = [];
    const ordinarySync = vi.fn(async () => {
      order.push('shared:ordinary:ordinary');
      return 0;
    });

    const outcome = await runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['selected', 'ordinary'],
      getDurableSyncContextGraphs: () => ['ordinary'],
      selectedSharedMemoryLane: {
        admitWork: async () => ({
          contextGraphIds: ['selected'],
          syncFromPeer: async () => {
            order.push('shared:selected:selected');
            return {
              kind: 'selected-shared-memory',
              requestedScope: {
                kind: 'selected-public',
                targets: [{ contextGraphId: 'selected', lane: 'selected-public' }],
              },
              shared: {
                insertedTriples: 0,
                completedPhases: 1,
                checkpointAdvances: 0,
              },
              scopeComplete: true,
              targetDiagnostics: {
                selectedPublic: { completed: 1, total: 1 },
                ordinaryPrivate: { completed: 0, total: 0 },
              },
            };
          },
        }),
      },
      ordinarySharedMemoryLane: {
        resolveWork: async () => ({
          contextGraphIds: ['ordinary'],
          syncFromPeer: ordinarySync,
        }),
      },
      syncFromPeer: async (_peerId, contextGraphIds) => {
        order.push(`durable:${contextGraphIds?.join(',') ?? 'all'}`);
        return 0;
      },
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(ordinarySync).toHaveBeenCalledWith();
    expect(order).toEqual([
      'shared:selected:selected',
      'durable:ordinary',
      'shared:ordinary:ordinary',
    ]);
  });

  it('rejects overlapping selected and ordinary work before ordinary execution', async () => {
    const remotePeer = freshPeerIdString();
    const ordinarySync = vi.fn(async () => 0);

    await expect(runSyncOnConnect({
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      getDurableSyncContextGraphs: () => [],
      selectedSharedMemoryLane: {
        admitWork: () => ({
          contextGraphIds: ['cg-a'],
          syncFromPeer: async () => ({
            kind: 'selected-shared-memory',
            requestedScope: {
              kind: 'selected-public',
              targets: [{ contextGraphId: 'cg-a', lane: 'selected-public' }],
            },
            shared: {
              insertedTriples: 0,
              completedPhases: 1,
              checkpointAdvances: 0,
            },
            scopeComplete: true,
            targetDiagnostics: {
              selectedPublic: { completed: 1, total: 1 },
              ordinaryPrivate: { completed: 0, total: 0 },
            },
          }),
        }),
      },
      ordinarySharedMemoryLane: {
        resolveWork: () => ({
          contextGraphIds: ['cg-a'],
          syncFromPeer: ordinarySync,
        }),
      },
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
    })).rejects.toThrow('Ordinary and selected shared-memory work scopes overlap');

    expect(ordinarySync).not.toHaveBeenCalled();
  });

  it('returns deferred-backpressure without marking a zero-progress peer successful', async () => {
    const remotePeer = freshPeerIdString();
    const synced: SyncOnConnectPeerOutcome[] = [];
    let sharedRuns = 0;

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => ['first', 'second'], async () => {
        sharedRuns += 1;
        return 0;
      }),
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['first', 'second'],
      syncFromPeer: async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        deferredBackpressure: 1,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
      onSyncAccounting: (_peerId, accounting) => {
        if (accounting) synced.push(accounting);
      },
    });

    expect(outcome).toBe('deferred-backpressure');
    expect(synced).toEqual([]);
    expect(sharedRuns).toBe(0);
  });

  it('records partial progress but not freshness when the remaining batch is deferred', async () => {
    const remotePeer = freshPeerIdString();
    const synced: SyncOnConnectPeerOutcome[] = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => ['first', 'second'], async () => 0),
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['first', 'second'],
      syncFromPeer: async () => ({
        insertedTriples: 1,
        insertedDataTriples: 1,
        completedPhases: 1,
        checkpointAdvances: 1,
        deferredBackpressure: 1,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
      onSyncAccounting: (_peerId, accounting) => {
        if (accounting) synced.push(accounting);
      },
    });

    expect(outcome).toBe('deferred-backpressure');
    expect(synced).toEqual([{
      reconcilerDisposition: 'defer',
      fresh: false,
      progress: true,
    }]);
  });

  it('accepts omitted knownCorePeerIdsV2 for backwards-compatible call sites', async () => {
    const remotePeer = freshPeerIdString();
    const knownCorePeerIds = new Set<string>();

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => 0),
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_SYNC],
      knownCorePeerIds,
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => 1,
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(knownCorePeerIds.has(remotePeer)).toBe(true);
  });

  it('tracks and evicts V2 ACK capability from populated protocol lists', async () => {
    const remotePeer = freshPeerIdString();
    const knownCorePeerIds = new Set<string>();
    const knownCorePeerIdsV2 = new Set<string>([remotePeer]);

    const emptyIdentifyOutcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => 0),
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [],
      knownCorePeerIds,
      knownCorePeerIdsV2,
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
    });

    expect(emptyIdentifyOutcome).toBe('skipped-no-sync');
    expect(knownCorePeerIdsV2.has(remotePeer)).toBe(true);

    const v1OnlyOutcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => 0),
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_STORAGE_ACK, PROTOCOL_SYNC],
      knownCorePeerIds,
      knownCorePeerIdsV2,
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => 1,
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
    });

    expect(v1OnlyOutcome).toBe('synced');
    expect(knownCorePeerIds.has(remotePeer)).toBe(true);
    expect(knownCorePeerIdsV2.has(remotePeer)).toBe(false);
  });

  it('fires onPeerSkippedNoSync when the peer does not advertise PROTOCOL_SYNC', async () => {
    const remotePeer = freshPeerIdString();
    const skipped: Array<{ peerId: string; protocols: string[] }> = [];
    const synced: string[] = [];
    const syncFromPeer = recorder(async () => 0);

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => 0),
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => ['/ipfs/id/1.0.0', '/meshsub/1.1.0'],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer,
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
      onPeerSkippedNoSync: (peerId, protocols) => {
        skipped.push({ peerId, protocols: [...protocols] });
      },
      onSyncAccounting: (peerId) => {
        synced.push(peerId);
      },
    });

    expect(outcome).toBe('skipped-no-sync');
    expect(skipped).toEqual([{ peerId: remotePeer, protocols: ['/ipfs/id/1.0.0', '/meshsub/1.1.0'] }]);
    expect(synced).toEqual([]);
    expect(syncFromPeer.calls).toEqual([]);
  });

  it('fires onSyncAccounting after a successful sync', async () => {
    const remotePeer = freshPeerIdString();
    const skipped: string[] = [];
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => 0),
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => 7,
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
      onPeerSkippedNoSync: (peerId) => skipped.push(peerId),
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(skipped).toEqual([]);
    expect(synced).toEqual([{ peerId: remotePeer, fresh: true }]);
  });

  it('returns retry accounting when detailed sync summaries only time out', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false }]);
  });

  it('does not classify integrity-rejected durable summaries as clean progress', async () => {
    for (const integrityFailure of [
      { rejectedKcs: 1, dataRejectedMissingMeta: 0 },
      { rejectedKcs: 0, dataRejectedMissingMeta: 1 },
    ]) {
      const remotePeer = freshPeerIdString();
      const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

      const outcome = await runSyncOnConnect({
        ordinarySharedMemoryLane: ordinaryLane(() => ['integrity-rejected-cg'], async () => ({
          insertedTriples: 0,
          timedOutPhases: 0,
          failedPeers: 0,
          deniedPhases: 0,
        })),
        remotePeer,
        syncingPeers: new Set(),
        getPeerProtocols: async () => [PROTOCOL_SYNC],
        knownCorePeerIds: new Set(),
        getSyncContextGraphs: () => ['integrity-rejected-cg'],
        syncFromPeer: async () => ({
          insertedTriples: 3,
          insertedDataTriples: 3,
          completedPhases: 1,
          checkpointAdvances: 0,
          timedOutPhases: 0,
          failedPeers: 0,
          failedPhases: 0,
          deniedPhases: 0,
          ...integrityFailure,
        }),
        refreshMetaSyncedFlags: async () => {},
        discoverContextGraphsFromStore: async () => 0,
        logInfo: noopLog,
        onSyncAccounting: (peerId, peerOutcome) => synced.push({
          peerId,
          fresh: peerOutcome?.fresh,
        }),
      });

      expect(outcome).toBe('synced');
      expect(synced).toEqual([{ peerId: remotePeer, fresh: false }]);
    }
  });

  it('fires onSyncAccounting when detailed sync summaries are clean but empty', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => ['cg-clean-empty'], async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: true }]);
  });

  it('returns retry accounting when clean empty accounting later times out', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => ['cg-clean-then-timeout'], async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        timedOutPhases: 1,
        failedPeers: 0,
        deniedPhases: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false }]);
  });

  it('marks denial-only sync as backoff-clearing but not fresh or progress', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined; progress: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh, progress: outcome?.progress }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false, progress: false }]);
  });

  it('returns retry accounting when denial-only accounting also has a timeout', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => ['cg-timeout'], async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        timedOutPhases: 1,
        failedPeers: 0,
        deniedPhases: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false }]);
  });

  it('fires onSyncAccounting when a detailed sync summary advances a checkpoint', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: true }]);
  });

  it('marks progress-with-timeout as backoff-clearing but not fresh', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => ({
        insertedTriples: 0,
        completedPhases: 0,
        checkpointAdvances: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false }]);
  });

  it('treats inserted triples as progress even when optional phase counters are omitted', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined; progress: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh, progress: outcome?.progress }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false, progress: true }]);
  });

  it('does not treat arbitrary metadata-only summaries as progress or clean freshness', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{
      peerId: string;
      fresh: boolean | undefined;
      progress: boolean | undefined;
    }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      })),
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
        verifiedPrivateOnlyResponses: 0,
        completedPhases: 1,
        checkpointAdvances: 1,
        timedOutPhases: 0,
        failedPeers: 0,
        failedPhases: 0,
        deniedPhases: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({
        peerId,
        fresh: outcome?.fresh,
        progress: outcome?.progress,
      }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([]);
  });

  it('treats a clean verified private-only durable completion as fresh progress', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{
      peerId: string;
      fresh: boolean | undefined;
      progress: boolean | undefined;
    }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      })),
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => ({
        insertedTriples: 1,
        insertedDataTriples: 0,
        insertedMetaTriples: 1,
        metaOnlyResponses: 0,
        verifiedPrivateOnlyResponses: 1,
        completedPhases: 1,
        checkpointAdvances: 1,
        timedOutPhases: 0,
        failedPeers: 0,
        failedPhases: 0,
        deniedPhases: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
      onSyncAccounting: (peerId, syncOutcome) => synced.push({
        peerId,
        fresh: syncOutcome?.fresh,
        progress: syncOutcome?.progress,
      }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: true, progress: true }]);
  });

  it('keeps explicit incomplete durable progress non-fresh and retryable', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{
      peerId: string;
      fresh: boolean | undefined;
      progress: boolean | undefined;
    }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      })),
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => ({
        complete: false,
        insertedTriples: 40_000,
        insertedDataTriples: 40_000,
        insertedMetaTriples: 0,
        metaOnlyResponses: 0,
        verifiedPrivateOnlyResponses: 0,
        completedPhases: 1,
        checkpointAdvances: 1,
        timedOutPhases: 0,
        failedPeers: 0,
        failedPhases: 0,
        deniedPhases: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
      onSyncAccounting: (peerId, syncOutcome) => synced.push({
        peerId,
        fresh: syncOutcome?.fresh,
        progress: syncOutcome?.progress,
      }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false, progress: true }]);
  });

  it('keeps an incomplete first durable leg non-fresh after a clean discovered-CG leg', async () => {
    const remotePeer = freshPeerIdString();
    let contextGraphs = ['cg-a'];
    const synced: Array<{
      peerId: string;
      fresh: boolean | undefined;
      progress: boolean | undefined;
    }> = [];
    const syncFromPeer = recorder(async (_peerId: string, contextGraphIds?: string[]) => ({
      complete: contextGraphIds !== undefined,
      insertedTriples: contextGraphIds === undefined ? 40_000 : 1,
      insertedDataTriples: contextGraphIds === undefined ? 40_000 : 1,
      insertedMetaTriples: 0,
      metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 0,
      completedPhases: 1,
      checkpointAdvances: 1,
      timedOutPhases: 0,
      failedPeers: 0,
      failedPhases: 0,
      deniedPhases: 0,
      dataRejectedMissingMeta: 0,
      rejectedKcs: 0,
    }));

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => contextGraphs, async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, syncOutcome) => synced.push({
        peerId,
        fresh: syncOutcome?.fresh,
        progress: syncOutcome?.progress,
      }),
    });

    expect(outcome).toBe('synced');
    expect(syncFromPeer.calls).toEqual([
      [remotePeer],
      [remotePeer, ['cg-b']],
    ]);
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false, progress: true }]);
  });

  it.each([
    ['timed out', { timedOutPhases: 1 }],
    ['failed integrity verification', { rejectedKcs: 1 }],
  ])('does not trust a verified private-only signal when the round %s', async (_label, overrides) => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{
      peerId: string;
      fresh: boolean | undefined;
      progress: boolean | undefined;
    }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      })),
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer: async () => ({
        insertedTriples: 1,
        insertedDataTriples: 0,
        insertedMetaTriples: 1,
        metaOnlyResponses: 0,
        verifiedPrivateOnlyResponses: 1,
        completedPhases: 1,
        checkpointAdvances: 1,
        timedOutPhases: 0,
        failedPeers: 0,
        failedPhases: 0,
        deniedPhases: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        ...overrides,
      }),
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
      onSyncAccounting: (peerId, syncOutcome) => synced.push({
        peerId,
        fresh: syncOutcome?.fresh,
        progress: syncOutcome?.progress,
      }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: false, progress: false }]);
  });

  it('does not let clean shared-memory accounting make durable metadata-only sync fresh', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => ['cg-metadata-only'], async () => ({
        insertedTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([]);
  });

  it('does not let shared-memory metadata-only accounting veto clean durable freshness', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => ['cg-shared-meta-only'], async () => ({
        insertedTriples: 1,
        insertedDataTriples: 0,
        insertedMetaTriples: 1,
        timedOutPhases: 0,
        failedPeers: 0,
        deniedPhases: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
    });

    expect(outcome).toBe('synced');
    expect(synced).toEqual([{ peerId: remotePeer, fresh: true }]);
  });

  it('does not stamp fresh when shared-memory has a post-response phase failure', async () => {
    const remotePeer = freshPeerIdString();
    const synced: Array<{ peerId: string; fresh: boolean | undefined }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => ['cg-shared-phase-failure'], async () => ({
        insertedTriples: 0,
        insertedDataTriples: 0,
        insertedMetaTriples: 0,
        timedOutPhases: 0,
        failedPeers: 0,
        failedPhases: 1,
        deniedPhases: 0,
      })),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
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
        ordinarySharedMemoryLane: ordinaryLane(() => [], async () => 0),
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
        logInfo: noopLog,
        onSyncAccounting: (peerId) => synced.push(peerId),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SyncOnConnectPostSyncError);
    expect((caught as SyncOnConnectPostSyncError).originalError).toBe(laterError);
    expect((caught as SyncOnConnectPostSyncError).cause).toBe(laterError);
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
        ordinarySharedMemoryLane: ordinaryLane(() => contextGraphs, async () => 0),
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
      ordinarySharedMemoryLane: ordinaryLane(() => ['devnet-test'], syncSharedMemoryFromPeer),
      remotePeer,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['devnet-test'],
      syncFromPeer,
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryOnConnect: false,
      logInfo: noopLog,
      onSyncAccounting: (peerId, outcome) => synced.push({ peerId, fresh: outcome?.fresh }),
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
      ordinarySharedMemoryLane: ordinaryLane(() => [], async () => 0),
      remotePeer,
      syncingPeers,
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [],
      syncFromPeer,
      refreshMetaSyncedFlags: async () => {},
      discoverContextGraphsFromStore: async () => 0,
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
      let admitted = false;
      const ensureAdmitted = recorder(async (peerId: string) => {
        admitted = true;
        return peerId === remotePeer;
      });
      const coordinator = (agent as any).networkAdmissionCoordinator;
      coordinator.isAcceptedPeer = () => admitted;
      coordinator.isRejectedPeer = () => false;
      coordinator.ensureAdmitted = ensureAdmitted;
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
      expect(ensureAdmitted.calls.map(([peerId]) => peerId)).toEqual([remotePeer]);
      expect((agent as any).skippedNoSyncPeers.has(remotePeer)).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('records mixed progress-and-failure backoff on the peer:update retry path', async () => {
    const agent = await DKGAgent.create({
      name: 'PeerUpdateMixedBackoff',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();
      const remotePeer = freshPeerIdString();
      allowAllNetworkAdmission(agent);
      (agent as any).skippedNoSyncPeers.add(remotePeer);
      (agent as any).isPeerConnectedForSyncBackoff = () => true;
      (agent as any).getSyncReconcilerProbe = async () => ({
        protocolsKey: PROTOCOL_SYNC,
        connectionKey: 'peer-update-test',
      });
      (agent as any).trySyncFromPeer = async (
        _peerId: string,
        onSyncAccounting?: (outcome: {
          reconcilerDisposition: 'clear' | 'retry' | 'defer';
          fresh: false;
          progress: boolean;
        }) => void,
      ) => {
        onSyncAccounting?.({
          reconcilerDisposition: 'retry',
          fresh: false,
          progress: true,
        });
        return 'synced';
      };

      agent.node.libp2p.dispatchEvent(new CustomEvent('peer:update', {
        detail: {
          peer: {
            id: { toString: () => remotePeer },
            protocols: [PROTOCOL_SYNC],
          },
        },
      } as any));

      for (let i = 0; i < 50 && !(agent as any).syncReconcilerBackoff.has(remotePeer); i++) {
        await new Promise(r => setTimeout(r, 10));
      }

      const backoff = (agent as any).syncReconcilerBackoff.get(remotePeer);
      expect(backoff?.failures).toBe(1);
      expect(backoff?.nextRetryAt).toBeGreaterThan(Date.now());
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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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

  it('defers a queue-full sync attempt without peer backoff and retries on the next reconciler tick', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerLocalBackpressureRetry',
      listenHost: '127.0.0.1',
      nodeRole: 'core',
      chainAdapter: new MockChainAdapter(),
      syncGlobalMaxInflight: 1,
      syncGlobalQueueLimit: 0,
      syncSharedMemoryOnConnect: false,
    });
    const occupiedFetch = deferred<SyncPageResult>();
    let fetchCalls = 0;
    let occupiedSlot: Promise<unknown> | undefined;
    try {
      await agent.start();
      allowAllNetworkAdmission(agent);
      stubDurableSyncExternalIo(agent);
      (agent as any).fetchSyncPages = async (...args: unknown[]) => {
        fetchCalls++;
        if (fetchCalls === 1) return occupiedFetch.promise;
        return emptySyncPage(String(args[4]));
      };

      const peerA = freshPeerIdString();
      const occupyingPeer = freshPeerIdString();
      const origGetPeers = agent.node.libp2p.getPeers.bind(agent.node.libp2p);
      (agent.node.libp2p as any).getPeers = recorder(
        () => [...origGetPeers(), peerIdFromString(peerA)],
      );
      (agent as any).getPeerProtocols = recorder(async () => [PROTOCOL_SYNC]);

      occupiedSlot = (agent as any).syncFromPeerDetailed(occupyingPeer, ['occupied-cg']);
      await waitFor(() => fetchCalls === 1);

      const origTrySync = (agent as any).trySyncFromPeer.bind(agent);
      const trySync = recorder((...args: unknown[]) => origTrySync(...args));
      (agent as any).trySyncFromPeer = trySync;

      const outcome = await (agent as any).attemptSyncFromPeerWithReconcilerAccounting(peerA, {
        protocolsKey: PROTOCOL_SYNC,
        connectionKey: null,
      });
      expect(outcome).toBe('deferred-backpressure');
      expect(trySync.calls).toHaveLength(1);
      expect((agent as any).syncReconcilerBackoff.has(peerA)).toBe(false);

      occupiedFetch.resolve(emptySyncPage('meta'));
      await occupiedSlot;
      occupiedSlot = undefined;

      await (agent as any).reconcileSyncFromConnectedPeers();
      await waitFor(() => trySync.calls.length === 2);

      expect(trySync.calls).toHaveLength(2);
      expect((agent as any).syncReconcilerBackoff.has(peerA)).toBe(false);
    } finally {
      occupiedFetch.resolve(emptySyncPage('meta'));
      await occupiedSlot?.catch(() => {});
      await agent.stop().catch(() => {});
    }
  });

  it('defers wrapped private shared-memory admission pressure without peer backoff', async () => {
    const agent = await DKGAgent.create({
      name: 'ReconcilerPrivateRecoveryBackpressure',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      syncContextGraphs: ['private-cg'],
      syncGlobalMaxInflight: 1,
      syncGlobalQueueLimit: 0,
    });
    let occupiedSlot: Promise<void> | undefined;
    let releaseOccupiedSlot: (() => void) | undefined;
    try {
      await agent.start();
      allowAllNetworkAdmission(agent);
      stubDurableSyncExternalIo(agent);
      (agent as any).fetchSyncPages = async (...args: unknown[]) => emptySyncPage(String(args[4]));

      const peerA = freshPeerIdString();
      const origGetPeers = agent.node.libp2p.getPeers.bind(agent.node.libp2p);
      (agent.node.libp2p as any).getPeers = recorder(
        () => [...origGetPeers(), peerIdFromString(peerA)],
      );
      (agent as any).getPeerProtocols = recorder(async () => [PROTOCOL_SYNC]);
      let occupied = false;
      (agent as any).refreshMetaSyncedFlags = recorder(async () => {
        if (occupied) return;
        occupied = true;
        occupiedSlot = withGlobalSyncBackpressure(
          {
            policy: resolveSyncGlobalBackpressure((agent as any).config),
            ctx: createOperationContext('sync'),
            label: 'post-durable-occupied-slot',
          },
          async () => new Promise<void>((resolve) => {
            releaseOccupiedSlot = resolve;
          }),
        );
        await waitFor(() => releaseOccupiedSlot !== undefined);
      });
      (agent as any).discoverContextGraphsFromStore = recorder(async () => 0);
      (agent as any).planSharedMemorySyncContextGraphs = recorder(async () => ({
        targets: [{ contextGraphId: 'private-cg', lane: 'ordinary-private' }],
      }));
      const recoverContextGraphSwmFromPeer = recorder(async () => ({
        insertedDataQuads: 0,
        insertedMetaQuads: 0,
        droppedDataTriples: 0,
        completed: true,
      }));
      (agent as any).recoverContextGraphSwmFromPeer = recoverContextGraphSwmFromPeer;

      const outcome = await (agent as any).attemptSyncFromPeerWithReconcilerAccounting(peerA, {
        protocolsKey: PROTOCOL_SYNC,
        connectionKey: null,
      });
      expect(outcome).toBe('deferred-backpressure');
      expect(recoverContextGraphSwmFromPeer.calls).toEqual([]);
      expect((agent as any).syncReconcilerBackoff.has(peerA)).toBe(false);
    } finally {
      releaseOccupiedSlot?.();
      await occupiedSlot?.catch(() => {});
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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

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

      expect((agent as any).catchupOnConnectAt.get(remotePeer)).toBeGreaterThanOrEqual(sameTickBoundary);
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
      allowAllNetworkAdmission(agent);

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
      nodeRole: 'core',
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();
      allowAllNetworkAdmission(agent);

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
      allowAllNetworkAdmission(agent);

      const peerA = freshPeerIdString();
      const origGetPeers = agent.node.libp2p.getPeers.bind(agent.node.libp2p);
      (agent.node.libp2p as any).getPeers = recorder(
        () => [...origGetPeers(), peerIdFromString(peerA)],
      );

      const calls: string[] = [];
      (agent as any).trySyncFromPeer = async (
        peerId: string,
        onSyncAccounting: (outcome: SyncOnConnectPeerOutcome) => void,
      ) => {
        calls.push(peerId);
        onSyncAccounting({
          reconcilerDisposition: 'clear',
          fresh: false,
          progress: true,
        });
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
      allowAllNetworkAdmission(agent);

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
