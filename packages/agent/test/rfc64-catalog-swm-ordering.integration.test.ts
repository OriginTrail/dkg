import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROTOCOL_SYNC,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/index.js';
import {
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
} from '../src/rfc64/open-catalog-policy-v1.js';
import type { Rfc64SwmRecoveryTargetV1 } from '../src/rfc64/swm-recovery-plan-v1.js';

const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/native-wiring' as ContextGraphIdV1;
const AUTHOR = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const NATIVE_DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

function emptySyncResult(overrides: Record<string, number | boolean> = {}) {
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

interface Rfc64SyncAgentSeam {
  readonly rfc64SwmRecoveryCoordinatorV1: object;
  readonly networkAdmissionCoordinator: {
    isAcceptedPeer: (peerId: string) => boolean;
    isRejectedPeer: (peerId: string) => boolean;
    ensureAdmitted: (peerId: string) => Promise<boolean>;
  };
  getPeerProtocols: (peerId: string) => Promise<string[]>;
  planSharedMemorySyncContextGraphs: (
    peerId: string,
    contextGraphIds: readonly string[],
  ) => Promise<{ readonly targets: readonly Rfc64SwmRecoveryTargetV1[] }>;
  refreshMetaSyncedFlags: (contextGraphIds: Iterable<string>) => Promise<void>;
  discoverContextGraphsFromStore: () => Promise<number>;
  syncSharedMemoryFromPeerDetailed: (...args: readonly unknown[]) => Promise<unknown>;
  syncSelectedSharedMemoryFromPeerDetailed: (...args: readonly unknown[]) => Promise<unknown>;
  attemptSyncFromPeerWithReconcilerAccounting: (
    peerId: string,
    probe: Readonly<{ protocolsKey: string; connectionKey: null }>,
    source: 'reconcile',
  ) => Promise<string>;
}

/** Typed boundary for the private lifecycle seams needed by this integration test. */
class Rfc64CatalogSwmOrderingHarness {
  private readonly seam: Rfc64SyncAgentSeam;

  constructor(readonly agent: DKGAgent) {
    this.seam = agent as unknown as Rfc64SyncAgentSeam;
  }

  get coordinator(): object {
    return this.seam.rfc64SwmRecoveryCoordinatorV1;
  }

  allowNetworkAdmission(): void {
    this.seam.networkAdmissionCoordinator.isAcceptedPeer = () => true;
    this.seam.networkAdmissionCoordinator.isRejectedPeer = () => false;
    this.seam.networkAdmissionCoordinator.ensureAdmitted = async () => true;
  }

  installPlanning(targets: readonly Rfc64SwmRecoveryTargetV1[]): void {
    this.seam.getPeerProtocols = async () => [PROTOCOL_SYNC];
    this.seam.planSharedMemorySyncContextGraphs = async () => ({ targets });
    this.seam.refreshMetaSyncedFlags = async () => undefined;
    this.seam.discoverContextGraphsFromStore = async () => 0;
  }

  installSyncLanes(
    ordinary: (...args: readonly unknown[]) => Promise<unknown>,
    selected: (...args: readonly unknown[]) => Promise<unknown>,
  ): void {
    this.seam.syncSharedMemoryFromPeerDetailed = ordinary;
    this.seam.syncSelectedSharedMemoryFromPeerDetailed = selected;
  }

  tryReconcile(peerId: string): Promise<string> {
    return this.seam.attemptSyncFromPeerWithReconcilerAccounting(
      peerId,
      { protocolsKey: PROTOCOL_SYNC, connectionKey: null },
      'reconcile',
    );
  }
}

const agents: DKGAgent[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.stop()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('RFC-64 catalog and SWM ordering', () => {
  it('uses the real coordinator to gate selected SWM while ordinary sync remains live', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-real-coordinator-gate-'));
    tempDirs.push(dataDir);
    const providerPeerId = '12D3KooWRealCoordinatorProvider';
    const receiver = await DKGAgent.create({
      name: 'real-coordinator-gate-receiver',
      dataDir,
      listenHost: '127.0.0.1',
      listenPort: 0,
      bootstrapPeers: [],
      store: new OxigraphStore(),
      syncOnConnectEnabled: true,
      syncSharedMemoryOnConnect: true,
      syncReconcilerEnabled: false,
      syncContextGraphs: [CONTEXT_GRAPH_ID],
      agentProfileHeartbeatMs: 0,
      rfc64CatalogDeploymentProfile: NATIVE_DEPLOYMENT,
      rfc64PublicCatalogBootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
          targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
          completeSwmProviders: [providerPeerId],
        }],
      },
    });
    agents.push(receiver);
    const harness = new Rfc64CatalogSwmOrderingHarness(receiver);
    const realCoordinator = harness.coordinator;
    harness.allowNetworkAdmission();
    vi.spyOn(receiver, 'connectToPeerId').mockResolvedValue();
    let markCatalogStarted!: () => void;
    let releaseCatalog!: () => void;
    const catalogStarted = new Promise<void>((resolve) => { markCatalogStarted = resolve; });
    const catalogRelease = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    vi.spyOn(receiver, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
      .mockImplementation(async ({ signal }) => {
        markCatalogStarted();
        await Promise.race([
          catalogRelease,
          new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
        return null;
      });
    vi.spyOn(receiver, 'queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect')
      .mockReturnValue(true);
    harness.installPlanning([
      { contextGraphId: CONTEXT_GRAPH_ID, lane: 'selected-public' },
      { contextGraphId: 'ordinary-private-cg', lane: 'ordinary-private' },
    ]);
    const ordinarySync = vi.fn(async () => emptySyncResult({ completedPhases: 1 }));
    const selectedSync = vi.fn(async (
      _peerId: unknown,
      _contextGraphIds: unknown,
      options: { requestedScope: unknown },
    ) => ({
      kind: 'selected-shared-memory' as const,
      requestedScope: options.requestedScope,
      shared: emptySyncResult({ completedPhases: 1 }),
      scopeComplete: true,
      targetDiagnostics: {
        selectedPublic: { completed: 1, total: 1 },
        ordinaryPrivate: { completed: 0, total: 0 },
      },
    }));
    harness.installSyncLanes(ordinarySync, selectedSync);

    await receiver.start();
    receiver.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await catalogStarted;
    harness.allowNetworkAdmission();
    expect(harness.coordinator).toBe(realCoordinator);
    expect(await harness.tryReconcile(providerPeerId)).toBe('synced');
    expect(selectedSync).not.toHaveBeenCalled();
    expect(ordinarySync).toHaveBeenCalledWith(
      providerPeerId,
      ['ordinary-private-cg'],
      expect.any(Object),
    );

    releaseCatalog();
    await receiver.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(receiver.isRfc64CatalogBootstrapSwmRecoveryReadyV1(providerPeerId)).toBe(true);
    expect(await harness.tryReconcile(providerPeerId)).toBe('synced');
    expect(selectedSync).toHaveBeenCalledWith(
      providerPeerId,
      [CONTEXT_GRAPH_ID],
      expect.any(Object),
    );
    expect(ordinarySync).toHaveBeenCalledTimes(2);
  });
});
