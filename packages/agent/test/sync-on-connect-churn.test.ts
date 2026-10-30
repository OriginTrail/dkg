import { stubDurableSync } from './_helpers/stub-durable-sync.js';
import { describe, expect, it } from 'vitest';
import { PeerCapabilityRegistry } from '../src/p2p/peer-capability.js';
import { PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS, SYNC_RECONNECT_FLAP_GRACE_MS } from '../src/dkg-agent-constants.js';
import { InMemoryPeerSyncLease, runSyncOnConnect } from '../src/sync/on-connect/sync-on-connect.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { allowAllNetworkAdmission, createUnstartedAgent, emptyDetailedSync, flushTimers, installSyncOnConnectPeerJobStub, peerSyncSessionDriver, recorder, resetPeerSyncSessionForTest } from './_helpers/sync-on-connect-test-fixture.js';
import { ordinaryLane } from './_helpers/run-sync-on-connect.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const PEER_B = '12D3KooWRnKxyUg8W3ju7BpxN3e9NAsG1T4d6TuK53LZxD41f3RC';
const ACTIVE_SYNC_LIFETIME = new AbortController().signal;

const noopLog = (_ctx: OperationContext, _message: string) => {};

describe('sync-on-connect churn gates', () => {
  it('keeps agents, ontology, and configured graphs in the sync-on-connect metadata scope', async () => {
    const refreshMetaSyncedFlags = recorder(async () => undefined);
    const configuredGraph = 'configured-default-cg';

    const outcome = await runSyncOnConnect({
      signal: ACTIVE_SYNC_LIFETIME,
      remotePeer: PEER_A,
      syncingPeers: new InMemoryPeerSyncLease(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      peerCapabilities: new PeerCapabilityRegistry(),
      getSyncContextGraphs: () => [configuredGraph],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags,
      discoverContextGraphsFromStore: async () => 0,
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

  it('uses the exact automatic durable scope supplied by the role policy', async () => {
    const syncFromPeer = recorder(async () => 0);
    const refreshMetaSyncedFlags = recorder(async () => undefined);

    const outcome = await runSyncOnConnect({
      signal: ACTIVE_SYNC_LIFETIME,
      remotePeer: PEER_A,
      syncingPeers: new InMemoryPeerSyncLease(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      peerCapabilities: new PeerCapabilityRegistry(),
      getSyncContextGraphs: () => ['selected-cg'],
      getDurableSyncContextGraphs: () => ['selected-cg'],
      syncFromPeer,
      refreshMetaSyncedFlags,
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(syncFromPeer.calls).toEqual([[PEER_A, ['selected-cg']]]);
    expect([...refreshMetaSyncedFlags.calls[0][0]]).toEqual(['selected-cg']);
  });

  it('treats an empty automatic durable scope as a clean no-op', async () => {
    const syncFromPeer = recorder(async () => 0);
    const refreshMetaSyncedFlags = recorder(async () => undefined);
    const discoverContextGraphsFromStore = recorder(async () => 0);
    const syncedPeers: Array<{ peerId: string; fresh: boolean; progress?: boolean }> = [];

    const outcome = await runSyncOnConnect({
      signal: ACTIVE_SYNC_LIFETIME,
      remotePeer: PEER_A,
      syncingPeers: new InMemoryPeerSyncLease(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      peerCapabilities: new PeerCapabilityRegistry(),
      getSyncContextGraphs: () => [],
      getDurableSyncContextGraphs: () => [],
      syncFromPeer,
      refreshMetaSyncedFlags,
      discoverContextGraphsFromStore,
      logInfo: noopLog,
      onSyncAccounting: (peerId, syncOutcome) => {
        syncedPeers.push({ peerId, fresh: syncOutcome?.fresh ?? false, progress: syncOutcome?.progress });
      },
    });

    expect(outcome).toBe('synced');
    expect(syncFromPeer.calls).toEqual([]);
    expect(refreshMetaSyncedFlags.calls).toEqual([]);
    expect(discoverContextGraphsFromStore.calls).toEqual([[]]);
    expect(syncedPeers).toEqual([{ peerId: PEER_A, fresh: true, progress: false }]);
  });

  it.each([
    ['edge', ['selected-cg']],
    ['core', [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, 'selected-cg']],
  ] as const)('wires the %s role into the automatic durable scope', async (nodeRole, expectedScope) => {
    const agent = await createUnstartedAgent(`AutomaticSystemScope-${nodeRole}`);
    allowAllNetworkAdmission(agent);
    agent.started = true;
    resetPeerSyncSessionForTest(agent);
    agent.config.nodeRole = nodeRole;
    agent.config.syncContextGraphs = ['selected-cg'];
    agent.config.syncSharedMemoryOnConnect = false;
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    const syncFromPeerDetailed = recorder(async () => emptyDetailedSync({ completedPhases: 1 }));
    stubDurableSync(agent, syncFromPeerDetailed);
    agent.refreshMetaSyncedFlags = async () => undefined;
    agent.discoverContextGraphsFromStore = async () => 0;
    agent.planSharedMemorySyncContextGraphs = async () => ({
      targets: [],
    });

    expect(await agent.trySyncFromPeer(PEER_A)).toBe('synced');
    const requestedScope = syncFromPeerDetailed.calls
      .flatMap((call) => call[1] as string[])
      .sort();
    expect(requestedScope).toEqual([...expectedScope].sort());
  });

  it('keeps explicit Edge catch-up available for system Context Graphs', async () => {
    const agent = await createUnstartedAgent('ExplicitSystemGraphCatchup');
    agent.config.nodeRole = 'edge';
    const syncFromPeerDetailed = recorder(async () => emptyDetailedSync());
    stubDurableSync(agent, syncFromPeerDetailed);

    await agent.syncFromPeer(PEER_A, [
      SYSTEM_CONTEXT_GRAPHS.AGENTS,
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
    ]);

    expect(syncFromPeerDetailed.calls[0][1]).toEqual([
      SYSTEM_CONTEXT_GRAPHS.AGENTS,
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
    ]);
  });

  it('dedupes repeated reconnect scheduling across a short relay flap', async () => {
    const agent = await createUnstartedAgent('SyncReconnectFlapDedup');
    const calls: string[] = [];
    const runOrdinary = async (peerId: string) => {
      calls.push(peerId);
    };
    installSyncOnConnectPeerJobStub(agent, { runOrdinary });

    const handleSyncError = () => undefined;
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    const firstQueuedAt = peerSyncSessionDriver(agent).snapshot(PEER_A).lastQueued;

    agent.lastSyncDisconnectedAt.set(PEER_A, Date.now() - Math.floor(SYNC_RECONNECT_FLAP_GRACE_MS / 2));
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(false);
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(false);
    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).lastQueued).toBe(firstQueuedAt);

    await flushTimers();
    expect(calls).toEqual([PEER_A]);
  });

  it('allows reconnect catch-up after a meaningful offline gap', async () => {
    const agent = await createUnstartedAgent('SyncReconnectOfflineGap');
    const calls: string[] = [];
    const runOrdinary = async (peerId: string) => {
      calls.push(peerId);
    };
    installSyncOnConnectPeerJobStub(agent, { runOrdinary });

    const lastDisconnected = Date.now() - SYNC_RECONNECT_FLAP_GRACE_MS - 100;
    const beforeDisconnect = lastDisconnected - 1;
    peerSyncSessionDriver(agent).recordFreshness(PEER_A, { successfulAt: beforeDisconnect });
    peerSyncSessionDriver(agent).recordQueued(PEER_A, beforeDisconnect);
    agent.lastSyncDisconnectedAt.set(PEER_A, lastDisconnected);

    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(true);
    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).lastQueued).toBeGreaterThan(lastDisconnected);

    await flushTimers();
    expect(calls).toEqual([PEER_A]);
  });

  it('labels the connect-driven admission on-connect, not unspecified', async () => {
    // The complement of the reconciler assertion below, and the source with the
    // highest production volume: every reconnect sync flows through this
    // default. Nothing pinned it, so changing the default would silently
    // relabel most sync-global pressure on the operator dashboards.
    const agent = await createUnstartedAgent('SyncOnConnectSourceLabel');
    agent.started = true;
    resetPeerSyncSessionForTest(agent);
    const sources: unknown[] = [];
    agent.trySyncFromPeer = async (
      _peer: string,
      _onAccounting: unknown,
      source: unknown,
    ) => {
      sources.push(source);
      return undefined;
    };

    await agent.attemptSyncFromPeerWithReconcilerAccounting(PEER_A, {
      connected: true,
      hasSyncProtocol: true,
    });

    expect(sources).toEqual(['on-connect']);
  });

  it('reconciler still retries stale connected peers', async () => {
    const agent = await createUnstartedAgent('SyncReconcilerStillRetries');
    agent.started = true;
    resetPeerSyncSessionForTest(agent);
    agent.node.node = {
      status: 'started',
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    const trySyncFromPeer = recorder(async () => undefined);
    agent.trySyncFromPeer = trySyncFromPeer;

    await agent.reconcileSyncFromConnectedPeers();
    await flushTimers();

    // The third argument is the bounded admission origin (issue #2006): the
    // reconciler's queue pressure must be attributable to `reconcile`, not
    // indistinguishable from sync-on-connect. Selected/ordinary phase history
    // exists only inside a queued peer job. The fourth, `null`, is the graph
    // scope: the reconciler always syncs the peer's whole scope.
    expect(trySyncFromPeer.calls).toEqual([[
      PEER_A,
      expect.any(Function),
      'reconcile',
      null,
    ]]);
  });

  it('uses configured staleness and backoff values in the sync lifecycle', async () => {
    const agent = await createUnstartedAgent('ConfiguredSyncTimingConsumers', {
      syncStalenessThresholdMs: 20_000,
      syncBackoffBaseMs: 5_000,
      syncBackoffMaxMs: 30_000,
      syncBackoffJitter: 0,
    });
    agent.started = true;
    resetPeerSyncSessionForTest(agent);
    agent.node.node = {
      status: 'started',
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    peerSyncSessionDriver(agent).recordFreshness(PEER_A, {
      successfulAt: Date.now() - 30_000,
    });
    const trySyncFromPeer = recorder(async () => undefined);
    agent.trySyncFromPeer = trySyncFromPeer;
    const before = Date.now();

    await agent.reconcileSyncFromConnectedPeers();
    await flushTimers();

    expect(trySyncFromPeer.calls).toHaveLength(1);
    const backoff = peerSyncSessionDriver(agent).snapshot(PEER_A).backoff;
    expect(backoff?.failures).toBe(1);
    expect(backoff?.nextRetryAt - before).toBeGreaterThanOrEqual(5_000);
    expect(backoff?.nextRetryAt - before).toBeLessThan(5_100);
  });

  it('does not let one peer backoff suppress connection-open sync for another peer', async () => {
    const agent = await createUnstartedAgent('SyncReconnectBackoffPeerScoped');
    const calls: string[] = [];
    const runOrdinary = async (peerId: string) => {
      calls.push(peerId);
    };
    installSyncOnConnectPeerJobStub(agent, { runOrdinary });
    peerSyncSessionDriver(agent).recordBackoff(PEER_A, {
      failures: 1,
      nextRetryAt: Date.now() + CATCHUP_ON_CONNECT_COOLDOWN_MS,
      protocolsKey: null,
      connectionKey: null,
    });
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(false);
    expect(agent.queueSyncFromPeerOnConnect(PEER_B, () => undefined, 0)).toBe(true);

    await flushTimers();
    expect(calls).toEqual([PEER_B]);
  });

  it('allows connection-open sync after peer backoff cooldown expires', async () => {
    const agent = await createUnstartedAgent('SyncReconnectBackoffExpiry');
    const calls: string[] = [];
    const runOrdinary = async (peerId: string) => {
      calls.push(peerId);
    };
    installSyncOnConnectPeerJobStub(agent, { runOrdinary });
    peerSyncSessionDriver(agent).recordBackoff(PEER_A, {
      failures: 1,
      nextRetryAt: Date.now() - 1,
      protocolsKey: null,
      connectionKey: null,
    });
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(true);

    await flushTimers();
    expect(calls).toEqual([PEER_A]);
  });

  it('makes sync-on-connect requester paths no-op when the emergency switch is disabled', async () => {
    const agent = await createUnstartedAgent('SyncOnConnectDisabled');
    agent.config.syncOnConnectEnabled = false;
    agent.started = true;
    resetPeerSyncSessionForTest(agent);
    const calls: string[] = [];
    const runOrdinary = async (peerId: string) => {
      calls.push(peerId);
    };
    installSyncOnConnectPeerJobStub(agent, { runOrdinary });

    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(false);
    expect(await agent.trySyncFromPeer(PEER_A)).toBe('not-started');

    await flushTimers();
    expect(calls).toEqual([]);
  });

  it('makes durable sync requester paths no-op when the emergency switch is disabled', async () => {
    const agent = await createUnstartedAgent('DurableSyncDisabled');
    agent.config.durableSyncEnabled = false;

    const durable = await agent.syncFromPeerDetailed(PEER_A, ['cg-a']);
    expect(durable).toMatchObject({
      insertedTriples: 0,
      failedPeers: 0,
      failedPhases: 0,
    });

    const shared = await agent.syncSharedMemoryFromPeerDetailed(PEER_A, ['cg-a']);
    expect(shared).toMatchObject({
      insertedTriples: 0,
      failedPeers: 0,
      failedPhases: 0,
    });

    const recovery = await agent.recoverContextGraphSwmFromPeer(PEER_A, 'cg-a');
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
    agent.subscribedContextGraphs.set(contextGraphId, {
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
    });
    agent.persistLocalNodeMembership = () => undefined;
    agent.refreshMetaSyncedFlags = recorder(async () => undefined);
    agent.waitForSyncProtocol = recorder(async () => true);
    stubDurableSync(agent, recorder(async () => ({
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
    })));
    agent.syncSharedMemoryFromPeerDetailed = recorder(async () => ({
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

    const result = await agent.runCatchupOverPeers(
      contextGraphId,
      true,
      [{ toString: () => PEER_A }],
    );

    expect(result.dataSynced).toBe(0);
    expect(result.sharedMemorySynced).toBe(4);
    expect(agent.subscribedContextGraphs.get(contextGraphId)).toMatchObject({
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
    });
  });

  it('skips SWM sync-on-connect fanout when no CG is locally eligible', async () => {
    const syncSharedMemoryFromPeer = recorder(async () => 0);

    const outcome = await runSyncOnConnect({
      signal: ACTIVE_SYNC_LIFETIME,
      ordinarySharedMemoryLane: ordinaryLane(() => [], syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new InMemoryPeerSyncLease(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      peerCapabilities: new PeerCapabilityRegistry(),
      getSyncContextGraphs: () => ['unauthorized-cg'],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(syncSharedMemoryFromPeer.calls).toEqual([]);
  });

  it('passes the connecting peer into the SWM sync-scope selector', async () => {
    const syncSharedMemoryFromPeer = recorder(async () => 0);
    let selectedForPeer: string | undefined;

    const outcome = await runSyncOnConnect({
      signal: ACTIVE_SYNC_LIFETIME,
      ordinarySharedMemoryLane: ordinaryLane((peerId) => {
        selectedForPeer = peerId;
        return ['eligible-cg'];
      }, syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new InMemoryPeerSyncLease(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      peerCapabilities: new PeerCapabilityRegistry(),
      getSyncContextGraphs: () => ['eligible-cg'],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(selectedForPeer).toBe(PEER_A);
    expect(syncSharedMemoryFromPeer.calls).toEqual([[PEER_A, ['eligible-cg']]]);
  });

  it('preserves successful SWM sync-on-connect for eligible CGs', async () => {
    const syncSharedMemoryFromPeer = recorder(async () => 0);

    const outcome = await runSyncOnConnect({
      signal: ACTIVE_SYNC_LIFETIME,
      ordinarySharedMemoryLane: ordinaryLane(() => ['eligible-cg'], syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new InMemoryPeerSyncLease(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      peerCapabilities: new PeerCapabilityRegistry(),
      getSyncContextGraphs: () => ['eligible-cg'],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(syncSharedMemoryFromPeer.calls).toEqual([[PEER_A, ['eligible-cg']]]);
  });

  it('filters private SWM sync-on-connect scope to the matching curator peer', async () => {
    const agent = await createUnstartedAgent('SwmPeerScopedRecovery', {
      rfc64CatalogActivation: { enabled: false },
    });
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({
      legacySyncAllowed: true,
    } as ReturnType<typeof agent.resolveRfc64CatalogReceiverAuthorityV1>);
    const privateCg = 'private-cg';
    const otherPrivateCg = 'other-private-cg';
    const localPrivateCg = 'local-private-cg';
    const unconfirmedCg = 'unconfirmed-cg';
    agent.config.syncContextGraphs = [
      'public-cg',
      privateCg,
      otherPrivateCg,
      localPrivateCg,
      unconfirmedCg,
    ];
    agent.canUseSharedMemoryForContextGraph = async (contextGraphId: string) =>
      contextGraphId !== unconfirmedCg;
    agent.isPrivateContextGraph = async (contextGraphId: string) =>
      contextGraphId.includes('private');
    agent.isCuratorOf = async (contextGraphId: string) =>
      contextGraphId === localPrivateCg;
    agent.resolveCuratorPeerId = async (contextGraphId: string) => {
      if (contextGraphId === privateCg) return PEER_A;
      if (contextGraphId === otherPrivateCg) return 'other-peer';
      return undefined;
    };
    agent.refreshMetaFromCurator = async () => undefined;

    expect(await agent.getSharedMemorySyncContextGraphs(PEER_A)).toEqual([
      'public-cg',
      privateCg,
    ]);
    expect(await agent.getSharedMemorySyncContextGraphs()).toEqual([
      'public-cg',
      privateCg,
      otherPrivateCg,
      localPrivateCg,
    ]);
  });
});
