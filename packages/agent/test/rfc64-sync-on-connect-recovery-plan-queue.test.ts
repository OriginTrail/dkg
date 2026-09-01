import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS } from '../src/dkg-agent-constants.js';
import { SyncOnConnectPeerScheduler } from '../src/sync/on-connect/peer-scheduler.js';
import {
  allowAllNetworkAdmission,
  createSyncOnConnectPeerJobRunnerForTest,
  createRfc64CoordinatorStub,
  createUnstartedAgent,
  emptyDetailedSync,
  flushTimers,
  installSyncOnConnectPeerJobStub,
} from './_helpers/sync-on-connect-test-fixture.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

describe('RFC-64 recovery-plan queue authorization', () => {
  it('queues a widened plan when a newly selected graph had no admission owner', async () => {
    const agent = await createUnstartedAgent('Rfc64SelectionInvalidatesExactCooldown');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [
        { contextGraphId: 'existing-cg', lane: 'selected-public' as const },
        { contextGraphId: 'new-selected-cg', lane: 'selected-public' as const },
      ],
    };
    const selectedRun = vi.fn(async () => undefined);
    installSyncOnConnectPeerJobStub(agent, { runSelected: selectedRun });
    agent.selectedSwmBootstrapAdmission.request(PEER_A, ['existing-cg']);
    agent.rfc64ExactCatchupOnConnectAt.set(PEER_A, Date.now());
    vi.spyOn(agent, 'resolveRfc64CompleteSwmProviderPeerIdsV1')
      .mockImplementation((contextGraphId) => (
        contextGraphId === 'new-selected-cg' ? [PEER_A] : []
      ));

    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      vi.fn(),
      0,
    )).toBe(false);
    expect(agent.invalidateRfc64SwmRecoverySelectionStateV1('new-selected-cg'))
      .toEqual([PEER_A]);
    expect(agent.rfc64ExactCatchupOnConnectAt.has(PEER_A)).toBe(false);
    expect(agent.selectedSwmBootstrapAdmission.snapshot(PEER_A)).toEqual({
      contextGraphIds: ['existing-cg'],
      phase: 'retry-required',
    });
    agent.selectedSwmBootstrapAdmission.request(
      PEER_A,
      ['existing-cg', 'new-selected-cg'],
    );

    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      vi.fn(),
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(selectedRun).toHaveBeenCalledWith(PEER_A, authorized));
  });

  it('reports a catalog recovery plan that is not authorized', async () => {
    const agent = await createUnstartedAgent('Rfc64CatalogPlanNotAuthorized');
    const activePlan = {
      kind: 'rfc64-active-swm-recovery-plan-v1' as const,
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    const authorizeForCatalogPass = vi.fn(() => null);
    const queue = vi.spyOn(agent, 'queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect');
    agent.rfc64SwmRecoveryCoordinatorV1 = createRfc64CoordinatorStub({
      authorizeForCatalogPass,
    });

    expect(agent.queueRfc64CatalogRecoveryPlanV1(activePlan, vi.fn(), 0))
      .toEqual({ kind: 'not-authorized' });
    expect(authorizeForCatalogPass).toHaveBeenCalledOnce();
    expect(queue).not.toHaveBeenCalled();
  });

  it.each([
    [true, 'queued'],
    [false, 'rejected'],
  ] as const)('reports catalog queue acceptance=%s as %s', async (accepted, kind) => {
    const agent = await createUnstartedAgent(`Rfc64CatalogPlan-${kind}`);
    const activePlan = {
      kind: 'rfc64-active-swm-recovery-plan-v1' as const,
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    const authorizedPlan = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: activePlan.targets,
    };
    agent.rfc64SwmRecoveryCoordinatorV1 = createRfc64CoordinatorStub({
      authorizeForCatalogPass: vi.fn(() => authorizedPlan),
    });
    vi.spyOn(agent, 'queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect')
      .mockReturnValue(accepted);

    expect(agent.queueRfc64CatalogRecoveryPlanV1(activePlan, vi.fn(), 0))
      .toEqual({ kind });
  });

  it('rejects a network-denied provider at the authorized queue boundary', async () => {
    const agent = await createUnstartedAgent('Rfc64AuthorizedPlanNetworkDenial');
    agent.networkAdmissionCoordinator.isAcceptedPeer = () => false;
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    const selectedRun = vi.fn(async () => undefined);
    installSyncOnConnectPeerJobStub(agent, { runSelected: selectedRun });

    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      vi.fn(),
      0,
    )).toBe(false);
    expect(agent.getSyncOnConnectPeerScheduler().size).toBe(0);
    await flushTimers();
    expect(selectedRun).not.toHaveBeenCalled();
  });

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

    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
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

    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
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
    const ordinaryRun = vi.fn(async () => { ordering.push('ordinary'); });
    agent.syncOnConnectPeerScheduler = new SyncOnConnectPeerScheduler({
      createJob: (remotePeer) => {
        const runner = createSyncOnConnectPeerJobRunnerForTest(agent, remotePeer);
        return {
          runSelected: (recoveryPlan) => runner.runSelected(recoveryPlan),
          runAutomaticSelectedThenOrdinary: ordinaryRun,
          cancel: () => { runner.cancel(); },
          finish: () => { runner.finish(); },
        };
      },
      onInternalError: () => undefined,
    });
    const errors: unknown[] = [];
    const handleSyncError = (_peerId: string, error: unknown) => { errors.push(error); };

    // The connection event schedules the canonical owner first. Bootstrap then
    // upgrades that pending run instead of creating a second timer/ledger.
    expect(agent.queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
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
    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
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
    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
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
    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(selectedSync).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(agent.syncOnConnectPeerScheduler.size).toBe(0));
    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      0,
    )).toBe(false);
  });
});
