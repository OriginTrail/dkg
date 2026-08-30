import { describe, expect, it } from 'vitest';
import { PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS, SYNC_RECONNECT_FLAP_GRACE_MS } from '../src/dkg-agent-constants.js';
import {
  runSelectedSharedMemoryRetry,
  runSyncOnConnect,
} from '../src/sync/on-connect/sync-on-connect.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import {
  allowAllNetworkAdmission,
  createUnstartedAgent,
  emptyDetailedSync,
  flushTimers,
  installSyncOnConnectPeerJobStub,
  recorder,
} from './_helpers/sync-on-connect-test-fixture.js';
import { ordinaryLane } from './_helpers/run-sync-on-connect.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const PEER_B = '12D3KooWRnKxyUg8W3ju7BpxN3e9NAsG1T4d6TuK53LZxD41f3RC';

const noopLog = (_ctx: OperationContext, _message: string) => {};

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
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
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
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
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
    agent.config.nodeRole = nodeRole;
    agent.config.syncContextGraphs = ['selected-cg'];
    agent.config.syncSharedMemoryOnConnect = false;
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    const syncFromPeerDetailed = recorder(async () => emptyDetailedSync({ completedPhases: 1 }));
    agent.syncFromPeerDetailed = syncFromPeerDetailed;
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
    agent.syncFromPeerDetailed = syncFromPeerDetailed;

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
    const firstQueuedAt = agent.catchupOnConnectAt.get(PEER_A);

    agent.lastSyncDisconnectedAt.set(PEER_A, Date.now() - Math.floor(SYNC_RECONNECT_FLAP_GRACE_MS / 2));
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(false);
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(false);
    expect(agent.catchupOnConnectAt.get(PEER_A)).toBe(firstQueuedAt);

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
    agent.lastSuccessfulSyncAt.set(PEER_A, beforeDisconnect);
    agent.catchupOnConnectAt.set(PEER_A, beforeDisconnect);
    agent.lastSyncDisconnectedAt.set(PEER_A, lastDisconnected);

    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(true);
    expect(agent.catchupOnConnectAt.get(PEER_A)).toBeGreaterThan(lastDisconnected);

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
    agent.node.node = {
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
    // exists only inside a queued peer job.
    expect(trySyncFromPeer.calls).toEqual([[
      PEER_A,
      expect.any(Function),
      'reconcile',
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
    agent.node.node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    agent.lastSuccessfulSyncAt.set(PEER_A, Date.now() - 30_000);
    const trySyncFromPeer = recorder(async () => undefined);
    agent.trySyncFromPeer = trySyncFromPeer;
    const before = Date.now();

    await agent.reconcileSyncFromConnectedPeers();
    await flushTimers();

    expect(trySyncFromPeer.calls).toHaveLength(1);
    const backoff = agent.syncReconcilerBackoff.get(PEER_A);
    expect(backoff?.failures).toBe(1);
    expect(backoff?.nextRetryAt - before).toBeGreaterThanOrEqual(5_000);
    expect(backoff?.nextRetryAt - before).toBeLessThan(5_100);
  });

  it('records backoff after a failed sync round and blocks connection-open rescheduling', async () => {
    const agent = await createUnstartedAgent('SyncReconnectBackoff');
    agent.started = true;
    agent.node.node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    agent.trySyncFromPeer = async () => 'synced';

    await agent.attemptSyncFromPeerWithReconcilerAccounting(PEER_A, {
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });

    const backoff = agent.syncReconcilerBackoff.get(PEER_A);
    expect(backoff?.failures).toBe(1);
    expect(backoff?.nextRetryAt).toBeGreaterThan(Date.now());

    const staleQueuedAt = Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1;
    agent.catchupOnConnectAt.set(PEER_A, staleQueuedAt);
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(false);
    expect(agent.catchupOnConnectAt.get(PEER_A)).toBe(staleQueuedAt);
  });

  it('retains progress while backing off a mixed progress-and-failure round', async () => {
    const agent = await createUnstartedAgent('SyncReconnectPartialProgressBackoff', {
      syncContextGraphs: ['cg-a'],
    });
    allowAllNetworkAdmission(agent);
    (agent as any).started = true;
    (agent.node as any).node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [{
        remotePeer: { toString: () => PEER_A },
        direction: 'outbound',
        timeline: { open: 123 },
        remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/9090' },
      }],
    };
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    (agent as any).syncFromPeerDetailed = async () => emptyDetailedSync({
      insertedTriples: 3,
      insertedDataTriples: 3,
      completedPhases: 1,
      checkpointAdvances: 1,
      timedOutPhases: 1,
      backoffWorthyFailures: 1,
    });
    (agent as any).refreshMetaSyncedFlags = async () => undefined;
    (agent as any).discoverContextGraphsFromStore = async () => 0;
    (agent as any).planSharedMemorySyncContextGraphs = async () => ({ targets: [] });
    (agent as any).syncReconcilerBackoff.set(PEER_A, {
      failures: 2,
      nextRetryAt: Date.now() - 1,
      protocolsKey: null,
      connectionKey: null,
    });

    await (agent as any).attemptSyncFromPeerWithReconcilerAccounting(PEER_A, {
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });

    expect((agent as any).lastSyncProgressAt.get(PEER_A)).toBeGreaterThan(0);
    expect((agent as any).lastSuccessfulSyncAt.has(PEER_A)).toBe(false);
    const backoff = (agent as any).syncReconcilerBackoff.get(PEER_A);
    expect(backoff?.failures).toBe(3);
    expect(backoff?.nextRetryAt).toBeGreaterThan(Date.now());

    (agent as any).catchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(false);
  });

  it.each([
    {
      disposition: 'clear' as const,
      fresh: true as const,
      expectedFailures: undefined,
      expectedFresh: true,
    },
    {
      disposition: 'retry' as const,
      fresh: false as const,
      expectedFailures: 3,
      expectedFresh: false,
    },
    {
      disposition: 'defer' as const,
      fresh: false as const,
      expectedFailures: 2,
      expectedFresh: false,
    },
  ])(
    'applies $disposition accounting as one coherent lifecycle update',
    async ({ disposition, fresh, expectedFailures, expectedFresh }) => {
      const agent = await createUnstartedAgent(`SyncAccounting-${disposition}`);
      (agent as any).started = true;
      (agent as any).isPeerConnectedForSyncBackoff = () => true;
      (agent as any).syncReconcilerBackoff.set(PEER_A, {
        failures: 2,
        nextRetryAt: Date.now() - 1,
        protocolsKey: null,
        connectionKey: null,
      });

      (agent as any).applySyncOnConnectAccounting(
        PEER_A,
        {
          reconcilerDisposition: disposition,
          fresh,
          progress: true,
        },
        { protocolsKey: PROTOCOL_SYNC, connectionKey: 'accounting-test' },
      );

      expect((agent as any).lastSyncProgressAt.get(PEER_A)).toBeGreaterThan(0);
      expect((agent as any).lastSuccessfulSyncAt.has(PEER_A)).toBe(expectedFresh);
      expect((agent as any).syncReconcilerBackoff.get(PEER_A)?.failures)
        .toBe(expectedFailures);
    },
  );

  it('records reconciler backoff when selected SWM is explicitly incomplete without progress', async () => {
    const agent = await createUnstartedAgent('SelectedSwmIncompleteBackoff');
    agent.started = true;
    agent.node.node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    agent.selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    agent.trySelectedSwmRetryFromPeer = async (
      _peerId: string,
      onSyncAccounting?: (outcome: { fresh: boolean; progress?: boolean }) => void,
    ) => runSelectedSharedMemoryRetry({
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      selectedSharedMemoryLane: {
        admitWork: () => ({
          contextGraphIds: ['selected-cg'],
          syncFromPeer: async () => ({
            kind: 'selected-shared-memory',
            requestedScope: {
              kind: 'selected-public',
              targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' }],
            },
            shared: emptyDetailedSync(),
            scopeComplete: false,
            targetDiagnostics: {
              selectedPublic: { completed: 0, total: 1 },
              ordinaryPrivate: { completed: 0, total: 0 },
            },
          }),
        }),
      },
      onSyncAccounting: (_peerId, outcome) => {
        if (outcome) onSyncAccounting?.(outcome);
      },
      logInfo: noopLog,
    });

    await agent.attemptSelectedSwmRetryWithReconcilerAccounting(PEER_A, {
      connected: true,
      hasSyncProtocol: true,
    });

    expect(agent.lastSuccessfulSyncAt.has(PEER_A)).toBe(false);
    expect(agent.lastSyncProgressAt.has(PEER_A)).toBe(false);
    expect(agent.syncReconcilerBackoff.get(PEER_A)).toMatchObject({
      failures: 1,
    });
    expect(agent.syncReconcilerBackoff.get(PEER_A).nextRetryAt)
      .toBeGreaterThan(Date.now());
  });

  it('records selected SWM progress and preserves a bounded retry backoff', async () => {
    const agent = await createUnstartedAgent('SelectedSwmIncompleteProgress');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.config.syncContextGraphs = ['selected-cg'];
    agent.config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{ completeSwmProviders: [PEER_A] }],
    };
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    agent.resolveRfc64CompleteSwmProviderPeerIdsV1 = () => [PEER_A];
    agent.planSharedMemorySyncContextGraphs = async () => ({
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' }],
    });
    agent.syncFromPeerDetailed = async () => emptyDetailedSync({ complete: true });
    agent.refreshMetaSyncedFlags = async () => undefined;
    agent.discoverContextGraphsFromStore = async () => 0;
    agent.syncSelectedSharedMemoryFromPeerDetailed = async (
      _peerId: string,
      _contextGraphIds: readonly string[],
      options: { requestedScope: any },
    ) => ({
      kind: 'selected-shared-memory',
      requestedScope: options.requestedScope,
      shared: emptyDetailedSync({
        insertedTriples: 4,
        insertedDataTriples: 4,
      }),
      scopeComplete: false,
      targetDiagnostics: {
        selectedPublic: { completed: 0, total: 1 },
        ordinaryPrivate: { completed: 0, total: 0 },
      },
    });
    agent.selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    agent.selectedSwmBootstrapContextGraphIdsForPeer = () => ['selected-cg'];
    agent.syncReconcilerBackoff.set(PEER_A, {
      failures: 1,
      nextRetryAt: Date.now() + 60_000,
    });

    await agent.attemptSelectedSwmRetryWithReconcilerAccounting(PEER_A, {
      connected: true,
      hasSyncProtocol: true,
    });

    expect(agent.lastSyncProgressAt.has(PEER_A)).toBe(true);
    expect(agent.lastSuccessfulSyncAt.has(PEER_A)).toBe(false);
    expect(agent.syncReconcilerBackoff.get(PEER_A)?.failures).toBe(1);

    const calls: string[] = [];
    const runSelected = async (peerId: string) => {
      calls.push(peerId);
    };
    installSyncOnConnectPeerJobStub(agent, { runSelected });
    const handleSyncError = () => undefined;
    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(false);
    (agent as any).syncReconcilerBackoff.get(PEER_A).nextRetryAt = Date.now() - 1;
    expect((agent as any).queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(true);
    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(false);
    await flushTimers();
    expect(calls).toEqual([PEER_A]);
  });

  it('does not let one peer backoff suppress connection-open sync for another peer', async () => {
    const agent = await createUnstartedAgent('SyncReconnectBackoffPeerScoped');
    const calls: string[] = [];
    agent.syncReconcilerBackoff.set(PEER_A, {
      failures: 1,
      nextRetryAt: Date.now() + CATCHUP_ON_CONNECT_COOLDOWN_MS,
      protocolsKey: null,
      connectionKey: null,
    });
    const runOrdinary = async (peerId: string) => {
      calls.push(peerId);
    };
    installSyncOnConnectPeerJobStub(agent, { runOrdinary });

    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(false);
    expect(agent.queueSyncFromPeerOnConnect(PEER_B, () => undefined, 0)).toBe(true);

    await flushTimers();
    expect(calls).toEqual([PEER_B]);
  });

  it('allows connection-open sync after peer backoff cooldown expires', async () => {
    const agent = await createUnstartedAgent('SyncReconnectBackoffExpiry');
    const calls: string[] = [];
    agent.syncReconcilerBackoff.set(PEER_A, {
      failures: 1,
      nextRetryAt: Date.now() - 1,
      protocolsKey: null,
      connectionKey: null,
    });
    const runOrdinary = async (peerId: string) => {
      calls.push(peerId);
    };
    installSyncOnConnectPeerJobStub(agent, { runOrdinary });

    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(true);

    await flushTimers();
    expect(calls).toEqual([PEER_A]);
  });

  it('makes sync-on-connect requester paths no-op when the emergency switch is disabled', async () => {
    const agent = await createUnstartedAgent('SyncOnConnectDisabled');
    agent.config.syncOnConnectEnabled = false;
    agent.started = true;
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
    agent.syncFromPeerDetailed = recorder(async () => ({
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

  it('continues post-durable sync-on-connect fanout past backoff-worthy per-CG durable pressure', async () => {
    const refreshMetaSyncedFlags = recorder(async () => undefined);
    const discoverContextGraphsFromStore = recorder(async () => 0);
    const syncSharedMemoryFromPeer = recorder(async () => 0);
    const syncedPeers: Array<{
      peerId: string;
      fresh: boolean;
      progress?: boolean;
      reconcilerDisposition: 'clear' | 'retry' | 'defer';
    }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => ['cg-a'], syncSharedMemoryFromPeer),
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
      logInfo: noopLog,
      onSyncAccounting: (peerId, syncOutcome) => {
        syncedPeers.push({
          peerId,
          fresh: syncOutcome?.fresh ?? false,
          progress: syncOutcome?.progress,
          reconcilerDisposition: syncOutcome.reconcilerDisposition,
        });
      },
    });

    // The peer answered (failedPeers: 0), so one CG's backoff-worthy round may
    // not starve CG discovery or shared-memory sync; only peer accounting
    // remembers the pressure (fresh: false).
    expect(outcome).toBe('synced');
    expect(refreshMetaSyncedFlags.calls).toHaveLength(1);
    expect(discoverContextGraphsFromStore.calls).toEqual([[]]);
    expect(syncSharedMemoryFromPeer.calls).toEqual([[PEER_A, ['cg-a']]]);
    expect(syncedPeers).toEqual([{
      peerId: PEER_A,
      fresh: false,
      progress: true,
      reconcilerDisposition: 'retry',
    }]);
  });

  it('stops post-durable sync-on-connect fanout when the peer never answered and nothing progressed', async () => {
    const refreshMetaSyncedFlags = recorder(async () => undefined);
    const discoverContextGraphsFromStore = recorder(async () => 0);
    const syncSharedMemoryFromPeer = recorder(async () => 0);
    const syncedPeers: Array<{ peerId: string; fresh: boolean; progress?: boolean }> = [];

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => ['cg-a'], syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['cg-a'],
      syncFromPeer: async () => emptyDetailedSync({
        failedPeers: 1,
        backoffWorthyFailures: 1,
      }),
      refreshMetaSyncedFlags,
      discoverContextGraphsFromStore,
      logInfo: noopLog,
      onSyncAccounting: (peerId, syncOutcome) => {
        syncedPeers.push({ peerId, fresh: syncOutcome?.fresh ?? false, progress: syncOutcome?.progress });
      },
    });

    // A dead/unreachable peer must not be re-dialed by every later lane.
    expect(outcome).toBe('synced');
    expect(refreshMetaSyncedFlags.calls).toEqual([]);
    expect(discoverContextGraphsFromStore.calls).toEqual([]);
    expect(syncSharedMemoryFromPeer.calls).toEqual([]);
    expect(syncedPeers).toEqual([{
      peerId: PEER_A,
      fresh: false,
      progress: false,
    }]);
  });

  it('continues sync-on-connect when a sibling CG proves the peer answered', async () => {
    const refreshMetaSyncedFlags = recorder(async () => undefined);
    const discoverContextGraphsFromStore = recorder(async () => 0);
    const syncSharedMemoryFromPeer = recorder(async () => 0);

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => ['unreachable-cg', 'denied-cg'], syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['unreachable-cg', 'denied-cg'],
      syncFromPeer: async () => emptyDetailedSync({
        failedPeers: 1,
        deniedPhases: 1,
        backoffWorthyFailures: 1,
      }),
      refreshMetaSyncedFlags,
      discoverContextGraphsFromStore,
      logInfo: noopLog,
    });

    // `failedPeers` came from one unanswered CG, but the denial proves this
    // peer answered another round. Discovery and SWM must still get a turn.
    expect(outcome).toBe('synced');
    expect(refreshMetaSyncedFlags.calls).toHaveLength(1);
    expect(discoverContextGraphsFromStore.calls).toEqual([[]]);
    expect(syncSharedMemoryFromPeer.calls).toEqual([
      [PEER_A, ['unreachable-cg', 'denied-cg']],
    ]);
  });

  it('continues newly discovered CG fanout past per-CG durable pressure with progress', async () => {
    let contextGraphs = ['cg-a'];
    const refreshMetaSyncedFlags = recorder(async () => undefined);
    const discoverContextGraphsFromStore = recorder(async () => {
      contextGraphs = ['cg-a', 'cg-b'];
      return 1;
    });
    const syncSharedMemoryFromPeer = recorder(async () => 0);
    const syncedPeers: Array<{
      peerId: string;
      fresh: boolean;
      progress?: boolean;
      reconcilerDisposition: 'clear' | 'retry' | 'defer';
    }> = [];
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
      ordinarySharedMemoryLane: ordinaryLane(() => contextGraphs, syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => contextGraphs,
      syncFromPeer,
      refreshMetaSyncedFlags,
      discoverContextGraphsFromStore,
      logInfo: noopLog,
      onSyncAccounting: (peerId, syncOutcome) => {
        syncedPeers.push({
          peerId,
          fresh: syncOutcome?.fresh ?? false,
          progress: syncOutcome?.progress,
          reconcilerDisposition: syncOutcome.reconcilerDisposition,
        });
      },
    });

    expect(outcome).toBe('synced');
    expect(syncFromPeer.calls).toEqual([[PEER_A], [PEER_A, ['cg-b']]]);
    expect(refreshMetaSyncedFlags.calls).toHaveLength(2);
    expect(discoverContextGraphsFromStore.calls).toEqual([[]]);
    expect(syncSharedMemoryFromPeer.calls).toEqual([[PEER_A, ['cg-a', 'cg-b']]]);
    expect(syncedPeers).toEqual([{
      peerId: PEER_A,
      fresh: false,
      progress: true,
      reconcilerDisposition: 'retry',
    }]);
  });

  it('skips SWM sync-on-connect fanout when no CG is locally eligible', async () => {
    const syncSharedMemoryFromPeer = recorder(async () => 0);

    const outcome = await runSyncOnConnect({
      ordinarySharedMemoryLane: ordinaryLane(() => [], syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
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
      ordinarySharedMemoryLane: ordinaryLane((peerId) => {
        selectedForPeer = peerId;
        return ['eligible-cg'];
      }, syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
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
      ordinarySharedMemoryLane: ordinaryLane(() => ['eligible-cg'], syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
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
    const agent = await createUnstartedAgent('SwmPeerScopedRecovery');
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
