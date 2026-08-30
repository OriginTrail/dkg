import { MockChainAdapter } from '@origintrail-official/dkg-chain';

import { DKGAgent, type DKGAgentConfig } from '../../src/index.js';
import type { ContextGraphSub, SyncReconcilerBackoff } from '../../src/dkg-agent-types.js';
import type { Rfc64SwmRecoveryCoordinatorV1 } from '../../src/rfc64/swm-recovery-coordinator-v1.js';
import type { Rfc64AuthorizedSwmRecoveryPlanV1 } from '../../src/rfc64/swm-recovery-plan-v1.js';
import type { SelectedSwmBootstrapAdmission } from '../../src/sync/selected-swm-bootstrap-admission.js';
import type { SyncOnConnectPeerScheduler } from '../../src/sync/on-connect/peer-scheduler.js';

type Rfc64CoordinatorTestPort = Pick<
  Rfc64SwmRecoveryCoordinatorV1,
  'admitSelectedPublic' | 'authorize' | 'authorizeForCatalogPass' | 'revalidate'
>;

interface SyncOnConnectPrivateSeam {
  started: boolean;
  config: DKGAgentConfig;
  node: {
    node: {
      getPeers: () => Array<{ toString: () => string }>;
      getConnections: () => unknown[];
    };
  };
  networkAdmissionCoordinator: {
    isAcceptedPeer: (peerId: string) => boolean;
    isRejectedPeer: (peerId: string) => boolean;
    ensureAdmitted: (peerId: string) => Promise<boolean>;
  };
  catchupOnConnectAt: Map<string, number>;
  rfc64ExactCatchupOnConnectAt: Map<string, number>;
  lastSuccessfulSyncAt: Map<string, number>;
  lastSyncDisconnectedAt: Map<string, number>;
  lastSyncProgressAt: Map<string, number>;
  syncReconcilerBackoff: Map<string, SyncReconcilerBackoff>;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  selectedSwmBootstrapAdmission: SelectedSwmBootstrapAdmission;
  syncOnConnectPeerScheduler: SyncOnConnectPeerScheduler<
    Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>
  >;
  rfc64SwmRecoveryCoordinatorV1: Rfc64CoordinatorTestPort;
}

type PublicDKGAgent = Pick<DKGAgent, keyof DKGAgent>;

export type SyncOnConnectTestAgent = Omit<
  PublicDKGAgent,
  keyof SyncOnConnectPrivateSeam
> & SyncOnConnectPrivateSeam;

/** The only cast boundary for private sync-on-connect lifecycle collaborators. */
export function asSyncOnConnectTestAgent(agent: DKGAgent): SyncOnConnectTestAgent {
  return agent as unknown as SyncOnConnectTestAgent;
}

export function createRfc64CoordinatorStub(
  overrides: Partial<Rfc64CoordinatorTestPort> = {},
): Rfc64CoordinatorTestPort {
  return {
    admitSelectedPublic: () => false,
    authorize: () => null,
    authorizeForCatalogPass: () => null,
    revalidate: (authorized) => authorized,
    ...overrides,
  };
}

export function installSyncOnConnectPeerJobStub(
  agent: SyncOnConnectTestAgent,
  callbacks: Readonly<{
    runOrdinary?: (
      remotePeer: string,
    ) => Promise<void>;
    runSelected?: (
      remotePeer: string,
      recoveryPlan?: Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>,
    ) => Promise<void>;
    cancel?: (remotePeer: string) => void;
    finish?: (remotePeer: string) => void;
  }>,
): void {
  agent.createSyncOnConnectPeerJobRunner = (remotePeer) => ({
    runOrdinary: async () => {
      await callbacks.runOrdinary?.(remotePeer);
      return 'not-started' as const;
    },
    runSelected: async (recoveryPlan) => {
      await callbacks.runSelected?.(remotePeer, recoveryPlan);
      return 'not-started' as const;
    },
    cancel: () => { callbacks.cancel?.(remotePeer); },
    finish: () => { callbacks.finish?.(remotePeer); },
  });
}

export async function createUnstartedAgent(
  name: string,
  overrides: Partial<DKGAgentConfig> = {},
): Promise<SyncOnConnectTestAgent> {
  return asSyncOnConnectTestAgent(await DKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(),
    ...overrides,
  }));
}

export function allowAllNetworkAdmission(agent: SyncOnConnectTestAgent): void {
  agent.networkAdmissionCoordinator.isAcceptedPeer = () => true;
  agent.networkAdmissionCoordinator.isRejectedPeer = () => false;
  agent.networkAdmissionCoordinator.ensureAdmitted = async () => true;
}

export function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

export async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

export function emptyDetailedSync(overrides: Record<string, number | boolean> = {}) {
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
