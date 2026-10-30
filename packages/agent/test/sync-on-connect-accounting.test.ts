import { stubDurableSync } from './_helpers/stub-durable-sync.js';
import { describe, expect, it } from 'vitest';
import { PeerCapabilityRegistry } from '../src/p2p/peer-capability.js';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS } from '../src/dkg-agent-constants.js';
import { InMemoryPeerSyncLease, runSelectedSharedMemoryRetry, runSyncOnConnect } from '../src/sync/on-connect/sync-on-connect.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { allowAllNetworkAdmission, createUnstartedAgent, emptyDetailedSync, flushTimers, installSyncOnConnectPeerJobStub, peerSyncSessionDriver, recorder, resetPeerSyncSessionForTest } from './_helpers/sync-on-connect-test-fixture.js';
import { ordinaryLane } from './_helpers/run-sync-on-connect.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const ACTIVE_SYNC_LIFETIME = new AbortController().signal;

const noopLog = (_ctx: OperationContext, _message: string) => {};

describe('sync-on-connect accounting', () => {
  it('records backoff after a failed sync round and blocks connection-open rescheduling', async () => {
    const agent = await createUnstartedAgent('SyncReconnectBackoff');
    agent.started = true;
    resetPeerSyncSessionForTest(agent);
    agent.node.node = {
      status: 'started',
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    agent.trySyncFromPeer = async () => 'synced';

    await agent.attemptSyncFromPeerWithReconcilerAccounting(PEER_A, {
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });

    const backoff = peerSyncSessionDriver(agent).snapshot(PEER_A).backoff;
    expect(backoff?.failures).toBe(1);
    expect(backoff?.nextRetryAt).toBeGreaterThan(Date.now());

    const staleQueuedAt = Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1;
    peerSyncSessionDriver(agent).recordQueued(PEER_A, staleQueuedAt);
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(false);
    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).lastQueued).toBe(staleQueuedAt);
  });

  it('retains progress while backing off a mixed progress-and-failure round', async () => {
    const agent = await createUnstartedAgent('SyncReconnectPartialProgressBackoff', {
      syncContextGraphs: ['cg-a'],
      rfc64CatalogActivation: { enabled: false },
    });
    allowAllNetworkAdmission(agent);
    (agent as any).started = true;
    resetPeerSyncSessionForTest(agent);
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
    stubDurableSync((agent as any), async () => emptyDetailedSync({
      insertedTriples: 3,
      insertedDataTriples: 3,
      completedPhases: 1,
      checkpointAdvances: 1,
      timedOutPhases: 1,
      backoffWorthyFailures: 1,
    }));
    (agent as any).refreshMetaSyncedFlags = async () => undefined;
    (agent as any).discoverContextGraphsFromStore = async () => 0;
    (agent as any).planSharedMemorySyncContextGraphs = async () => ({ targets: [] });
    peerSyncSessionDriver(agent).recordBackoff(PEER_A, {
      failures: 2,
      nextRetryAt: Date.now() - 1,
      protocolsKey: null,
      connectionKey: null,
    });

    await (agent as any).attemptSyncFromPeerWithReconcilerAccounting(PEER_A, {
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });

    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).lastSyncProgress).toBeGreaterThan(0);
    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).lastSuccessfulSync).toBeUndefined();
    const backoff = peerSyncSessionDriver(agent).snapshot(PEER_A).backoff;
    expect(backoff?.failures).toBe(3);
    expect(backoff?.nextRetryAt).toBeGreaterThan(Date.now());

    peerSyncSessionDriver(agent).recordQueued(
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
    resetPeerSyncSessionForTest(agent);
      (agent as any).isPeerConnectedForSyncBackoff = () => true;
      peerSyncSessionDriver(agent).recordBackoff(PEER_A, {
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

      expect(peerSyncSessionDriver(agent).snapshot(PEER_A).lastSyncProgress).toBeGreaterThan(0);
      expect(peerSyncSessionDriver(agent).snapshot(PEER_A).lastSuccessfulSync !== undefined)
        .toBe(expectedFresh);
      expect(peerSyncSessionDriver(agent).snapshot(PEER_A).backoff?.failures)
        .toBe(expectedFailures);
    },
  );

  it('records reconciler backoff when selected SWM is explicitly incomplete without progress', async () => {
    const agent = await createUnstartedAgent('SelectedSwmIncompleteBackoff');
    agent.started = true;
    resetPeerSyncSessionForTest(agent);
    agent.node.node = {
      status: 'started',
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    agent.selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    agent.trySelectedSwmRetryFromPeer = async (
      _peerId: string,
      onSyncAccounting?: (outcome: { fresh: boolean; progress?: boolean }) => void,
    ) => runSelectedSharedMemoryRetry({
      signal: ACTIVE_SYNC_LIFETIME,
      remotePeer: PEER_A,
      syncingPeers: new InMemoryPeerSyncLease(),
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

    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).lastSuccessfulSync !== undefined).toBe(false);
    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).lastSyncProgress !== undefined).toBe(false);
    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).backoff).toMatchObject({
      failures: 1,
    });
    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).backoff?.nextRetryAt)
      .toBeGreaterThan(Date.now());
  });

  it('records selected SWM progress and preserves a bounded retry backoff', async () => {
    const agent = await createUnstartedAgent('SelectedSwmIncompleteProgress');
    const calls: string[] = [];
    const runSelected = async (peerId: string) => {
      calls.push(peerId);
    };
    installSyncOnConnectPeerJobStub(agent, { runSelected });
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
    stubDurableSync(agent, async () => emptyDetailedSync({ complete: true }));
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
    peerSyncSessionDriver(agent).recordBackoff(PEER_A, {
      failures: 1,
      nextRetryAt: Date.now() + 60_000,
    });

    await agent.attemptSelectedSwmRetryWithReconcilerAccounting(PEER_A, {
      connected: true,
      hasSyncProtocol: true,
    });

    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).lastSyncProgress !== undefined).toBe(true);
    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).lastSuccessfulSync !== undefined).toBe(false);
    expect(peerSyncSessionDriver(agent).snapshot(PEER_A).backoff?.failures).toBe(1);

    const handleSyncError = () => undefined;
    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(false);
    peerSyncSessionDriver(agent).expireBackoff(PEER_A);
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

  it.each([0, 3].flatMap(meta => ['clean', 'incomplete', 'failed', 'metadata-only'].map(state => ({ meta, state }))))(
    'accounts held completion with $meta META inserts ($state)', async ({ meta, state }) => {
      const accounting: Array<{ fresh: boolean; progress?: boolean }> = [];
      await runSyncOnConnect({ signal: ACTIVE_SYNC_LIFETIME, remotePeer: PEER_A,
        syncingPeers: new InMemoryPeerSyncLease(), getPeerProtocols: async () => [PROTOCOL_SYNC],
        peerCapabilities: new PeerCapabilityRegistry(), getSyncContextGraphs: () => ['held-cg'],
        syncFromPeer: async () => emptyDetailedSync({ complete: state !== 'incomplete',
          insertedTriples: meta, insertedMetaTriples: meta, insertedDataTriples: 0,
          verifiedHeldAssets: state === 'metadata-only' ? 0 : 6, metaOnlyResponses: state === 'metadata-only' ? 1 : 0,
          resumedPhases: 1, completedPhases: 2, failedPhases: state === 'failed' ? 1 : 0 }),
        refreshMetaSyncedFlags: async () => {}, discoverContextGraphsFromStore: async () => 0,
        logInfo: noopLog, onSyncAccounting: (_peer, result) => { accounting.push(result); },
      });
      if (state === 'clean' || state === 'failed') {
        expect(accounting).toHaveLength(1);
        expect(accounting[0]).toMatchObject({ fresh: state === 'clean', progress: state === 'clean' });
      } else expect(accounting).toEqual([]);
    },
  );

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
      signal: ACTIVE_SYNC_LIFETIME,
      ordinarySharedMemoryLane: ordinaryLane(() => ['cg-a'], syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new InMemoryPeerSyncLease(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      peerCapabilities: new PeerCapabilityRegistry(),
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
      signal: ACTIVE_SYNC_LIFETIME,
      ordinarySharedMemoryLane: ordinaryLane(() => ['cg-a'], syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new InMemoryPeerSyncLease(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      peerCapabilities: new PeerCapabilityRegistry(),
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
      signal: ACTIVE_SYNC_LIFETIME,
      ordinarySharedMemoryLane: ordinaryLane(() => ['unreachable-cg', 'denied-cg'], syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new InMemoryPeerSyncLease(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      peerCapabilities: new PeerCapabilityRegistry(),
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
      signal: ACTIVE_SYNC_LIFETIME,
      ordinarySharedMemoryLane: ordinaryLane(() => contextGraphs, syncSharedMemoryFromPeer),
      remotePeer: PEER_A,
      syncingPeers: new InMemoryPeerSyncLease(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      peerCapabilities: new PeerCapabilityRegistry(),
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

});
