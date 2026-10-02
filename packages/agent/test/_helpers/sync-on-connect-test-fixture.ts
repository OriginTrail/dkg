import { PeerSyncSession } from '../../src/sync/peer-sync-session.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { PeerSyncSessionTestDriver } from './peer-sync-session-driver.js';

import { DKGAgent, type DKGAgentConfig } from '../../src/index.js';
import type { ContextGraphSub } from '../../src/dkg-agent-types.js';
import type { Rfc64SwmRecoveryCoordinatorV1 } from '../../src/rfc64/swm-recovery-coordinator-v1.js';
import type { Rfc64SwmRecoveryRuntimeV1 } from '../../src/dkg-agent-rfc64-swm-recovery-runtime.js';
import type { Rfc64AuthorizedSwmRecoveryPlanV1 } from '../../src/rfc64/swm-recovery-plan-v1.js';
import type { SelectedSwmBootstrapAdmission } from '../../src/sync/selected-swm-bootstrap-admission.js';
import {
  type SyncOnConnectPeerJobRunner,
  type SyncOnConnectPeerSchedulerCallbacks,
} from '../../src/sync/on-connect/peer-scheduler.js';

type Rfc64CoordinatorTestPort = Pick<
  Rfc64SwmRecoveryCoordinatorV1,
  'admitSelectedPublic' | 'authorize' | 'authorizeForCatalogPass' | 'revalidate'
>;

interface SyncOnConnectPrivateSeam {
  started: boolean;
  peerSyncSession: PeerSyncSession;
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
  lastSyncDisconnectedAt: Map<string, number>;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  selectedSwmBootstrapAdmission: SelectedSwmBootstrapAdmission;
  rfc64SwmRecoveryRuntimeV1: Rfc64SwmRecoveryRuntimeV1;
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

export function createSyncOnConnectPeerJobRunnerForTest(
  agent: SyncOnConnectTestAgent,
  remotePeer: string,
): SyncOnConnectPeerJobRunner<Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>> {
  const internalAgent = agent as unknown as {
    createSyncOnConnectPeerJobRunner: (
      peerId: string,
    ) => SyncOnConnectPeerJobRunner<Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>>;
  };
  return internalAgent.createSyncOnConnectPeerJobRunner(remotePeer);
}

/** Open a production-shaped peer-sync session for tests that bypass start(). */
export function resetPeerSyncSessionForTest(
  agent: SyncOnConnectTestAgent,
): PeerSyncSession {
  const internalAgent = agent as unknown as {
    createSyncOnConnectPeerJobRunner: (
      peerId: string,
      options?: Record<string, never>,
      session?: PeerSyncSession,
    ) => SyncOnConnectPeerJobRunner<Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>>;
  };
  const session = new PeerSyncSession({
    createJob: (remotePeer, owningSession) => internalAgent.createSyncOnConnectPeerJobRunner(
      remotePeer,
      {},
      owningSession,
    ),
    onInternalError: () => undefined,
  });
  agent.peerSyncSession.close();
  agent.peerSyncSession = session;
  return session;
}

/** Behavioral seam for seeding and inspecting peer-sync state in tests. */
export function peerSyncSessionDriver(
  agent: SyncOnConnectTestAgent,
): PeerSyncSessionTestDriver {
  return new PeerSyncSessionTestDriver(() => agent.peerSyncSession);
}

/** Install scheduler behavior when a fresh, unseeded test session is constructed. */
export function installPeerSyncSessionSchedulerForTest(
  agent: SyncOnConnectTestAgent,
  callbacks: SyncOnConnectPeerSchedulerCallbacks<Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>>,
): PeerSyncSession {
  const previous = agent.peerSyncSession;
  const session = new PeerSyncSession(callbacks);
  previous.close();
  agent.peerSyncSession = session;
  return session;
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
  installPeerSyncSessionSchedulerForTest(agent, {
    createJob: (remotePeer) => ({
      runAutomaticSelectedThenOrdinary: async () => {
        await callbacks.runOrdinary?.(remotePeer);
        return 'not-started' as const;
      },
      runSelected: async (recoveryPlan) => {
        await callbacks.runSelected?.(remotePeer, recoveryPlan);
        return 'not-started' as const;
      },
      cancel: () => { callbacks.cancel?.(remotePeer); },
      finish: () => { callbacks.finish?.(remotePeer); },
    }),
    onInternalError: () => undefined,
  });
}

export async function createUnstartedAgent(
  name: string,
  overrides: Partial<DKGAgentConfig> = {},
): Promise<SyncOnConnectTestAgent> {
  const agent = asSyncOnConnectTestAgent(await DKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(),
    ...overrides,
  }));
  // These orchestration fixtures explicitly open a session without networking.
  resetPeerSyncSessionForTest(agent);
  return agent;
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
