import { describe, expect, it } from 'vitest';
import { PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS, SYNC_RECONNECT_FLAP_GRACE_MS } from '../src/dkg-agent-constants.js';
import { runSyncOnConnect } from '../src/sync/on-connect/sync-on-connect.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const PEER_B = '12D3KooWRnKxyUg8W3ju7BpxN3e9NAsG1T4d6TuK53LZxD41f3RC';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function createUnstartedAgent(name: string): Promise<DKGAgent> {
  return DKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(),
  });
}

const noopLog = (_ctx: OperationContext, _message: string) => {};

function emptyDetailedSync(overrides: Record<string, number> = {}) {
  return {
    insertedTriples: 0,
    insertedDataTriples: 0,
    insertedMetaTriples: 0,
    metaOnlyResponses: 0,
    completedPhases: 0,
    checkpointAdvances: 0,
    timedOutPhases: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    backoffWorthyFailures: 0,
    ...overrides,
  };
}

describe('sync-on-connect churn gates', () => {
  it('keeps agents, ontology, and configured graphs in the sync-on-connect metadata scope', async () => {
    const refreshMetaSyncedFlags = recorder(async () => undefined);
    const configuredGraph = 'configured-default-cg';

    const outcome = await runSyncOnConnect({
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => [configuredGraph],
      getSharedMemorySyncContextGraphs: () => [],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => 0,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(refreshMetaSyncedFlags.calls).toHaveLength(1);
    expect([...refreshMetaSyncedFlags.calls[0][0]]).toEqual([
      SYSTEM_CONTEXT_GRAPHS.AGENTS,
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      configuredGraph,
    ]);
  });

  it('dedupes repeated reconnect scheduling across a short relay flap', async () => {
    const agent = await createUnstartedAgent('SyncReconnectFlapDedup');
    const calls: string[] = [];
    (agent as any).runSyncFromPeerOnConnect = async (peerId: string) => {
      calls.push(peerId);
    };

    const handleSyncError = () => undefined;
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    const firstQueuedAt = (agent as any).catchupOnConnectAt.get(PEER_A);

    (agent as any).lastSyncDisconnectedAt.set(PEER_A, Date.now() - Math.floor(SYNC_RECONNECT_FLAP_GRACE_MS / 2));
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(false);
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(false);
    expect((agent as any).catchupOnConnectAt.get(PEER_A)).toBe(firstQueuedAt);

    await flushTimers();
    expect(calls).toEqual([PEER_A]);
  });

  it('allows reconnect catch-up after a meaningful offline gap', async () => {
    const agent = await createUnstartedAgent('SyncReconnectOfflineGap');
    const calls: string[] = [];
    (agent as any).runSyncFromPeerOnConnect = async (peerId: string) => {
      calls.push(peerId);
    };

    const lastDisconnected = Date.now() - SYNC_RECONNECT_FLAP_GRACE_MS - 100;
    const beforeDisconnect = lastDisconnected - 1;
    (agent as any).lastSuccessfulSyncAt.set(PEER_A, beforeDisconnect);
    (agent as any).catchupOnConnectAt.set(PEER_A, beforeDisconnect);
    (agent as any).lastSyncDisconnectedAt.set(PEER_A, lastDisconnected);

    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(true);
    expect((agent as any).catchupOnConnectAt.get(PEER_A)).toBeGreaterThan(lastDisconnected);

    await flushTimers();
    expect(calls).toEqual([PEER_A]);
  });

  it('reconciler still retries stale connected peers', async () => {
    const agent = await createUnstartedAgent('SyncReconcilerStillRetries');
    (agent as any).started = true;
    (agent.node as any).node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    const trySyncFromPeer = recorder(async () => undefined);
    (agent as any).trySyncFromPeer = trySyncFromPeer;

    await (agent as any).reconcileSyncFromConnectedPeers();
    await flushTimers();

    // The third argument is the bounded admission origin (issue #2006): the
    // reconciler's queue pressure must be attributable to `reconcile`, not
    // indistinguishable from sync-on-connect.
    expect(trySyncFromPeer.calls).toEqual([[PEER_A, expect.any(Function), 'reconcile']]);
  });

  it('records backoff after a failed sync round and blocks connection-open rescheduling', async () => {
    const agent = await createUnstartedAgent('SyncReconnectBackoff');
    (agent as any).started = true;
    (agent.node as any).node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    (agent as any).trySyncFromPeer = async () => 'synced';

    await (agent as any).runSyncFromPeerOnConnect(PEER_A, () => undefined);

    const backoff = (agent as any).syncReconcilerBackoff.get(PEER_A);
    expect(backoff?.failures).toBe(1);
    expect(backoff?.nextRetryAt).toBeGreaterThan(Date.now());

    const staleQueuedAt = Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1;
    (agent as any).catchupOnConnectAt.set(PEER_A, staleQueuedAt);
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(false);
    expect((agent as any).catchupOnConnectAt.get(PEER_A)).toBe(staleQueuedAt);
  });

  it('does not let one peer backoff suppress connection-open sync for another peer', async () => {
    const agent = await createUnstartedAgent('SyncReconnectBackoffPeerScoped');
    const calls: string[] = [];
    (agent as any).syncReconcilerBackoff.set(PEER_A, {
      failures: 1,
      nextRetryAt: Date.now() + CATCHUP_ON_CONNECT_COOLDOWN_MS,
      protocolsKey: null,
      connectionKey: null,
    });
    (agent as any).runSyncFromPeerOnConnect = async (peerId: string) => {
      calls.push(peerId);
    };

    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(false);
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_B, () => undefined, 0)).toBe(true);

    await flushTimers();
    expect(calls).toEqual([PEER_B]);
  });

  it('allows connection-open sync after peer backoff cooldown expires', async () => {
    const agent = await createUnstartedAgent('SyncReconnectBackoffExpiry');
    const calls: string[] = [];
    (agent as any).syncReconcilerBackoff.set(PEER_A, {
      failures: 1,
      nextRetryAt: Date.now() - 1,
      protocolsKey: null,
      connectionKey: null,
    });
    (agent as any).runSyncFromPeerOnConnect = async (peerId: string) => {
      calls.push(peerId);
    };

    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(true);

    await flushTimers();
    expect(calls).toEqual([PEER_A]);
  });

  it('makes sync-on-connect requester paths no-op when the emergency switch is disabled', async () => {
    const agent = await createUnstartedAgent('SyncOnConnectDisabled');
    (agent as any).config.syncOnConnectEnabled = false;
    (agent as any).started = true;
    const calls: string[] = [];
    (agent as any).runSyncFromPeerOnConnect = async (peerId: string) => {
      calls.push(peerId);
    };

    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(false);
    expect(await (agent as any).trySyncFromPeer(PEER_A)).toBe('not-started');

    await flushTimers();
    expect(calls).toEqual([]);
  });

  it('makes durable sync requester paths no-op when the emergency switch is disabled', async () => {
    const agent = await createUnstartedAgent('DurableSyncDisabled');
    (agent as any).config.durableSyncEnabled = false;

    const durable = await (agent as any).syncFromPeerDetailed(PEER_A, ['cg-a']);
    expect(durable).toMatchObject({
      insertedTriples: 0,
      failedPeers: 0,
      failedPhases: 0,
    });

    const shared = await (agent as any).syncSharedMemoryFromPeerDetailed(PEER_A, ['cg-a']);
    expect(shared).toMatchObject({
      insertedTriples: 0,
      failedPeers: 0,
      failedPhases: 0,
    });

    const recovery = await (agent as any).recoverContextGraphSwmFromPeer(PEER_A, 'cg-a');
    expect(recovery).toEqual({
      replacedRoots: 0,
      replacedGraphs: 0,
      insertedDataQuads: 0,
      insertedMetaQuads: 0,
      droppedDataTriples: 0,
      readySnapshots: 0,
      totalSnapshots: 0,
      completed: true,
    });
  });

  it('marks a subscribed context graph synced after SWM-only catchup progress', async () => {
    const agent = await createUnstartedAgent('SwmOnlyCatchupMarksSynced');
    const contextGraphId = 'swm-only-catchup-cg';
    (agent as any).subscribedContextGraphs.set(contextGraphId, {
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
    });
    (agent as any).persistLocalNodeMembership = () => undefined;
    (agent as any).refreshMetaSyncedFlags = recorder(async () => undefined);
    (agent as any).waitForSyncProtocol = recorder(async () => true);
    (agent as any).syncFromPeerDetailed = recorder(async () => ({
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
      deniedPhases: 0,
    }));
    (agent as any).syncSharedMemoryFromPeerDetailed = recorder(async () => ({
      insertedTriples: 4,
      fetchedMetaTriples: 0,
      fetchedDataTriples: 4,
      insertedMetaTriples: 0,
      insertedDataTriples: 4,
      bytesReceived: 0,
      resumedPhases: 0,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
      emptyResponses: 0,
      droppedDataTriples: 0,
      failedPeers: 0,
      failedPhases: 0,
      deniedPhases: 0,
    }));

    const result = await (agent as any).runCatchupOverPeers(
      contextGraphId,
      true,
      [{ toString: () => PEER_A }],
    );

    expect(result.dataSynced).toBe(0);
    expect(result.sharedMemorySynced).toBe(4);
    expect((agent as any).subscribedContextGraphs.get(contextGraphId)).toMatchObject({
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
    });
  });

  it('records progress before stopping post-durable sync-on-connect fanout after backoff-worthy durable pressure', async () => {
    const refreshMetaSyncedFlags = recorder(async () => undefined);
    const discoverContextGraphsFromStore = recorder(async () => 0);
    const syncSharedMemoryFromPeer = recorder(async () => 0);
    const syncedPeers: Array<{ peerId: string; fresh: boolean; progress?: boolean }> = [];

    const outcome = await runSyncOnConnect({
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['cg-a'],
      syncFromPeer: async () => emptyDetailedSync({
        insertedTriples: 3,
        insertedDataTriples: 3,
        completedPhases: 1,
        checkpointAdvances: 1,
        timedOutPhases: 1,
        backoffWorthyFailures: 1,
      }),
      refreshMetaSyncedFlags,
      discoverContextGraphsFromStore,
      syncSharedMemoryFromPeer,
      logInfo: noopLog,
      onPeerSynced: (peerId, syncOutcome) => {
        syncedPeers.push({ peerId, fresh: syncOutcome?.fresh ?? false, progress: syncOutcome?.progress });
      },
    });

    expect(outcome).toBe('synced');
    expect(refreshMetaSyncedFlags.calls).toEqual([]);
    expect(discoverContextGraphsFromStore.calls).toEqual([]);
    expect(syncSharedMemoryFromPeer.calls).toEqual([]);
    expect(syncedPeers).toEqual([{ peerId: PEER_A, fresh: false, progress: true }]);
  });

  it('records progress before stopping newly discovered CG fanout after durable pressure', async () => {
    let contextGraphs = ['cg-a'];
    const refreshMetaSyncedFlags = recorder(async () => undefined);
    const discoverContextGraphsFromStore = recorder(async () => {
      contextGraphs = ['cg-a', 'cg-b'];
      return 1;
    });
    const syncSharedMemoryFromPeer = recorder(async () => 0);
    const syncedPeers: Array<{ peerId: string; fresh: boolean; progress?: boolean }> = [];
    const syncFromPeer = recorder(async (_peerId: string, contextGraphIds?: string[]) => {
      if (contextGraphIds?.includes('cg-b')) {
        return emptyDetailedSync({
          insertedTriples: 4,
          insertedDataTriples: 4,
          completedPhases: 1,
          checkpointAdvances: 1,
          timedOutPhases: 1,
          backoffWorthyFailures: 1,
        });
      }
      return emptyDetailedSync();
    });

    const outcome = await runSyncOnConnect({
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => contextGraphs,
      syncFromPeer,
      refreshMetaSyncedFlags,
      discoverContextGraphsFromStore,
      syncSharedMemoryFromPeer,
      logInfo: noopLog,
      onPeerSynced: (peerId, syncOutcome) => {
        syncedPeers.push({ peerId, fresh: syncOutcome?.fresh ?? false, progress: syncOutcome?.progress });
      },
    });

    expect(outcome).toBe('synced');
    expect(syncFromPeer.calls).toEqual([[PEER_A], [PEER_A, ['cg-b']]]);
    expect(refreshMetaSyncedFlags.calls).toHaveLength(1);
    expect(discoverContextGraphsFromStore.calls).toEqual([[]]);
    expect(syncSharedMemoryFromPeer.calls).toEqual([]);
    expect(syncedPeers).toEqual([{ peerId: PEER_A, fresh: false, progress: true }]);
  });

  it('skips SWM sync-on-connect fanout when no CG is locally eligible', async () => {
    const syncSharedMemoryFromPeer = recorder(async () => 0);

    const outcome = await runSyncOnConnect({
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['unauthorized-cg'],
      getSharedMemorySyncContextGraphs: () => [],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(syncSharedMemoryFromPeer.calls).toEqual([]);
  });

  it('passes the connecting peer into the SWM sync-scope selector', async () => {
    const syncSharedMemoryFromPeer = recorder(async () => 0);
    let selectedForPeer: string | undefined;

    const outcome = await runSyncOnConnect({
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['eligible-cg'],
      getSharedMemorySyncContextGraphs: (peerId) => {
        selectedForPeer = peerId;
        return ['eligible-cg'];
      },
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(selectedForPeer).toBe(PEER_A);
    expect(syncSharedMemoryFromPeer.calls).toEqual([[PEER_A, ['eligible-cg']]]);
  });

  it('preserves successful SWM sync-on-connect for eligible CGs', async () => {
    const syncSharedMemoryFromPeer = recorder(async () => 0);

    const outcome = await runSyncOnConnect({
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['eligible-cg'],
      getSharedMemorySyncContextGraphs: () => ['eligible-cg'],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(syncSharedMemoryFromPeer.calls).toEqual([[PEER_A, ['eligible-cg']]]);
  });

  it('filters private SWM sync-on-connect scope to the matching curator peer', async () => {
    const agent = await createUnstartedAgent('SwmPeerScopedRecovery');
    const privateCg = 'private-cg';
    const otherPrivateCg = 'other-private-cg';
    const localPrivateCg = 'local-private-cg';
    const unconfirmedCg = 'unconfirmed-cg';
    (agent as any).config.syncContextGraphs = [
      'public-cg',
      privateCg,
      otherPrivateCg,
      localPrivateCg,
      unconfirmedCg,
    ];
    (agent as any).canUseSharedMemoryForContextGraph = async (contextGraphId: string) =>
      contextGraphId !== unconfirmedCg;
    (agent as any).isPrivateContextGraph = async (contextGraphId: string) =>
      contextGraphId.includes('private');
    (agent as any).isCuratorOf = async (contextGraphId: string) =>
      contextGraphId === localPrivateCg;
    (agent as any).resolveCuratorPeerId = async (contextGraphId: string) => {
      if (contextGraphId === privateCg) return PEER_A;
      if (contextGraphId === otherPrivateCg) return 'other-peer';
      return undefined;
    };
    (agent as any).refreshMetaFromCurator = async () => undefined;

    expect(await (agent as any).getSharedMemorySyncContextGraphs(PEER_A)).toEqual([
      'public-cg',
      privateCg,
    ]);
    expect(await (agent as any).getSharedMemorySyncContextGraphs()).toEqual([
      'public-cg',
      privateCg,
      otherPrivateCg,
      localPrivateCg,
    ]);
  });
});
