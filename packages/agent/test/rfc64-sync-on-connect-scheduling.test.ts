import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS } from '../src/dkg-agent-constants.js';
import { SyncBackpressureBusyError } from '../src/sync/backpressure.js';
import {
  allowAllNetworkAdmission,
  createRfc64CoordinatorStub,
  createUnstartedAgent,
  emptyDetailedSync,
  flushTimers,
  installSyncOnConnectPeerJobStub,
  recorder,
} from './_helpers/sync-on-connect-test-fixture.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

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
    agent.rfc64SwmRecoveryCoordinatorV1 = createRfc64CoordinatorStub({
      authorize,
    });
    const selectedRun = vi.fn(async () => undefined);
    installSyncOnConnectPeerJobStub(agent, { runSelected: selectedRun });
    const handleSyncError = vi.fn();

    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      rawPlan,
      handleSyncError,
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(selectedRun).toHaveBeenCalledWith(
      PEER_A,
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
    agent.rfc64SwmRecoveryCoordinatorV1 = createRfc64CoordinatorStub({
      authorize,
    });
    const selectedRun = vi.fn(async () => undefined);
    installSyncOnConnectPeerJobStub(agent, { runSelected: selectedRun });
    const handleSyncError = vi.fn();

    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(selectedRun).toHaveBeenCalledWith(
      PEER_A,
      authorized,
    ));
    expect(authorize).not.toHaveBeenCalled();
  });

  it('revalidates a catalog-authorized plan immediately before execution', async () => {
    const agent = await createUnstartedAgent('Rfc64AuthorizedPlanDrainRevalidation');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.getSyncReconcilerProbe = async () => ({
      connected: true,
      hasSyncProtocol: true,
    });
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    const staleAuthorization = new Error(
      'RFC-64 SWM recovery plan is not authorized by current configuration',
    );
    let catalogReady = true;
    const revalidate = vi.fn(() => {
      if (!catalogReady) throw staleAuthorization;
      return authorized;
    });
    agent.rfc64SwmRecoveryCoordinatorV1 = createRfc64CoordinatorStub({
      revalidate,
    });
    const selectedSync = vi.fn(async () => {
      throw new Error('stale catalog work must not reach selected SWM');
    });
    agent.syncSelectedSharedMemoryFromPeerDetailed = selectedSync;
    const handleSyncError = vi.fn();

    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);
    // Simulate catalog/config revocation after enqueue but before timer drain.
    catalogReady = false;

    await vi.waitFor(() => expect(handleSyncError).toHaveBeenCalledWith(
      PEER_A,
      staleAuthorization,
    ));
    expect(revalidate).toHaveBeenCalledOnce();
    expect(revalidate).toHaveBeenCalledWith(authorized);
    expect(selectedSync).not.toHaveBeenCalled();
  });

  it('runs an exact mixed RFC-64 upgrade before preserving its queued ordinary sync', async () => {
    const agent = await createUnstartedAgent('Rfc64MixedPlanSingleQueueOwner');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.getSyncReconcilerProbe = async () => ({
      connected: true,
      hasSyncProtocol: true,
    });
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [
        { contextGraphId: 'private-cg', lane: 'ordinary-private' as const },
        { contextGraphId: 'public-cg', lane: 'selected-public' as const },
      ],
    };
    agent.rfc64SwmRecoveryCoordinatorV1 = createRfc64CoordinatorStub({
      admitSelectedPublic: vi.fn(() => true),
      authorize: vi.fn(() => authorized),
      revalidate: vi.fn(() => authorized),
    });
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
    agent.syncSelectedSharedMemoryFromPeerDetailed = selectedSync;
    const createPeerJob = agent.createSyncOnConnectPeerJobRunner.bind(agent);
    const ordinaryRun = vi.fn(async () => { ordering.push('ordinary'); });
    agent.createSyncOnConnectPeerJobRunner = (remotePeer) => {
      const runner = createPeerJob(remotePeer);
      return { ...runner, runOrdinary: ordinaryRun };
    };
    const errors: unknown[] = [];
    const handleSyncError = (_peerId: string, error: unknown) => { errors.push(error); };

    // The connection event schedules the canonical owner first. Bootstrap then
    // upgrades that pending run instead of creating a second timer/ledger.
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);
    expect(agent.catchupOnConnectAt.size).toBe(1);
    expect(agent.syncOnConnectPeerScheduler.size).toBe(1);

    await vi.waitFor(() => expect(ordinaryRun).toHaveBeenCalledOnce());

    expect(ordinaryRun).toHaveBeenCalledWith();
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
    await vi.waitFor(() => expect(agent.syncOnConnectPeerScheduler.size).toBe(0));
    expect(agent.syncReconcilerBackoff.has(PEER_A)).toBe(false);
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
    agent.catchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    agent.rfc64ExactCatchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    await vi.waitFor(() => expect(ordinaryRun).toHaveBeenCalledOnce());
    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);
    releaseOrdinary();
    await vi.waitFor(() => expect(selectedSync).toHaveBeenCalledTimes(2));
    expect(ordinaryRun).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(agent.syncOnConnectPeerScheduler.size).toBe(0));

    // A periodic exact plan inside its own cooldown must not use the ordinary
    // owner's one-time post-catalog bypass again.
    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
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
    agent.catchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    agent.rfc64ExactCatchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    await vi.waitFor(() => expect(ordinaryRun).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(agent.syncOnConnectPeerScheduler.size).toBe(0));
    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(selectedSync).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(agent.syncOnConnectPeerScheduler.size).toBe(0));
    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(false);
  });

  it('replays the real ordinary lane past backoff without duplicating selected SWM', async () => {
    const agent = await createUnstartedAgent('Rfc64RealOrdinaryReplay');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.config.nodeRole = 'edge';
    agent.config.syncContextGraphs = ['selected-cg'];
    agent.config.syncSharedMemoryOnConnect = true;
    agent.node.node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    agent.config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { contextGraphId: 'selected-cg', accessPolicy: 0 } },
        completeSwmProviders: [PEER_A],
      }],
    };
    agent.getSyncReconcilerProbe = async () => ({
      connected: true,
      hasSyncProtocol: true,
    });
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    agent.planSharedMemorySyncContextGraphs = async () => ({
      targets: [
        { contextGraphId: 'selected-cg', lane: 'selected-public' },
        { contextGraphId: 'ordinary-private-cg', lane: 'ordinary-private' },
      ],
    });
    agent.refreshMetaSyncedFlags = async () => undefined;
    agent.discoverContextGraphsFromStore = async () => 0;
    const ordering: string[] = [];
    const ordinarySharedSync = vi.fn(async () => {
      ordering.push('ordinary');
      return emptyDetailedSync({ completedPhases: 1 });
    });
    agent.syncSharedMemoryFromPeerDetailed = ordinarySharedSync;
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [
        { contextGraphId: 'ordinary-private-cg', lane: 'ordinary-private' as const },
        { contextGraphId: 'selected-cg', lane: 'selected-public' as const },
      ],
    };
    agent.rfc64SwmRecoveryCoordinatorV1 = createRfc64CoordinatorStub({
      authorize: vi.fn(() => authorized),
    });
    const selectedSync = vi.fn(async (
      _peerId: string,
      _contextGraphIds: readonly string[],
      options: { requestedScope: unknown },
    ) => {
      ordering.push('exact');
      return {
        kind: 'selected-shared-memory' as const,
        requestedScope: options.requestedScope,
        shared: emptyDetailedSync(),
        scopeComplete: false,
        targetDiagnostics: {
          selectedPublic: { completed: 0, total: 1 },
          ordinaryPrivate: { completed: 0, total: 1 },
        },
      };
    });
    agent.syncSelectedSharedMemoryFromPeerDetailed = selectedSync;
    const errors: unknown[] = [];
    const handleSyncError = (_peerId: string, error: unknown) => { errors.push(error); };

    expect(agent.queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);

    await vi.waitFor(() => expect(agent.syncOnConnectPeerScheduler.size).toBe(0));
    expect(ordering).toEqual(['exact', 'ordinary']);
    expect(selectedSync).toHaveBeenCalledOnce();
    expect(ordinarySharedSync).toHaveBeenCalledOnce();
    expect(ordinarySharedSync).toHaveBeenCalledWith(
      PEER_A,
      ['ordinary-private-cg'],
      expect.any(Object),
    );
    expect(agent.syncReconcilerBackoff.get(PEER_A)).toMatchObject({ failures: 1 });
    expect(errors).toEqual([]);
  });

  it('preserves incomplete selected retry ownership after successful ordinary replay', async () => {
    const agent = await createUnstartedAgent('Rfc64IncompleteSelectedThenOrdinary');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.config.nodeRole = 'edge';
    agent.config.syncContextGraphs = [];
    agent.config.syncSharedMemoryOnConnect = false;
    agent.node.node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    agent.getSyncReconcilerProbe = async () => ({
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    agent.planSharedMemorySyncContextGraphs = async () => ({ targets: [] });
    agent.refreshMetaSyncedFlags = async () => undefined;
    agent.discoverContextGraphsFromStore = async () => 0;
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    agent.rfc64SwmRecoveryCoordinatorV1 = createRfc64CoordinatorStub({
      authorize: vi.fn(() => authorized),
      revalidate: vi.fn(() => authorized),
    });
    agent.syncSelectedSharedMemoryFromPeerDetailed = async (
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
    agent.selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    const applyJobAccounting = vi.spyOn(agent, 'applySyncOnConnectAccounting');
    const errors: unknown[] = [];
    const handleSyncError = (_peerId: string, error: unknown) => { errors.push(error); };

    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
    )).toBe(true);
    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);

    await vi.waitFor(() => expect(agent.syncOnConnectPeerScheduler.size).toBe(0));
    expect(agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER_A))
      .toBe(true);
    expect(agent.syncReconcilerBackoff.get(PEER_A)).toMatchObject({
      failures: 1,
    });
    expect(agent.lastSuccessfulSyncAt.has(PEER_A)).toBe(false);
    expect(applyJobAccounting).toHaveBeenCalledOnce();
    expect(applyJobAccounting).toHaveBeenCalledWith(
      PEER_A,
      expect.objectContaining({ reconcilerDisposition: 'retry' }),
      expect.any(Object),
    );
    expect(errors).toEqual([]);

    // Once the bounded backoff/cooldown expires, the retained selected owner
    // remains directly schedulable instead of being hidden by peer freshness.
    agent.syncReconcilerBackoff.get(PEER_A).nextRetryAt = Date.now() - 1;
    agent.catchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    const selectedRetry = vi.fn(async () => undefined);
    installSyncOnConnectPeerJobStub(agent, { runSelected: selectedRetry });
    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(true);
    await vi.waitFor(() => expect(selectedRetry).toHaveBeenCalledOnce());
  });

  it('preserves selected retry ownership when its phase defers before ordinary success', async () => {
    const agent = await createUnstartedAgent('Rfc64DeferredSelectedThenOrdinary');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.getSyncReconcilerProbe = async () => ({
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });
    agent.selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    agent.trySelectedSwmRetryFromPeer = async () => 'deferred-backpressure';
    agent.tryOrdinarySyncFromPeer = async (
      _peerId,
      onSyncAccounting,
    ) => {
      onSyncAccounting?.({
        reconcilerDisposition: 'clear',
        fresh: true,
        progress: true,
      });
      return 'synced';
    };
    const applyJobAccounting = vi.spyOn(agent, 'applySyncOnConnectAccounting');
    const runner = agent.createSyncOnConnectPeerJobRunner(PEER_A);

    await runner.runSelected();
    await runner.runOrdinary();
    runner.finish();

    expect(applyJobAccounting).toHaveBeenCalledOnce();
    expect(applyJobAccounting).toHaveBeenCalledWith(
      PEER_A,
      {
        reconcilerDisposition: 'defer',
        fresh: false,
        progress: true,
      },
      expect.any(Object),
    );
    expect(agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER_A)).toBe(true);
  });

  it('inherits peer freshness from a successful ordinary phase after selected recovery', async () => {
    const agent = await createUnstartedAgent('Rfc64SelectedThenOrdinaryFreshness');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.getSyncReconcilerProbe = async () => ({
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });
    agent.trySelectedSwmRetryFromPeer = async (_peerId, onSyncAccounting) => {
      onSyncAccounting?.({
        reconcilerDisposition: 'clear',
        fresh: false,
        progress: true,
      });
      return 'synced';
    };
    agent.tryOrdinarySyncFromPeer = async (_peerId, onSyncAccounting) => {
      onSyncAccounting?.({
        reconcilerDisposition: 'clear',
        fresh: true,
        progress: false,
      });
      return 'synced';
    };
    const runner = agent.createSyncOnConnectPeerJobRunner(PEER_A);

    await runner.runSelected();
    await runner.runOrdinary();
    runner.finish();

    expect(agent.lastSuccessfulSyncAt.get(PEER_A)).toBeGreaterThan(0);
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(false);
  });

  it('starts a fresh backoff generation when a late selected retry follows ordinary clear', async () => {
    const agent = await createUnstartedAgent('Rfc64OrdinaryClearThenSelectedRetry');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.node.node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    agent.getSyncReconcilerProbe = async () => ({
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });
    agent.syncReconcilerBackoff.set(PEER_A, {
      failures: 4,
      nextRetryAt: Date.now() - 1,
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });
    agent.trySyncFromPeer = async (_peerId, onSyncAccounting) => {
      onSyncAccounting?.({
        reconcilerDisposition: 'clear',
        fresh: true,
        progress: false,
      });
      return 'synced';
    };
    agent.trySelectedSwmRetryFromPeer = async (_peerId, onSyncAccounting) => {
      onSyncAccounting?.({
        reconcilerDisposition: 'retry',
        fresh: false,
        progress: false,
      });
      return 'synced';
    };
    const runner = agent.createSyncOnConnectPeerJobRunner(PEER_A);

    await runner.runOrdinary();
    await runner.runSelected();
    runner.finish();

    expect(agent.syncReconcilerBackoff.get(PEER_A)).toMatchObject({ failures: 1 });
  });

  it('omits retry accounting when a peer-job phase throws local backpressure', async () => {
    const agent = await createUnstartedAgent('Rfc64PeerJobBackpressureAccounting');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.getSyncReconcilerProbe = async () => ({
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });
    agent.trySelectedSwmRetryFromPeer = async () => {
      throw new SyncBackpressureBusyError('sync queue full');
    };
    const applyJobAccounting = vi.spyOn(agent, 'applySyncOnConnectAccounting');
    const runner = agent.createSyncOnConnectPeerJobRunner(PEER_A);

    await runner.runSelected();
    runner.finish();

    expect(applyJobAccounting).not.toHaveBeenCalled();
    expect(agent.syncReconcilerBackoff.has(PEER_A)).toBe(false);
  });

  it('commits one retry when a queued ordinary phase rejects', async () => {
    const agent = await createUnstartedAgent('Rfc64QueuedOrdinaryRejectionAccounting');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.node.node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    agent.getSyncReconcilerProbe = async () => ({
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });
    const failure = new Error('ordinary sync failed');
    agent.trySyncFromPeer = async () => { throw failure; };
    const applyJobAccounting = vi.spyOn(agent, 'applySyncOnConnectAccounting');
    const handleSyncError = vi.fn();

    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
    )).toBe(true);

    await vi.waitFor(() => expect(handleSyncError).toHaveBeenCalledWith(
      PEER_A,
      failure,
    ));
    await vi.waitFor(() => expect(agent.syncOnConnectPeerScheduler.size).toBe(0));
    expect(applyJobAccounting).toHaveBeenCalledOnce();
    expect(applyJobAccounting).toHaveBeenCalledWith(
      PEER_A,
      {
        reconcilerDisposition: 'retry',
        fresh: false,
        progress: false,
      },
      expect.any(Object),
    );
    expect(agent.syncReconcilerBackoff.get(PEER_A)).toMatchObject({ failures: 1 });
  });

  it('adds owed ordinary work to the same job while exact recovery is running', async () => {
    const agent = await createUnstartedAgent('Rfc64OrdinaryUpgradeDuringExact');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    agent.rfc64SwmRecoveryCoordinatorV1 = createRfc64CoordinatorStub({
      authorize: vi.fn(() => authorized),
    });
    let releaseExact!: () => void;
    const exactBlocked = new Promise<void>((resolve) => { releaseExact = resolve; });
    const ordering: string[] = [];
    const selectedRun = vi.fn(async () => {
      ordering.push('exact-in-flight');
      await exactBlocked;
    });
    const ordinaryRun = vi.fn(async () => { ordering.push('ordinary'); });
    installSyncOnConnectPeerJobStub(agent, {
      runSelected: selectedRun,
      runOrdinary: ordinaryRun,
    });
    const handleSyncError = () => undefined;

    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(ordering).toEqual(['exact-in-flight']));
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    releaseExact();

    await vi.waitFor(() => expect(agent.syncOnConnectPeerScheduler.size).toBe(0));
    expect(ordinaryRun).toHaveBeenCalledWith(PEER_A);
    expect(ordering).toEqual(['exact-in-flight', 'ordinary']);
  });

  it('keeps ordinary connection and reconciler sync live while catalog-gating selected SWM', async () => {
    const agent = await createUnstartedAgent('Rfc64CatalogBeforeAutomaticSwm');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.config.nodeRole = 'edge';
    agent.config.syncContextGraphs = ['selected-cg'];
    agent.config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { contextGraphId: 'selected-cg', accessPolicy: 0 } },
        completeSwmProviders: [PEER_A],
      }],
    };
    agent.selectedSwmBootstrapContextGraphIdsForPeer = () => ['selected-cg'];
    agent.rfc64SwmRecoveryCoordinatorV1 = createRfc64CoordinatorStub({
      admitSelectedPublic: vi.fn(() => false),
    });
    const queuedRun = vi.fn(async () => undefined);
    installSyncOnConnectPeerJobStub(agent, { runOrdinary: queuedRun });

    // A generic connection owner remains schedulable while catalog bootstrap
    // owns only the selected RFC-64 lane.
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0))
      .toBe(true);
    await flushTimers();
    expect(queuedRun).toHaveBeenCalledOnce();

    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    agent.planSharedMemorySyncContextGraphs = async () => ({
      targets: [
        { contextGraphId: 'selected-cg', lane: 'selected-public' },
        { contextGraphId: 'ordinary-cg', lane: 'ordinary-private' },
      ],
    });
    const selectedSync = vi.fn(async () => {
      throw new Error('selected SWM must remain catalog-gated');
    });
    const ordinarySharedSync = vi.fn(async () => emptyDetailedSync({ completedPhases: 1 }));
    agent.syncSelectedSharedMemoryFromPeerDetailed = selectedSync;
    agent.syncSharedMemoryFromPeerDetailed = ordinarySharedSync;
    agent.refreshMetaSyncedFlags = async () => undefined;
    agent.discoverContextGraphsFromStore = async () => 0;

    expect(await agent.trySyncFromPeer(PEER_A, undefined, 'reconcile'))
      .toBe('synced');
    expect(agent.rfc64SwmRecoveryCoordinatorV1.admitSelectedPublic)
      .toHaveBeenCalledWith(PEER_A, ['selected-cg']);
    expect(selectedSync).not.toHaveBeenCalled();
    expect(ordinarySharedSync).toHaveBeenCalledWith(
      PEER_A,
      ['ordinary-cg'],
      expect.any(Object),
    );
  });

  it('partitions one frozen SWM plan across selected and ordinary modalities', async () => {
    const agent = await createUnstartedAgent('Rfc64FrozenSelectedSwmPlan');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.config.nodeRole = 'edge';
    agent.config.syncContextGraphs = ['selected-a', 'selected-b'];
    agent.config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: {
          payload: { contextGraphId: 'selected-a', accessPolicy: 0 },
        },
        completeSwmProviders: [PEER_A],
      }],
    };
    agent.selectedSwmBootstrapContextGraphIdsForPeer = () => ['selected-a'];
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    const planner = vi.fn()
      .mockResolvedValueOnce({
        targets: [
          { contextGraphId: 'selected-a', lane: 'selected-public' },
          { contextGraphId: 'selected-b', lane: 'selected-public' },
          { contextGraphId: 'private-c', lane: 'ordinary-private' },
        ],
      })
      .mockResolvedValue({
        targets: [{ contextGraphId: 'selected-b', lane: 'selected-public' }],
      });
    agent.planSharedMemorySyncContextGraphs = planner;
    agent.rfc64SwmRecoveryCoordinatorV1 = createRfc64CoordinatorStub({
      admitSelectedPublic: vi.fn(() => true),
    });
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
    agent.syncSelectedSharedMemoryFromPeerDetailed = selectedSync;
    const ordinarySharedSync = vi.fn(
      async () => emptyDetailedSync({ completedPhases: 1 }),
    );
    agent.syncSharedMemoryFromPeerDetailed = ordinarySharedSync;
    agent.syncFromPeerDetailed = vi.fn(
      async () => emptyDetailedSync({ completedPhases: 1 }),
    );
    agent.refreshMetaSyncedFlags = async () => undefined;
    agent.discoverContextGraphsFromStore = async () => 0;

    expect(await agent.trySyncFromPeer(PEER_A, undefined, 'reconcile'))
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
      ['selected-b', 'private-c'],
      expect.objectContaining({
        sharedMemorySyncPlan: {
          targets: [
            { contextGraphId: 'selected-b', lane: 'selected-public' },
            { contextGraphId: 'private-c', lane: 'ordinary-private' },
          ],
        },
      }),
    );
  });

  it('retries incomplete selected SWM past generic freshness without creating a loop', async () => {
    const agent = await createUnstartedAgent('SelectedSwmRetryFreshnessBypass');
    const calls: string[] = [];
    const selectedRun = async (peerId: string) => {
      calls.push(peerId);
    };
    installSyncOnConnectPeerJobStub(agent, { runSelected: selectedRun });
    const handleSyncError = () => undefined;
    agent.lastSuccessfulSyncAt.set(PEER_A, Date.now());

    // Generic fresh-success suppression remains authoritative until the
    // selected lane explicitly records incomplete exact coverage.
    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(false);

    agent.selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    // A normal connection-open event never inherits the catalog bootstrap's
    // selected retry authority, even while the scheduling marker is present.
    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
    )).toBe(false);
    agent.syncReconcilerBackoff.set(PEER_A, {
      failures: 1,
      nextRetryAt: Date.now() + 60_000,
    });
    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(false);
    agent.syncReconcilerBackoff.delete(PEER_A);
    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(true);
    // The ordinary one-minute queue cooldown still prevents retry storms.
    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
      { selectedSwmRetry: true },
    )).toBe(false);
    await flushTimers();
    expect(calls).toEqual([PEER_A]);

    // A later exact completion clears the marker. Even after the short queue
    // cooldown expires, the still-fresh generic success prevents another run.
    const completedOwner = agent.selectedSwmBootstrapAdmission.beginTransfer(
      PEER_A,
      ['selected-cg'],
    );
    agent.selectedSwmBootstrapAdmission.markTransferTerminal(completedOwner);
    agent.catchupOnConnectAt.set(
      PEER_A,
      Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1,
    );
    expect(agent.queueSyncFromPeerOnConnect(
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
    agent.started = true;
    agent.config.syncOnConnectEnabled = false;
    agent.config.syncSharedMemoryOnConnect = false;
    agent.config.syncContextGraphs = ['selected-cg'];
    agent.config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{ completeSwmProviders: [PEER_A] }],
    };
    agent.selectedSwmBootstrapContextGraphIdsForPeer = () => ['selected-cg'];
    agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
    agent.planSharedMemorySyncContextGraphs = async () => ({
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
    agent.syncSelectedSharedMemoryFromPeerDetailed = selectedSync;
    agent.syncFromPeerDetailed = durableSync;
    agent.syncSharedMemoryFromPeerDetailed = ordinarySharedSync;
    agent.refreshMetaSyncedFlags = async () => undefined;
    agent.discoverContextGraphsFromStore = discoverContextGraphsFromStore;
    const errors: unknown[] = [];
    const handleSyncError = (_peerId: string, error: unknown) => {
      errors.push(error);
    };
    agent.lastSuccessfulSyncAt.set(PEER_A, Date.now());
    expect(agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER_A)).toBe(false);

    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
    )).toBe(false);
    expect(agent.queueSelectedSwmFromPeerOnConnect(
      PEER_A,
      handleSyncError,
      0,
    )).toBe(true);
    expect(agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER_A)).toBe(true);

    await flushTimers();
    expect(errors).toEqual([]);
    expect(selectedSync.calls).toHaveLength(1);
    expect(selectedSync.calls[0][0]).toBe(PEER_A);
    expect(selectedSync.calls[0][1]).toEqual(['selected-cg']);
    expect(durableSync.calls).toEqual([]);
    expect(ordinarySharedSync.calls).toEqual([]);
    expect(discoverContextGraphsFromStore.calls).toEqual([]);
    expect(agent.lastSuccessfulSyncAt.has(PEER_A)).toBe(true);
  });

  it('clears selected SWM retry state when network admission rejects a peer', async () => {
    const agent = await createUnstartedAgent('SelectedSwmRetryRejectedPeerCleanup');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.config.syncOnConnectEnabled = true;
    agent.selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);
    const runs: string[] = [];
    const runOrdinary = async (peerId: string) => {
      runs.push(peerId);
    };
    installSyncOnConnectPeerJobStub(agent, { runOrdinary });
    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      () => undefined,
      50,
    )).toBe(true);
    expect(agent.syncOnConnectPeerScheduler.has(PEER_A)).toBe(true);

    agent.clearNetworkRejectedPeerState(PEER_A);

    expect(agent.selectedSwmBootstrapAdmission.snapshot(PEER_A)).toBeNull();
    expect(agent.syncOnConnectPeerScheduler.has(PEER_A)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(runs).toEqual([]);
  });

  it('clears selected SWM retry state after stop drains transfer owners', async () => {
    const agent = await createUnstartedAgent('SelectedSwmRetryStopCleanup', {
      listenPort: 0,
      bootstrapPeers: [],
    });
    try {
      await agent.start();
      agent.selectedSwmBootstrapAdmission.request(PEER_A, ['selected-cg']);

      await agent.stop();

      expect(agent.selectedSwmBootstrapAdmission.size).toBe(0);
    } finally {
      if (agent.started) await agent.stop().catch(() => undefined);
    }
  });

});
