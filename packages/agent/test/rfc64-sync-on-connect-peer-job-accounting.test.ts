import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS } from '../src/dkg-agent-constants.js';
import { SyncBackpressureBusyError } from '../src/sync/backpressure.js';
import {
  captureSyncOnConnectAttempt,
  executeSyncOnConnectAttempt,
} from '../src/sync/on-connect/attempt-accounting.js';
import { SyncOnConnectPostSyncError } from '../src/sync/on-connect/sync-on-connect.js';
import {
  allowAllNetworkAdmission,
  createRfc64CoordinatorStub,
  createUnstartedAgent,
  emptyDetailedSync,
  flushTimers,
  installSyncOnConnectPeerJobStub,
} from './_helpers/sync-on-connect-test-fixture.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

describe('RFC-64 peer-job accounting and order', () => {
  it('executes the ordinary-only job plan as optional selected then invariant ordinary', async () => {
    const agent = await createUnstartedAgent('Rfc64OrdinaryOnlyPhasePlan');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.config.syncContextGraphs = ['selected-cg'];
    agent.config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { contextGraphId: 'selected-cg', accessPolicy: 0 } },
        completeSwmProviders: [PEER_A],
      }],
    };
    agent.getSyncReconcilerProbe = async () => ({
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });
    const order: string[] = [];
    agent.trySelectedSwmRetryFromPeer = vi.fn(async (_peerId, onSyncAccounting) => {
      order.push('selected');
      onSyncAccounting?.({
        reconcilerDisposition: 'clear',
        fresh: false,
        progress: true,
      });
      return 'synced';
    });
    agent.trySyncFromPeer = vi.fn(async (_peerId, onSyncAccounting) => {
      order.push('ordinary');
      onSyncAccounting?.({
        reconcilerDisposition: 'clear',
        fresh: true,
        progress: true,
      });
      return 'synced';
    });
    const runner = agent.createSyncOnConnectPeerJobRunner(PEER_A);

    await runner.runOrdinary();
    runner.finish();

    expect(order).toEqual(['selected', 'ordinary']);
    expect(agent.trySelectedSwmRetryFromPeer).toHaveBeenCalledOnce();
    expect(agent.trySyncFromPeer).toHaveBeenCalledOnce();
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
    agent.trySyncFromPeer = async (
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
    agent.trySyncFromPeer = async (_peerId, onSyncAccounting) => {
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

  it('continues ordinary work after selected rejection and retains retry accounting', async () => {
    const agent = await createUnstartedAgent('Rfc64SelectedRejectionOrdinaryContinuation');
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
    const selectedFailure = new Error('selected sync failed');
    agent.trySelectedSwmRetryFromPeer = async () => { throw selectedFailure; };
    const ordinaryRun = vi.fn(async (_peerId, onSyncAccounting) => {
      onSyncAccounting?.({
        reconcilerDisposition: 'clear',
        fresh: true,
        progress: true,
      });
      return 'synced' as const;
    });
    agent.trySyncFromPeer = ordinaryRun;
    const selectedErrors: unknown[] = [];
    const ordinaryErrors: unknown[] = [];
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    const applyJobAccounting = vi.spyOn(agent, 'applySyncOnConnectAccounting');

    expect(agent.queueSyncFromPeerOnConnect(
      PEER_A,
      (_peerId, error) => ordinaryErrors.push(error),
      0,
    )).toBe(true);
    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      (_peerId, error) => selectedErrors.push(error),
      0,
    )).toBe(true);

    await vi.waitFor(() => expect(agent.syncOnConnectPeerScheduler.size).toBe(0));
    expect(selectedErrors).toEqual([selectedFailure]);
    expect(ordinaryErrors).toEqual([]);
    expect(ordinaryRun).toHaveBeenCalledOnce();
    expect(applyJobAccounting).toHaveBeenCalledOnce();
    expect(applyJobAccounting).toHaveBeenCalledWith(
      PEER_A,
      {
        reconcilerDisposition: 'retry',
        fresh: false,
        progress: true,
      },
      expect.any(Object),
    );
    expect(agent.syncReconcilerBackoff.get(PEER_A)).toMatchObject({ failures: 1 });
  });

  it('commits a later ordinary failure against its contemporaneous connection probe', async () => {
    const agent = await createUnstartedAgent('Rfc64PeerJobLaterConnectionFailure');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.node.node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    const probeA = { protocolsKey: PROTOCOL_SYNC, connectionKey: 'connection-a' };
    const probeB = { protocolsKey: PROTOCOL_SYNC, connectionKey: 'connection-b' };
    const probes = [probeA, probeB];
    agent.getSyncReconcilerProbe = vi.fn(async () => probes.shift()!);
    agent.trySelectedSwmRetryFromPeer = async (_peerId, onSyncAccounting) => {
      onSyncAccounting?.({
        reconcilerDisposition: 'clear',
        fresh: false,
        progress: true,
      });
      return 'synced';
    };
    const ordinaryFailure = new Error('ordinary failed after reconnect');
    agent.trySyncFromPeer = async () => { throw ordinaryFailure; };
    const runner = agent.createSyncOnConnectPeerJobRunner(PEER_A);

    await runner.runSelected();
    await expect(runner.runOrdinary()).rejects.toBe(ordinaryFailure);
    runner.finish();

    expect(agent.getSyncReconcilerProbe).toHaveBeenCalledTimes(2);
    expect(agent.syncReconcilerBackoff.get(PEER_A)).toMatchObject({
      failures: 1,
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: 'connection-b',
    });
    expect(agent.hasSyncReconcilerProbeChanged(
      agent.syncReconcilerBackoff.get(PEER_A),
      probeB,
    )).toBe(false);
  });

  it('keeps immediate retry when only the old connection owned the failure', async () => {
    const agent = await createUnstartedAgent('Rfc64PeerJobOldConnectionFailure');
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.node.node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    const probeA = { protocolsKey: PROTOCOL_SYNC, connectionKey: 'connection-a' };
    const probeB = { protocolsKey: PROTOCOL_SYNC, connectionKey: 'connection-b' };
    const probes = [probeA, probeB];
    agent.getSyncReconcilerProbe = vi.fn(async () => probes.shift()!);
    const selectedFailure = new Error('selected failed on old connection');
    agent.trySelectedSwmRetryFromPeer = async () => { throw selectedFailure; };
    agent.trySyncFromPeer = async (_peerId, onSyncAccounting) => {
      onSyncAccounting?.({
        reconcilerDisposition: 'clear',
        fresh: true,
        progress: true,
      });
      return 'synced';
    };
    const runner = agent.createSyncOnConnectPeerJobRunner(PEER_A);

    await expect(runner.runSelected()).rejects.toBe(selectedFailure);
    await runner.runOrdinary();
    runner.finish();

    expect(agent.syncReconcilerBackoff.get(PEER_A)).toMatchObject({
      failures: 1,
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: 'connection-a',
    });
    expect(agent.hasSyncReconcilerProbeChanged(
      agent.syncReconcilerBackoff.get(PEER_A),
      probeB,
    )).toBe(true);
  });

  it.each([
    ['defer then clear', true],
    ['clear then defer', false],
  ])('preserves direct reducer defer precedence for %s', async (_scenario, selectedDefers) => {
    const agent = await createUnstartedAgent(
      selectedDefers ? 'Rfc64PeerJobDeferClear' : 'Rfc64PeerJobClearDefer',
    );
    allowAllNetworkAdmission(agent);
    agent.started = true;
    agent.getSyncReconcilerProbe = async () => ({
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });
    agent.trySelectedSwmRetryFromPeer = async (_peerId, onSyncAccounting) => {
      onSyncAccounting?.(selectedDefers
        ? { reconcilerDisposition: 'defer', fresh: false, progress: true }
        : { reconcilerDisposition: 'clear', fresh: true, progress: false });
      return 'synced';
    };
    agent.trySyncFromPeer = async (_peerId, onSyncAccounting) => {
      onSyncAccounting?.(selectedDefers
        ? { reconcilerDisposition: 'clear', fresh: true, progress: false }
        : { reconcilerDisposition: 'defer', fresh: false, progress: true });
      return 'synced';
    };
    const applyJobAccounting = vi.spyOn(agent, 'applySyncOnConnectAccounting');
    const runner = agent.createSyncOnConnectPeerJobRunner(PEER_A);

    await runner.runSelected();
    await runner.runOrdinary();
    runner.finish();

    expect(agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER_A)).toBe(false);
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
  });

  it('discards accumulated accounting when an active peer job is cleared', async () => {
    const agent = await createUnstartedAgent('Rfc64CancelledPeerJobAccounting');
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
    let releaseOrdinary!: () => void;
    let markOrdinaryStarted!: () => void;
    const ordinaryRelease = new Promise<void>((resolve) => { releaseOrdinary = resolve; });
    const ordinaryStarted = new Promise<void>((resolve) => { markOrdinaryStarted = resolve; });
    agent.trySyncFromPeer = async (_peerId, onSyncAccounting) => {
      markOrdinaryStarted();
      await ordinaryRelease;
      onSyncAccounting?.({
        reconcilerDisposition: 'clear',
        fresh: true,
        progress: true,
      });
      return 'synced';
    };
    let releaseSelected!: () => void;
    let markSelectedStarted!: () => void;
    const selectedRelease = new Promise<void>((resolve) => { releaseSelected = resolve; });
    const selectedStarted = new Promise<void>((resolve) => { markSelectedStarted = resolve; });
    agent.trySelectedSwmRetryFromPeer = async () => {
      markSelectedStarted();
      await selectedRelease;
      return 'deferred-backpressure';
    };
    const authorized = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: PEER_A,
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    const applyJobAccounting = vi.spyOn(agent, 'applySyncOnConnectAccounting');

    expect(agent.queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(true);
    await ordinaryStarted;
    expect(agent.queueRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      () => undefined,
      0,
    )).toBe(true);
    releaseOrdinary();
    await selectedStarted;

    agent.lastSuccessfulSyncAt.set(PEER_A, 1);
    agent.lastSyncProgressAt.set(PEER_A, 1);
    agent.syncReconcilerBackoff.set(PEER_A, {
      failures: 4,
      nextRetryAt: Date.now() + 60_000,
      protocolsKey: PROTOCOL_SYNC,
      connectionKey: null,
    });
    agent.clearNetworkRejectedPeerState(PEER_A);
    releaseSelected();
    await flushTimers();

    expect(applyJobAccounting).not.toHaveBeenCalled();
    expect(agent.lastSuccessfulSyncAt.has(PEER_A)).toBe(false);
    expect(agent.lastSyncProgressAt.has(PEER_A)).toBe(false);
    expect(agent.syncReconcilerBackoff.has(PEER_A)).toBe(false);
  });
});

