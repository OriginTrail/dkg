import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { computeNetworkId, PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS } from '../src/dkg-agent-constants.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { Rfc64SwmRecoveryRuntimeV1 } from
  '../src/dkg-agent-rfc64-swm-recovery-runtime.js';
import { resolveRfc64RuntimeCatalogBootstrapConfigV1 } from
  '../src/rfc64/public-catalog-activation-config-v1.js';
import { SwmTargetExecutorV1 } from '../src/sync/requester/swm-target-executor.js';
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
import {
  RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
  RFC64_ROLLOUT_NETWORK_ID,
  rfc64RolloutActivation,
  rfc64RolloutPolicyEnvelope,
} from './_helpers/rfc64-rollout-agent-harness.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(
    (path) => rm(path, { recursive: true, force: true }),
  ));
});

describe('RFC-64 recovery-plan queue authorization', () => {
  it('uses one selection projection for current, previous, and next authority', () => {
    let selection = {
      selectedContextGraphs: [RFC64_ROLLOUT_CONTEXT_GRAPH_ID],
      eligibleContextGraphs: [RFC64_ROLLOUT_CONTEXT_GRAPH_ID],
      subscriptionDriven: true,
    };
    const recoveryConfig = {
      retryIntervalMs: 0,
      acceptedPublicPolicies: [{
        policyEnvelope: rfc64RolloutPolicyEnvelope(),
        targets: [],
        completeSwmProviders: [PEER_A],
      }],
    };
    const normalizedRecoveryConfig = resolveRfc64RuntimeCatalogBootstrapConfigV1(
      undefined,
      recoveryConfig,
    );
    const deleteProvider = vi.fn();
    const runtime = new Rfc64SwmRecoveryRuntimeV1({
      authority: {
        resolveRuntimeSelection: () => selection,
        resolveConfigured: (contextGraphId) => ({
          contextGraphId,
          selected: true,
          eligible: true,
          active: true,
          mode: 'catalog',
          killSwitchActive: false,
          legacySyncAllowed: false,
          track2Enabled: true,
          authoringAllowed: true,
          reconciliationLane: 'catalog-apply',
        }),
        resolveRecoveryConfig: () => normalizedRecoveryConfig,
      },
      admission: { invalidateContextGraph: () => [] },
      cooldown: { deleteProvider },
    });

    expect(runtime.resolveRuntimeAuthority(RFC64_ROLLOUT_CONTEXT_GRAPH_ID))
      .toMatchObject({ active: true, lane: 'selected-public' });
    expect(runtime.resolveConfiguredCompleteProviderPeerIds(
      RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
    )).toEqual([PEER_A]);
    expect(runtime.resolveActiveCompleteProviderPeerIds(
      RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
    )).toEqual([PEER_A]);
    expect(runtime.projectSubscriptionTransition(RFC64_ROLLOUT_CONTEXT_GRAPH_ID, {
      previousSubscribed: true,
      nextSubscribed: false,
    })).toMatchObject({
      receiverChanged: true,
      recoveryChanged: true,
      nextReceiverActive: false,
    });

    selection = { ...selection, selectedContextGraphs: [] };
    expect(runtime.resolveRuntimeAuthority(RFC64_ROLLOUT_CONTEXT_GRAPH_ID))
      .toMatchObject({ active: false, lane: 'selected-public' });
    expect(runtime.resolveConfiguredCompleteProviderPeerIds(
      RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
    )).toEqual([PEER_A]);
    expect(runtime.resolveActiveCompleteProviderPeerIds(
      RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
    )).toEqual([]);
    expect(runtime.invalidateSelectionState(RFC64_ROLLOUT_CONTEXT_GRAPH_ID))
      .toEqual([PEER_A]);
    expect(deleteProvider).toHaveBeenCalledWith(PEER_A);
    expect(runtime.projectSubscriptionTransition(RFC64_ROLLOUT_CONTEXT_GRAPH_ID, {
      previousSubscribed: false,
      nextSubscribed: true,
    })).toMatchObject({
      receiverChanged: true,
      recoveryChanged: true,
      nextReceiverActive: true,
    });
  });

  it('projects every subscription lifecycle effect from one transition snapshot', () => {
    const project = vi.fn()
      .mockReturnValueOnce({
        previousReceiverActive: true,
        nextReceiverActive: false,
        receiverChanged: true,
        recoveryChanged: true,
      })
      .mockReturnValueOnce({
        previousReceiverActive: false,
        nextReceiverActive: true,
        receiverChanged: true,
        recoveryChanged: true,
      });
    const deactivate = vi.fn();
    const clearTargets = vi.fn();
    const invalidate = vi.fn();
    const queueGossip = vi.fn();
    const replay = vi.fn(async () => ({ requested: 0, failed: 0 }));
    const startSupervisor = vi.fn();
    const agent = {
      projectRfc64CatalogSubscriptionTransitionV1: project,
      rfc64PublicCatalogServiceV1: {
        deactivateReceiverContextGraph: deactivate,
      },
      clearRfc64CatalogOperationalTargetsV1: clearTargets,
      invalidateRfc64PublicCatalogBootstrapPassV1: invalidate,
      queueSharedMemoryGossipSubscription: queueGossip,
      requestRfc64CatalogHeadReplaysFromConnectedPeersV1: replay,
      startRfc64SwmCatalogProjectionSupervisorV1: startSupervisor,
    };
    const handle = LifecycleSyncMethods.prototype
      .handleRfc64CatalogReceiverSelectionTransitionV1;
    const unsubscribe = {
      kind: 'subscription' as const,
      previousSubscribed: true,
      nextSubscribed: false,
    };
    const subscribe = {
      kind: 'subscription' as const,
      previousSubscribed: false,
      nextSubscribed: true,
    };

    handle.call(agent as never, RFC64_ROLLOUT_CONTEXT_GRAPH_ID, unsubscribe);
    handle.call(agent as never, RFC64_ROLLOUT_CONTEXT_GRAPH_ID, subscribe);

    expect(project).toHaveBeenNthCalledWith(
      1,
      RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
      unsubscribe,
    );
    expect(project).toHaveBeenNthCalledWith(
      2,
      RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
      subscribe,
    );
    expect(deactivate).toHaveBeenCalledOnce();
    expect(clearTargets).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(queueGossip).toHaveBeenCalledTimes(2);
    expect(replay).toHaveBeenCalledOnce();
    expect(startSupervisor).toHaveBeenCalledOnce();
  });

  it('creates a fresh SWM target executor for each synchronization session', async () => {
    const agent = await createUnstartedAgent('SwmTargetExecutorComposition');

    const first = agent.createSwmTargetExecutorV1();
    const second = agent.createSwmTargetExecutorV1();

    expect(first).toBeInstanceOf(SwmTargetExecutorV1);
    expect(second).not.toBe(first);
  });

  it('wires runtime authority into one-way coordinator admission and revalidation', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-owner-composition-'));
    tempDirs.push(dataDir);
    const agent = await createUnstartedAgent('Rfc64RecoveryOwnerComposition', {
      dataDir,
      rfc64PublicCatalogActivation: {
        ...rfc64RolloutActivation('catalog'),
        bootstrap: {
          retryIntervalMs: 0,
          acceptedPublicPolicies: [{
            policyEnvelope: rfc64RolloutPolicyEnvelope(),
            targets: [],
            completeSwmProviders: [PEER_A],
          }],
        },
      },
      syncContextGraphs: [RFC64_ROLLOUT_CONTEXT_GRAPH_ID],
      chainAdapter: new MockChainAdapter(RFC64_ROLLOUT_NETWORK_ID),
      networkIdentity: {
        networkId: await computeNetworkId(),
        chainId: RFC64_ROLLOUT_NETWORK_ID,
      },
    });
    agent.subscribedContextGraphs.set(RFC64_ROLLOUT_CONTEXT_GRAPH_ID, {
      subscribed: true,
    });
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.isRfc64CatalogBootstrapSwmRecoveryReadyV1 = () => true;

    expect(agent.resolveRfc64SwmRecoveryRuntimeAuthorityV1(
      RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
    )).toMatchObject({ active: true, lane: 'selected-public' });

    const coordinator = agent.rfc64SwmRecoveryCoordinatorV1;
    expect(coordinator.admitSelectedPublic(
      PEER_A,
      [RFC64_ROLLOUT_CONTEXT_GRAPH_ID],
    )).toBe(true);
    const activePlan = agent.resolveActiveRfc64SwmRecoveryPlanV1(PEER_A);
    const authorized = coordinator.authorizeForCatalogPass(activePlan, 0);
    expect(authorized).not.toBeNull();
    expect(coordinator.revalidate(authorized!)).toEqual(authorized);
  });

  it('queues a widened plan when a newly selected graph had no admission owner', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-recovery-queue-'));
    tempDirs.push(dataDir);
    const agent = await createUnstartedAgent('Rfc64SelectionInvalidatesExactCooldown', {
      dataDir,
      store: new OxigraphStore(),
      rfc64PublicCatalogActivation: {
        ...rfc64RolloutActivation('catalog'),
        bootstrap: {
          retryIntervalMs: 0,
          acceptedPublicPolicies: [{
            policyEnvelope: rfc64RolloutPolicyEnvelope(),
            targets: [],
            completeSwmProviders: [PEER_A],
          }],
        },
      },
      syncContextGraphs: [RFC64_ROLLOUT_CONTEXT_GRAPH_ID],
      chainAdapter: new MockChainAdapter(RFC64_ROLLOUT_NETWORK_ID),
      networkIdentity: {
        networkId: await computeNetworkId(),
        chainId: RFC64_ROLLOUT_NETWORK_ID,
      },
    });
    allowAllNetworkAdmission(agent);
    agent.started = true;
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [
        { contextGraphId: 'existing-cg', lane: 'selected-public' as const },
        {
          contextGraphId: RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
          lane: 'selected-public' as const,
        },
      ],
    };
    const selectedRun = vi.fn(async () => undefined);
    installSyncOnConnectPeerJobStub(agent, { runSelected: selectedRun });
    agent.selectedSwmBootstrapAdmission.request(PEER_A, ['existing-cg']);
    agent.rfc64ExactCatchupOnConnectAt.set(PEER_A, Date.now());

    expect(agent.rfc64SwmRecoveryRuntimeV1.resolveConfiguredCompleteProviderPeerIds(
      RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
    )).toEqual([PEER_A]);
    expect(agent.resolveRfc64CompleteSwmProviderPeerIdsV1(
      RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
    )).toEqual([]);

    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      vi.fn(),
      0,
    )).toBe(false);
    expect(agent.invalidateRfc64SwmRecoverySelectionStateV1(
      RFC64_ROLLOUT_CONTEXT_GRAPH_ID,
    ))
      .toEqual([PEER_A]);
    expect(agent.rfc64ExactCatchupOnConnectAt.has(PEER_A)).toBe(false);
    expect(agent.selectedSwmBootstrapAdmission.snapshot(PEER_A)).toEqual({
      contextGraphIds: ['existing-cg'],
      phase: 'retry-required',
    });
    agent.selectedSwmBootstrapAdmission.request(
      PEER_A,
      ['existing-cg', RFC64_ROLLOUT_CONTEXT_GRAPH_ID],
    );

    expect(agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      vi.fn(),
      0,
    )).toBe(true);
    await vi.waitFor(() => expect(selectedRun).toHaveBeenCalledWith(PEER_A, authorized));
  });

  it('revokes only the changed graph in a mixed in-flight recovery plan', async () => {
    const agent = await createUnstartedAgent('Rfc64GraphScopedRecoveryRevocation');
    vi.spyOn(agent.rfc64SwmRecoveryRuntimeV1, 'resolveRuntimeAuthority')
      .mockImplementation((contextGraphId) => ({
        kind: 'rfc64-swm-recovery-runtime-authority-v1',
        contextGraphId,
        lane: contextGraphId === 'private-cg' ? 'ordinary-private' : 'selected-public',
        active: true,
      }));
    const publicLease = agent.acquireRfc64SwmRecoveryTargetLeaseV1({
      contextGraphId: 'public-cg',
      lane: 'selected-public',
    });
    const privateLease = agent.acquireRfc64SwmRecoveryTargetLeaseV1({
      contextGraphId: 'private-cg',
      lane: 'ordinary-private',
    });

    agent.invalidateRfc64SwmRecoverySelectionStateV1('public-cg');

    expect(publicLease.signal.aborted).toBe(true);
    expect(publicLease.isCurrent()).toBe(false);
    expect(privateLease.signal.aborted).toBe(false);
    expect(privateLease.isCurrent()).toBe(true);
    expect(() => privateLease.assertCurrent()).not.toThrow();

    const nextPublicLease = agent.acquireRfc64SwmRecoveryTargetLeaseV1({
      contextGraphId: 'public-cg',
      lane: 'selected-public',
    });
    expect(nextPublicLease.signal.aborted).toBe(false);
    expect(nextPublicLease.isCurrent()).toBe(true);
    expect(() => publicLease.assertCurrent()).toThrow('recovery authority was revoked');
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
