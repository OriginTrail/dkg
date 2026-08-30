import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import {
  allowAllNetworkAdmission,
  createRfc64CoordinatorStub,
  createUnstartedAgent,
  emptyDetailedSync,
  flushTimers,
  installSyncOnConnectPeerJobStub,
} from './_helpers/sync-on-connect-test-fixture.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

describe('RFC-64 SWM lane partition and admission', () => {
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
});
