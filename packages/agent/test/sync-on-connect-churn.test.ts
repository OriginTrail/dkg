import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, type DKGAgentConfig } from '../src/index.js';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS, SYNC_RECONNECT_FLAP_GRACE_MS } from '../src/dkg-agent-constants.js';
import {
  runSelectedSharedMemoryRetry,
  runSyncOnConnect,
} from '../src/sync/on-connect/sync-on-connect.js';
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

async function createUnstartedAgent(
  name: string,
  overrides: Pick<
    DKGAgentConfig,
    | 'syncStalenessThresholdMs'
    | 'syncBackoffBaseMs'
    | 'syncBackoffMaxMs'
    | 'syncBackoffJitter'
  > = {},
): Promise<DKGAgent> {
  return DKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(),
    ...overrides,
  });
}

function allowAllNetworkAdmission(agent: DKGAgent): void {
  const coordinator = (agent as any).networkAdmissionCoordinator;
  coordinator.isAcceptedPeer = () => true;
  coordinator.isRejectedPeer = () => false;
  coordinator.ensureAdmitted = async () => true;
}

const noopLog = (_ctx: OperationContext, _message: string) => {};

function emptyDetailedSync(overrides: Record<string, number | boolean> = {}) {
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
      getSharedMemorySyncContextGraphs: () => [],
      syncFromPeer,
      refreshMetaSyncedFlags,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => 0,
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
      getSharedMemorySyncContextGraphs: () => [],
      syncFromPeer,
      refreshMetaSyncedFlags,
      discoverContextGraphsFromStore,
      syncSharedMemoryFromPeer: async () => 0,
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
    (agent as any).started = true;
    (agent as any).config.nodeRole = nodeRole;
    (agent as any).config.syncContextGraphs = ['selected-cg'];
    (agent as any).config.syncSharedMemoryOnConnect = false;
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    const syncFromPeerDetailed = recorder(async () => emptyDetailedSync({ completedPhases: 1 }));
    (agent as any).syncFromPeerDetailed = syncFromPeerDetailed;
    (agent as any).refreshMetaSyncedFlags = async () => undefined;
    (agent as any).discoverContextGraphsFromStore = async () => 0;
    (agent as any).planSharedMemorySyncContextGraphs = async () => ({
      targets: [],
    });

    expect(await (agent as any).trySyncFromPeer(PEER_A)).toBe('synced');
    const requestedScope = syncFromPeerDetailed.calls
      .flatMap((call) => call[1] as string[])
      .sort();
    expect(requestedScope).toEqual([...expectedScope].sort());
  });

  it('keeps explicit Edge catch-up available for system Context Graphs', async () => {
    const agent = await createUnstartedAgent('ExplicitSystemGraphCatchup');
    (agent as any).config.nodeRole = 'edge';
    const syncFromPeerDetailed = recorder(async () => emptyDetailedSync());
    (agent as any).syncFromPeerDetailed = syncFromPeerDetailed;

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

  it('runs an exact mixed RFC-64 upgrade before preserving its queued ordinary sync', async () => {
    const agent = await createUnstartedAgent('Rfc64MixedPlanSingleQueueOwner');
    allowAllNetworkAdmission(agent);
    (agent as any).started = true;
    (agent as any).getSyncReconcilerProbe = async () => ({
      connected: true,
      hasSyncProtocol: true,
    });
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [
        { contextGraphId: 'private-cg', lane: 'ordinary-private' as const },
        { contextGraphId: 'public-cg', lane: 'selected-public' as const },
      ],
    };
    (agent as any).rfc64SwmRecoveryCoordinatorV1 = {
      admitSelectedPublic: vi.fn(() => true),
      authorize: vi.fn(() => authorized),
      revalidate: vi.fn(() => authorized),
    };
    const ordering: string[] = [];
    const selectedSync = vi.fn(async (
      _peerId: string,
      _contextGraphIds: readonly string[],
      options: { requestedScope: { kind: 'rfc64-recovery-plan'; plan: typeof authorized } },
    ) => {
      ordering.push('exact');
      return {
        kind: 'selected-shared-memory' as const,
        requestedScope: options.requestedScope,
        shared: emptyDetailedSync({ completedPhases: 2 }),
        scopeComplete: true,
        targetDiagnostics: {
          selectedPublic: { completed: 1, total: 1 },
          ordinaryPrivate: { completed: 1, total: 1 },
        },
      };
    });
    (agent as any).syncSelectedSharedMemoryFromPeerDetailed = selectedSync;
    const genericRun = vi.spyOn(agent as any, 'runSyncFromPeerOnConnect')
      .mockImplementation(async () => { ordering.push('ordinary'); });
    const selectedRun = vi.spyOn(agent as any, 'runSelectedSwmRetryFromPeerOnConnect');
    const errors: unknown[] = [];
    const handleSyncError = (_peerId: string, error: unknown) => { errors.push(error); };

    // The connection event schedules the canonical owner first. Bootstrap then
    // upgrades that pending run instead of creating a second timer/ledger.
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      {
        providerPeerId: PEER_A,
        targets: authorized.targets,
      },
      handleSyncError,
      0,
    )).toBe(true);
    expect((agent as any).catchupOnConnectAt.size).toBe(1);
    expect((agent as any).syncOnConnectPeerScheduler.size).toBe(1);

    await vi.waitFor(() => expect(genericRun).toHaveBeenCalledOnce());

    expect(selectedRun).toHaveBeenCalledOnce();
    expect(genericRun).toHaveBeenCalledWith(
      PEER_A,
      handleSyncError,
      'ordinary-after-selected',
    );
    expect(ordering).toEqual(['exact', 'ordinary']);
    expect(selectedSync).toHaveBeenCalledWith(
      PEER_A,
      ['private-cg', 'public-cg'],
      expect.objectContaining({
        selectedSwmPriority: true,
        requestedScope: {
          kind: 'rfc64-recovery-plan',
          plan: authorized,
        },
      }),
    );
    expect(selectedSync.mock.calls[0]![2].requestedScope.plan).toBe(authorized);
    await vi.waitFor(() => expect((agent as any).syncOnConnectPeerScheduler.size).toBe(0));
    expect((agent as any).syncReconcilerBackoff.has(PEER_A)).toBe(false);
    expect(errors).toEqual([]);

    // If catalog bootstrap finishes while the generic owner is already
    // running, the same owner drains the late exact plan after ordinary sync.
    let releaseOrdinary!: () => void;
    const ordinaryBlocked = new Promise<void>((resolve) => { releaseOrdinary = resolve; });
    genericRun.mockImplementationOnce(async () => {
      ordering.push('ordinary-in-flight');
      await ordinaryBlocked;
    });
    (agent as any).catchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    (agent as any).rfc64ExactCatchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    await vi.waitFor(() => expect(genericRun).toHaveBeenCalledTimes(2));
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      { providerPeerId: PEER_A, targets: authorized.targets },
      handleSyncError,
      0,
    )).toBe(true);
    releaseOrdinary();
    await vi.waitFor(() => expect(selectedSync).toHaveBeenCalledTimes(2));
    expect(genericRun).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect((agent as any).syncOnConnectPeerScheduler.size).toBe(0));

    // A periodic exact plan inside its own cooldown must not use the ordinary
    // owner's one-time post-catalog bypass again.
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      {
        providerPeerId: PEER_A,
        targets: authorized.targets,
      },
      handleSyncError,
      0,
    )).toBe(false);
    await flushTimers();
    expect(selectedSync).toHaveBeenCalledTimes(2);
    expect(genericRun).toHaveBeenCalledTimes(2);

    // After the real cooldown expires, a generic owner may finish before the
    // catalog plan arrives. That first exact plan still gets one bypass; the
    // next periodic plan in the same window does not.
    (agent as any).catchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    (agent as any).rfc64ExactCatchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    await vi.waitFor(() => expect(genericRun).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect((agent as any).syncOnConnectPeerScheduler.size).toBe(0));
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      { providerPeerId: PEER_A, targets: authorized.targets },
      handleSyncError,
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(selectedSync).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect((agent as any).syncOnConnectPeerScheduler.size).toBe(0));
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      { providerPeerId: PEER_A, targets: authorized.targets },
      handleSyncError,
      0,
    )).toBe(false);
  });

  it('replays the real ordinary lane past backoff without duplicating selected SWM', async () => {
    const agent = await createUnstartedAgent('Rfc64RealOrdinaryReplay');
    allowAllNetworkAdmission(agent);
    (agent as any).started = true;
    (agent as any).config.nodeRole = 'edge';
    (agent as any).config.syncContextGraphs = ['selected-cg'];
    (agent as any).config.syncSharedMemoryOnConnect = true;
    (agent as any).config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { contextGraphId: 'selected-cg', accessPolicy: 0 } },
        completeSwmProviders: [PEER_A],
      }],
    };
    (agent as any).getSyncReconcilerProbe = async () => ({
      connected: true,
      hasSyncProtocol: true,
    });
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    (agent as any).planSharedMemorySyncContextGraphs = async () => ({
      targets: [
        { contextGraphId: 'selected-cg', lane: 'selected-public' },
        { contextGraphId: 'ordinary-private-cg', lane: 'ordinary-private' },
      ],
    });
    (agent as any).refreshMetaSyncedFlags = async () => undefined;
    (agent as any).discoverContextGraphsFromStore = async () => 0;
    const ordinarySharedSync = vi.fn(async () => emptyDetailedSync({ completedPhases: 1 }));
    const duplicateSelectedSync = vi.fn(async () => {
      throw new Error('selected SWM must not run again in the ordinary replay');
    });
    (agent as any).syncSharedMemoryFromPeerDetailed = ordinarySharedSync;
    (agent as any).syncSelectedSharedMemoryFromPeerDetailed = duplicateSelectedSync;
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [
        { contextGraphId: 'ordinary-private-cg', lane: 'ordinary-private' as const },
        { contextGraphId: 'selected-cg', lane: 'selected-public' as const },
      ],
    };
    (agent as any).rfc64SwmRecoveryCoordinatorV1 = {
      authorize: vi.fn(() => authorized),
    };
    const ordering: string[] = [];
    vi.spyOn(agent as any, 'runSelectedSwmRetryFromPeerOnConnect')
      .mockImplementation(async () => {
        ordering.push('exact');
        (agent as any).syncReconcilerBackoff.set(PEER_A, {
          failures: 1,
          nextRetryAt: Date.now() + 60_000,
        });
      });
    const ordinaryRun = vi.spyOn(agent as any, 'runSyncFromPeerOnConnect');
    ordinarySharedSync.mockImplementation(async () => {
      ordering.push('ordinary');
      return emptyDetailedSync({ completedPhases: 1 });
    });
    const errors: unknown[] = [];
    const handleSyncError = (_peerId: string, error: unknown) => { errors.push(error); };

    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      { providerPeerId: PEER_A, targets: authorized.targets },
      handleSyncError,
      0,
    )).toBe(true);

    await vi.waitFor(() => expect((agent as any).syncOnConnectPeerScheduler.size).toBe(0));
    expect(ordering).toEqual(['exact', 'ordinary']);
    expect(ordinaryRun).toHaveBeenCalledWith(
      PEER_A,
      handleSyncError,
      'ordinary-after-selected',
    );
    expect(ordinarySharedSync).toHaveBeenCalledOnce();
    expect(ordinarySharedSync).toHaveBeenCalledWith(
      PEER_A,
      ['ordinary-private-cg'],
      expect.any(Object),
    );
    expect(duplicateSelectedSync).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('preserves incomplete selected retry ownership after successful ordinary replay', async () => {
    const agent = await createUnstartedAgent('Rfc64IncompleteSelectedThenOrdinary');
    allowAllNetworkAdmission(agent);
    (agent as any).started = true;
    (agent as any).config.nodeRole = 'edge';
    (agent as any).config.syncContextGraphs = [];
    (agent as any).config.syncSharedMemoryOnConnect = false;
    (agent.node as any).node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    (agent as any).getSyncReconcilerProbe = async () => ({
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    (agent as any).planSharedMemorySyncContextGraphs = async () => ({ targets: [] });
    (agent as any).refreshMetaSyncedFlags = async () => undefined;
    (agent as any).discoverContextGraphsFromStore = async () => 0;
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    (agent as any).rfc64SwmRecoveryCoordinatorV1 = {
      authorize: vi.fn(() => authorized),
      revalidate: vi.fn(() => authorized),
    };
    (agent as any).syncSelectedSharedMemoryFromPeerDetailed = async (
      _peerId: string,
      _contextGraphIds: readonly string[],
      options: { requestedScope: unknown },
    ) => ({
      kind: 'selected-shared-memory' as const,
      requestedScope: options.requestedScope,
      shared: emptyDetailedSync(),
      scopeComplete: false,
      targetDiagnostics: {
        selectedPublic: { completed: 0, total: 1 },
        ordinaryPrivate: { completed: 0, total: 0 },
      },
    });
    (agent as any).selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    const errors: unknown[] = [];
    const handleSyncError = (_peerId: string, error: unknown) => { errors.push(error); };

    expect((agent as any).queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
    )).toBe(true);
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      { providerPeerId: PEER_A, targets: authorized.targets },
      handleSyncError,
      0,
    )).toBe(true);

    await vi.waitFor(() => expect((agent as any).syncOnConnectPeerScheduler.size).toBe(0));
    expect((agent as any).selectedSwmBootstrapAdmission.isRetryRequired(PEER_A))
      .toBe(true);
    expect((agent as any).syncReconcilerBackoff.get(PEER_A)).toMatchObject({
      failures: 1,
    });
    expect((agent as any).lastSuccessfulSyncAt.has(PEER_A)).toBe(false);
    expect(errors).toEqual([]);

    // Once the bounded backoff/cooldown expires, the retained selected owner
    // remains directly schedulable instead of being hidden by peer freshness.
    (agent as any).syncReconcilerBackoff.get(PEER_A).nextRetryAt = Date.now() - 1;
    (agent as any).catchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    const selectedRetry = vi.spyOn(agent as any, 'runSelectedSwmRetryFromPeerOnConnect')
      .mockResolvedValue(undefined);
    expect((agent as any).queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(true);
    await vi.waitFor(() => expect(selectedRetry).toHaveBeenCalledOnce());
  });

  it('adds owed ordinary work to the same job while exact recovery is running', async () => {
    const agent = await createUnstartedAgent('Rfc64OrdinaryUpgradeDuringExact');
    allowAllNetworkAdmission(agent);
    (agent as any).started = true;
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    (agent as any).rfc64SwmRecoveryCoordinatorV1 = {
      authorize: vi.fn(() => authorized),
    };
    let releaseExact!: () => void;
    const exactBlocked = new Promise<void>((resolve) => { releaseExact = resolve; });
    const ordering: string[] = [];
    vi.spyOn(agent as any, 'runSelectedSwmRetryFromPeerOnConnect')
      .mockImplementation(async () => {
        ordering.push('exact-in-flight');
        await exactBlocked;
      });
    const ordinaryRun = vi.spyOn(agent as any, 'runSyncFromPeerOnConnect')
      .mockImplementation(async () => { ordering.push('ordinary'); });
    const handleSyncError = () => undefined;

    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      { providerPeerId: PEER_A, targets: authorized.targets },
      handleSyncError,
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(ordering).toEqual(['exact-in-flight']));
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    releaseExact();

    await vi.waitFor(() => expect((agent as any).syncOnConnectPeerScheduler.size).toBe(0));
    expect(ordinaryRun).toHaveBeenCalledWith(
      PEER_A,
      handleSyncError,
      'ordinary-after-selected',
    );
    expect(ordering).toEqual(['exact-in-flight', 'ordinary']);
  });

  it('keeps ordinary connection and reconciler sync live while catalog-gating selected SWM', async () => {
    const agent = await createUnstartedAgent('Rfc64CatalogBeforeAutomaticSwm');
    allowAllNetworkAdmission(agent);
    (agent as any).started = true;
    (agent as any).config.nodeRole = 'edge';
    (agent as any).config.syncContextGraphs = ['selected-cg'];
    (agent as any).config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { contextGraphId: 'selected-cg', accessPolicy: 0 } },
        completeSwmProviders: [PEER_A],
      }],
    };
    (agent as any).selectedSwmBootstrapContextGraphIdsForPeer = () => ['selected-cg'];
    (agent as any).rfc64SwmRecoveryCoordinatorV1 = {
      admitSelectedPublic: vi.fn(() => false),
    };
    const queuedRun = vi.spyOn(agent as any, 'runSyncFromPeerOnConnect')
      .mockResolvedValue(undefined);

    // A generic connection owner remains schedulable while catalog bootstrap
    // owns only the selected RFC-64 lane.
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0))
      .toBe(true);
    await flushTimers();
    expect(queuedRun).toHaveBeenCalledOnce();
    queuedRun.mockRestore();

    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    (agent as any).planSharedMemorySyncContextGraphs = async () => ({
      targets: [
        { contextGraphId: 'selected-cg', lane: 'selected-public' },
        { contextGraphId: 'ordinary-cg', lane: 'ordinary-private' },
      ],
    });
    const selectedSync = vi.fn(async () => {
      throw new Error('selected SWM must remain catalog-gated');
    });
    const ordinarySharedSync = vi.fn(async () => emptyDetailedSync({ completedPhases: 1 }));
    (agent as any).syncSelectedSharedMemoryFromPeerDetailed = selectedSync;
    (agent as any).syncSharedMemoryFromPeerDetailed = ordinarySharedSync;
    (agent as any).refreshMetaSyncedFlags = async () => undefined;
    (agent as any).discoverContextGraphsFromStore = async () => 0;

    expect(await (agent as any).trySyncFromPeer(PEER_A, undefined, 'reconcile'))
      .toBe('synced');
    expect((agent as any).rfc64SwmRecoveryCoordinatorV1.admitSelectedPublic)
      .toHaveBeenCalledWith(PEER_A, ['selected-cg']);
    expect(selectedSync).not.toHaveBeenCalled();
    expect(ordinarySharedSync).toHaveBeenCalledWith(
      PEER_A,
      ['ordinary-cg'],
      expect.any(Object),
    );
  });

  it('retries incomplete selected SWM past generic freshness without creating a loop', async () => {
    const agent = await createUnstartedAgent('SelectedSwmRetryFreshnessBypass');
    const calls: string[] = [];
    (agent as any).runSelectedSwmRetryFromPeerOnConnect = async (peerId: string) => {
      calls.push(peerId);
    };
    const handleSyncError = () => undefined;
    (agent as any).lastSuccessfulSyncAt.set(PEER_A, Date.now());

    // Generic fresh-success suppression remains authoritative until the
    // selected lane explicitly records incomplete exact coverage.
    expect((agent as any).queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(false);

    (agent as any).selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    // A normal connection-open event never inherits the catalog bootstrap's
    // selected retry authority, even while the scheduling marker is present.
    expect((agent as any).queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
    )).toBe(false);
    (agent as any).syncReconcilerBackoff.set(PEER_A, {
      failures: 1,
      nextRetryAt: Date.now() + 60_000,
    });
    expect((agent as any).queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(false);
    (agent as any).syncReconcilerBackoff.delete(PEER_A);
    expect((agent as any).queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(true);
    // The ordinary one-minute queue cooldown still prevents retry storms.
    expect((agent as any).queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(false);
    await flushTimers();
    expect(calls).toEqual([PEER_A]);

    // A later exact completion clears the marker. Even after the short queue
    // cooldown expires, the still-fresh generic success prevents another run.
    const completedOwner = (agent as any).selectedSwmBootstrapAdmission.beginTransfer(
      PEER_A,
      ['selected-cg'],
    );
    (agent as any).selectedSwmBootstrapAdmission.markTransferTerminal(completedOwner);
    (agent as any).catchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    expect((agent as any).queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(false);
    await flushTimers();
    expect(calls).toEqual([PEER_A]);
  });

  it('starts RFC-64 selected SWM cold when broad sync-on-connect is disabled', async () => {
    const agent = await createUnstartedAgent('SelectedSwmRetryIndependentSwitch');
    allowAllNetworkAdmission(agent);
    (agent as any).started = true;
    (agent as any).config.syncOnConnectEnabled = false;
    (agent as any).config.syncSharedMemoryOnConnect = false;
    (agent as any).config.syncContextGraphs = ['selected-cg'];
    (agent as any).config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{ completeSwmProviders: [PEER_A] }],
    };
    (agent as any).selectedSwmBootstrapContextGraphIdsForPeer = () => ['selected-cg'];
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    (agent as any).planSharedMemorySyncContextGraphs = async () => ({
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' }],
    });
    const selectedSync = recorder(async (
      _peerId: string,
      _contextGraphIds: readonly string[],
      options: { requestedScope: any },
    ) => ({
      kind: 'selected-shared-memory' as const,
      requestedScope: options.requestedScope,
      shared: emptyDetailedSync({
        insertedTriples: 4,
        insertedDataTriples: 4,
      }),
      scopeComplete: true,
      targetDiagnostics: {
        selectedPublic: { completed: 1, total: 1 },
        ordinaryPrivate: { completed: 0, total: 0 },
      },
    }));
    const durableSync = recorder(async () => emptyDetailedSync({ completedPhases: 1 }));
    const ordinarySharedSync = recorder(async () => emptyDetailedSync({ completedPhases: 1 }));
    const discoverContextGraphsFromStore = recorder(async () => 0);
    (agent as any).syncSelectedSharedMemoryFromPeerDetailed = selectedSync;
    (agent as any).syncFromPeerDetailed = durableSync;
    (agent as any).syncSharedMemoryFromPeerDetailed = ordinarySharedSync;
    (agent as any).refreshMetaSyncedFlags = async () => undefined;
    (agent as any).discoverContextGraphsFromStore = discoverContextGraphsFromStore;
    const errors: unknown[] = [];
    const handleSyncError = (_peerId: string, error: unknown) => {
      errors.push(error);
    };
    (agent as any).lastSuccessfulSyncAt.set(PEER_A, Date.now());
    expect((agent as any).selectedSwmBootstrapAdmission.isRetryRequired(PEER_A)).toBe(false);

    expect((agent as any).queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
    )).toBe(false);
    expect((agent as any).queueSelectedSwmFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
    )).toBe(true);
    expect((agent as any).selectedSwmBootstrapAdmission.isRetryRequired(PEER_A)).toBe(true);

    await flushTimers();
    expect(errors).toEqual([]);
    expect(selectedSync.calls).toHaveLength(1);
    expect(selectedSync.calls[0][0]).toBe(PEER_A);
    expect(selectedSync.calls[0][1]).toEqual(['selected-cg']);
    expect(durableSync.calls).toEqual([]);
    expect(ordinarySharedSync.calls).toEqual([]);
    expect(discoverContextGraphsFromStore.calls).toEqual([]);
    expect((agent as any).lastSuccessfulSyncAt.has(PEER_A)).toBe(true);
  });

  it('clears selected SWM retry state when network admission rejects a peer', async () => {
    const agent = await createUnstartedAgent('SelectedSwmRetryRejectedPeerCleanup');
    allowAllNetworkAdmission(agent);
    (agent as any).started = true;
    (agent as any).config.syncOnConnectEnabled = true;
    (agent as any).selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    const runs: string[] = [];
    (agent as any).runSyncFromPeerOnConnect = async (peerId: string) => {
      runs.push(peerId);
    };
    expect((agent as any).queueSyncFromPeerOnConnect(
      PEER_A,
      () => undefined,
      50,
    )).toBe(true);
    expect((agent as any).syncOnConnectPeerScheduler.has(PEER_A)).toBe(true);

    (agent as any).clearNetworkRejectedPeerState(PEER_A);

    expect((agent as any).selectedSwmBootstrapAdmission.snapshot(PEER_A)).toBeNull();
    expect((agent as any).syncOnConnectPeerScheduler.has(PEER_A)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(runs).toEqual([]);
  });

  it('clears selected SWM retry state after stop drains transfer owners', async () => {
    const agent = await DKGAgent.create({
      name: 'SelectedSwmRetryStopCleanup',
      listenHost: '127.0.0.1',
      listenPort: 0,
      bootstrapPeers: [],
      chainAdapter: new MockChainAdapter(),
    });
    try {
      await agent.start();
      (agent as any).selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);

      await agent.stop();

      expect((agent as any).selectedSwmBootstrapAdmission.size).toBe(0);
    } finally {
      if ((agent as any).started) await agent.stop().catch(() => undefined);
    }
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

  it('labels the connect-driven admission on-connect, not unspecified', async () => {
    // The complement of the reconciler assertion below, and the source with the
    // highest production volume: every reconnect sync flows through this
    // default. Nothing pinned it, so changing the default would silently
    // relabel most sync-global pressure on the operator dashboards.
    const agent = await createUnstartedAgent('SyncOnConnectSourceLabel');
    (agent as any).started = true;
    const sources: unknown[] = [];
    (agent as any).trySyncFromPeer = async (
      _peer: string,
      _onAccounting: unknown,
      source: unknown,
    ) => {
      sources.push(source);
      return undefined;
    };

    await (agent as any).attemptSyncFromPeerWithReconcilerAccounting(PEER_A, {
      connected: true,
      hasSyncProtocol: true,
    });

    expect(sources).toEqual(['on-connect']);
  });

  it('coalesces a reconcile race with the same ordinary on-connect attempt', async () => {
    const agent = await createUnstartedAgent('SyncAttemptRaceCoalescing');
    (agent as any).started = true;
    let release!: (outcome: 'synced') => void;
    const gate = new Promise<'synced'>((resolve) => { release = resolve; });
    const trySyncFromPeer = recorder(async () => gate);
    (agent as any).trySyncFromPeer = trySyncFromPeer;
    const probe = { connected: true, hasSyncProtocol: true };

    const onConnect = (agent as any).attemptSyncFromPeerWithReconcilerAccounting(
      PEER_A,
      probe,
      'on-connect',
    );
    const reconcile = (agent as any).attemptSyncFromPeerWithReconcilerAccounting(
      PEER_A,
      probe,
      'reconcile',
    );
    await Promise.resolve();

    expect(trySyncFromPeer.calls).toHaveLength(1);
    release('synced');
    await expect(Promise.all([onConnect, reconcile])).resolves.toEqual(['synced', 'synced']);
    expect(trySyncFromPeer.calls).toHaveLength(1);
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
    expect(trySyncFromPeer.calls).toEqual([[
      PEER_A,
      expect.any(Function),
      'reconcile',
      'ordinary',
    ]]);
  });

  it('uses configured staleness and backoff values in the sync lifecycle', async () => {
    const agent = await createUnstartedAgent('ConfiguredSyncTimingConsumers', {
      syncStalenessThresholdMs: 20_000,
      syncBackoffBaseMs: 5_000,
      syncBackoffMaxMs: 30_000,
      syncBackoffJitter: 0,
    });
    (agent as any).started = true;
    (agent.node as any).node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    (agent as any).lastSuccessfulSyncAt.set(PEER_A, Date.now() - 30_000);
    const trySyncFromPeer = recorder(async () => undefined);
    (agent as any).trySyncFromPeer = trySyncFromPeer;
    const before = Date.now();

    await (agent as any).reconcileSyncFromConnectedPeers();
    await flushTimers();

    expect(trySyncFromPeer.calls).toHaveLength(1);
    const backoff = (agent as any).syncReconcilerBackoff.get(PEER_A);
    expect(backoff?.failures).toBe(1);
    expect(backoff?.nextRetryAt - before).toBeGreaterThanOrEqual(5_000);
    expect(backoff?.nextRetryAt - before).toBeLessThan(5_100);
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

    await (agent as any).runSyncFromPeerOnConnect(PEER_A, () => undefined);

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
    (agent as any).started = true;
    (agent.node as any).node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    (agent as any).selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    (agent as any).trySelectedSwmRetryFromPeer = async (
      _peerId: string,
      onSyncAccounting?: (outcome: { fresh: boolean; progress?: boolean }) => void,
    ) => runSelectedSharedMemoryRetry({
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      selectedSharedMemoryLane: {
        getContextGraphIds: () => ['selected-cg'],
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
      },
      onSyncAccounting: (_peerId, outcome) => {
        if (outcome) onSyncAccounting?.(outcome);
      },
      logInfo: noopLog,
    });

    await (agent as any).attemptSelectedSwmRetryWithReconcilerAccounting(PEER_A, {
      connected: true,
      hasSyncProtocol: true,
    });

    expect((agent as any).lastSuccessfulSyncAt.has(PEER_A)).toBe(false);
    expect((agent as any).lastSyncProgressAt.has(PEER_A)).toBe(false);
    expect((agent as any).syncReconcilerBackoff.get(PEER_A)).toMatchObject({
      failures: 1,
    });
    expect((agent as any).syncReconcilerBackoff.get(PEER_A).nextRetryAt)
      .toBeGreaterThan(Date.now());
  });

  it('records selected SWM progress and preserves a bounded retry backoff', async () => {
    const agent = await createUnstartedAgent('SelectedSwmIncompleteProgress');
    allowAllNetworkAdmission(agent);
    (agent as any).started = true;
    (agent as any).config.syncContextGraphs = ['selected-cg'];
    (agent as any).config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{ completeSwmProviders: [PEER_A] }],
    };
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    (agent as any).resolveRfc64CompleteSwmProviderPeerIdsV1 = () => [PEER_A];
    (agent as any).planSharedMemorySyncContextGraphs = async () => ({
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' }],
    });
    (agent as any).syncFromPeerDetailed = async () => emptyDetailedSync({ complete: true });
    (agent as any).refreshMetaSyncedFlags = async () => undefined;
    (agent as any).discoverContextGraphsFromStore = async () => 0;
    (agent as any).syncSelectedSharedMemoryFromPeerDetailed = async (
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
    (agent as any).selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    (agent as any).selectedSwmBootstrapContextGraphIdsForPeer = () => ['selected-cg'];
    (agent as any).syncReconcilerBackoff.set(PEER_A, {
      failures: 1,
      nextRetryAt: Date.now() + 60_000,
    });

    await (agent as any).attemptSelectedSwmRetryWithReconcilerAccounting(PEER_A, {
      connected: true,
      hasSyncProtocol: true,
    });

    expect((agent as any).lastSyncProgressAt.has(PEER_A)).toBe(true);
    expect((agent as any).lastSuccessfulSyncAt.has(PEER_A)).toBe(false);
    expect((agent as any).syncReconcilerBackoff.get(PEER_A)?.failures).toBe(1);

    const calls: string[] = [];
    (agent as any).runSelectedSwmRetryFromPeerOnConnect = async (peerId: string) => {
      calls.push(peerId);
    };
    const handleSyncError = () => undefined;
    expect((agent as any).queueSyncFromPeerOnConnect(
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
    expect((agent as any).queueSyncFromPeerOnConnect(
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
      syncSharedMemoryFromPeer,
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
      syncSharedMemoryFromPeer,
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
