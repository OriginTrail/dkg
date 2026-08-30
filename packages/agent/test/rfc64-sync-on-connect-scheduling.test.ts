import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, type DKGAgentConfig } from '../src/index.js';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS } from '../src/dkg-agent-constants.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

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

describe('RFC-64 sync-on-connect scheduling', () => {
  it('accepts the original raw recovery-plan queue contract', async () => {
    const agent = await createUnstartedAgent('Rfc64RawPlanQueueCompatibility');
    allowAllNetworkAdmission(agent);
    const rawPlan = {
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      ...rawPlan,
    };
    const authorize = vi.fn(() => authorized);
    (agent as any).rfc64SwmRecoveryCoordinatorV1 = { authorize };
    const selectedRun = vi.spyOn(agent as any, 'runSelectedSwmRetryFromPeerOnConnect')
      .mockResolvedValue(undefined);
    const handleSyncError = vi.fn();

    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      rawPlan,
      handleSyncError,
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(selectedRun).toHaveBeenCalledWith(
      PEER_A,
      handleSyncError,
      authorized,
    ));
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith(rawPlan);
  });

  it('does not reauthorize a catalog-authorized recovery plan', async () => {
    const agent = await createUnstartedAgent('Rfc64AuthorizedPlanQueue');
    allowAllNetworkAdmission(agent);
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    const authorize = vi.fn(() => {
      throw new Error('catalog-authorized plan must not be authorized twice');
    });
    (agent as any).rfc64SwmRecoveryCoordinatorV1 = { authorize };
    const selectedRun = vi.spyOn(agent as any, 'runSelectedSwmRetryFromPeerOnConnect')
      .mockResolvedValue(undefined);
    const handleSyncError = vi.fn();

    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(selectedRun).toHaveBeenCalledWith(
      PEER_A,
      handleSyncError,
      authorized,
    ));
    expect(authorize).not.toHaveBeenCalled();
  });

  it('normalizes the original after-selected literal at runtime', async () => {
    const agent = await createUnstartedAgent('Rfc64OldTransitionCompatibility');
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
      throw new Error('selected SWM must not be re-admitted by the compatibility replay');
    });
    (agent as any).syncSharedMemoryFromPeerDetailed = ordinarySharedSync;
    (agent as any).syncSelectedSharedMemoryFromPeerDetailed = duplicateSelectedSync;
    (agent as any).selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    const retainedBackoff = {
      failures: 1,
      nextRetryAt: Date.now() + 60_000,
    };
    (agent as any).syncReconcilerBackoff.set(PEER_A, retainedBackoff);
    const handleSyncError = vi.fn();

    await agent.runSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      'ordinary-after-selected',
    );

    expect(ordinarySharedSync).toHaveBeenCalledWith(
      PEER_A,
      ['ordinary-private-cg'],
      expect.any(Object),
    );
    expect(duplicateSelectedSync).not.toHaveBeenCalled();
    expect((agent as any).selectedSwmBootstrapAdmission.isRetryRequired(PEER_A)).toBe(true);
    expect((agent as any).syncReconcilerBackoff.get(PEER_A)).toBe(retainedBackoff);
    expect(handleSyncError).not.toHaveBeenCalled();
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
    const ordinaryRun = vi.spyOn(agent as any, 'runSyncFromPeerOnConnect')
      .mockImplementation(async () => { ordering.push('ordinary'); });
    const selectedRun = vi.spyOn(agent as any, 'runSelectedSwmRetryFromPeerOnConnect');
    const errors: unknown[] = [];
    const handleSyncError = (_peerId: string, error: unknown) => { errors.push(error); };

    // The connection event schedules the canonical owner first. Bootstrap then
    // upgrades that pending run instead of creating a second timer/ledger.
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);
    expect((agent as any).catchupOnConnectAt.size).toBe(1);
    expect((agent as any).syncOnConnectPeerScheduler.size).toBe(1);

    await vi.waitFor(() => expect(ordinaryRun).toHaveBeenCalledOnce());

    expect(selectedRun).toHaveBeenCalledOnce();
    expect(ordinaryRun).toHaveBeenCalledWith(
      PEER_A,
      handleSyncError,
      'after-selected',
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
    ordinaryRun.mockClear();

    // If catalog bootstrap finishes while the generic owner is already
    // running, the same owner drains the late exact plan after ordinary sync.
    let releaseOrdinary!: () => void;
    const ordinaryBlocked = new Promise<void>((resolve) => { releaseOrdinary = resolve; });
    ordinaryRun.mockImplementationOnce(async () => {
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
    await vi.waitFor(() => expect(ordinaryRun).toHaveBeenCalledOnce());
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);
    releaseOrdinary();
    await vi.waitFor(() => expect(selectedSync).toHaveBeenCalledTimes(2));
    expect(ordinaryRun).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect((agent as any).syncOnConnectPeerScheduler.size).toBe(0));

    // A periodic exact plan inside its own cooldown must not use the ordinary
    // owner's one-time post-catalog bypass again.
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(false);
    await flushTimers();
    expect(selectedSync).toHaveBeenCalledTimes(2);
    expect(ordinaryRun).toHaveBeenCalledOnce();

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
    await vi.waitFor(() => expect(ordinaryRun).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect((agent as any).syncOnConnectPeerScheduler.size).toBe(0));
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(selectedSync).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect((agent as any).syncOnConnectPeerScheduler.size).toBe(0));
    expect((agent as any).queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
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
      authorized,
      handleSyncError,
      0,
    )).toBe(true);

    await vi.waitFor(() => expect((agent as any).syncOnConnectPeerScheduler.size).toBe(0));
    expect(ordering).toEqual(['exact', 'ordinary']);
    expect(ordinaryRun).toHaveBeenCalledWith(
      PEER_A,
      handleSyncError,
      'after-selected',
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
      authorized,
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
      authorized,
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
      'after-selected',
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

  it('freezes one unrestricted SWM plan while separating pinned and ordinary public graphs', async () => {
    const agent = await createUnstartedAgent('Rfc64FrozenSelectedSwmPlan');
    allowAllNetworkAdmission(agent);
    (agent as any).started = true;
    (agent as any).config.nodeRole = 'edge';
    (agent as any).config.syncContextGraphs = ['selected-a', 'selected-b'];
    (agent as any).config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: {
          payload: { contextGraphId: 'selected-a', accessPolicy: 0 },
        },
        completeSwmProviders: [PEER_A],
      }],
    };
    (agent as any).selectedSwmBootstrapContextGraphIdsForPeer = () => ['selected-a'];
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    const planner = vi.fn()
      .mockResolvedValueOnce({
        targets: [
          { contextGraphId: 'selected-a', lane: 'selected-public' },
          { contextGraphId: 'selected-b', lane: 'selected-public' },
        ],
      })
      .mockResolvedValue({
        targets: [{ contextGraphId: 'selected-b', lane: 'selected-public' }],
      });
    (agent as any).planSharedMemorySyncContextGraphs = planner;
    (agent as any).rfc64SwmRecoveryCoordinatorV1 = {
      admitSelectedPublic: vi.fn(() => true),
    };
    const selectedSync = vi.fn(async (
      _peerId: string,
      _contextGraphIds: readonly string[],
      options: { requestedScope: any },
    ) => ({
      kind: 'selected-shared-memory' as const,
      requestedScope: options.requestedScope,
      shared: emptyDetailedSync({ completedPhases: 1 }),
      scopeComplete: true,
      targetDiagnostics: {
        selectedPublic: { completed: 1, total: 1 },
        ordinaryPrivate: { completed: 0, total: 0 },
      },
    }));
    (agent as any).syncSelectedSharedMemoryFromPeerDetailed = selectedSync;
    const ordinarySharedSync = vi.fn(
      async () => emptyDetailedSync({ completedPhases: 1 }),
    );
    (agent as any).syncSharedMemoryFromPeerDetailed = ordinarySharedSync;
    (agent as any).syncFromPeerDetailed = vi.fn(
      async () => emptyDetailedSync({ completedPhases: 1 }),
    );
    (agent as any).refreshMetaSyncedFlags = async () => undefined;
    (agent as any).discoverContextGraphsFromStore = async () => 0;

    expect(await (agent as any).trySyncFromPeer(PEER_A, undefined, 'reconcile'))
      .toBe('synced');

    expect(planner).toHaveBeenCalledOnce();
    expect(selectedSync).toHaveBeenCalledWith(
      PEER_A,
      ['selected-a'],
      expect.objectContaining({
        requestedScope: {
          kind: 'selected-public',
          targets: [{ contextGraphId: 'selected-a', lane: 'selected-public' }],
        },
      }),
    );
    expect(ordinarySharedSync).toHaveBeenCalledWith(
      PEER_A,
      ['selected-b'],
      expect.objectContaining({
        sharedMemorySyncPlan: {
          targets: [
            { contextGraphId: 'selected-b', lane: 'selected-public' },
          ],
        },
      }),
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

});
