import { describe, expect, it } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS } from '../src/dkg-agent-constants.js';
import {
  allowAllNetworkAdmission,
  createUnstartedAgent,
  emptyDetailedSync,
  flushTimers,
  installSyncOnConnectPeerJobStub,
  recorder,
} from './_helpers/sync-on-connect-test-fixture.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

describe('RFC-64 selected retry lifecycle', () => {
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