describe('sync-on-connect structured attempt accounting', () => {
  it('turns callback-free success into one explicit retry result', async () => {
    await expect(captureSyncOnConnectAttempt(async () => 'synced')).resolves.toEqual({
      outcome: 'synced',
      accounting: {
        reconcilerDisposition: 'retry',
        fresh: false,
        progress: false,
      },
    });
  });

  it('carries explicit retry accounting in the terminal result', async () => {
    const result = await captureSyncOnConnectAttempt(async (recordAccounting) => {
      recordAccounting({
        reconcilerDisposition: 'retry',
        fresh: false,
        progress: true,
      });
      return 'synced';
    });
    const recordAccounting = vi.fn();

    await expect(executeSyncOnConnectAttempt(async () => result, {
      recordAccounting,
      onBackpressure: vi.fn(),
    })).resolves.toBe('synced');
    expect(recordAccounting).toHaveBeenCalledOnce();
    expect(recordAccounting).toHaveBeenCalledWith({
      reconcilerDisposition: 'retry',
      fresh: false,
      progress: true,
    });
  });

  it('normalizes local backpressure without inventing retry accounting', async () => {
    const recordAccounting = vi.fn();
    const onBackpressure = vi.fn();

    await expect(executeSyncOnConnectAttempt(async () => {
      throw new SyncBackpressureBusyError('sync queue full');
    }, {
      recordAccounting,
      onBackpressure,
    })).resolves.toBe('deferred-backpressure');
    expect(recordAccounting).not.toHaveBeenCalled();
    expect(onBackpressure).toHaveBeenCalledWith('sync queue full');
  });

  it('keeps thrown post-sync retry eligibility in the structured policy', async () => {
    const nonRetryable = new SyncOnConnectPostSyncError(
      'peer-a',
      new Error('discovery failed'),
      { backoffEligible: false },
    );
    const retryable = new SyncOnConnectPostSyncError(
      'peer-a',
      new Error('shared memory failed'),
      { backoffEligible: true },
    );
    const recordNonRetryable = vi.fn();
    const recordRetryable = vi.fn();

    await expect(executeSyncOnConnectAttempt(async () => {
      throw nonRetryable;
    }, {
      recordAccounting: recordNonRetryable,
      onBackpressure: vi.fn(),
    })).rejects.toBe(nonRetryable);
    expect(recordNonRetryable).not.toHaveBeenCalled();

    await expect(executeSyncOnConnectAttempt(async () => {
      throw retryable;
    }, {
      recordAccounting: recordRetryable,
      onBackpressure: vi.fn(),
    })).rejects.toBe(retryable);
    expect(recordRetryable).toHaveBeenCalledWith({
      reconcilerDisposition: 'retry',
      fresh: false,
      progress: false,
    });
  });
});
