import { MockChainAdapter } from '@origintrail-official/dkg-chain';

import { DKGAgent, type DKGAgentConfig } from '../../src/index.js';

// Lifecycle tests need to replace private collaborators deliberately. Keep the
// unchecked function shape confined to this one named seam so test files still
// get checked property names and share one fixture contract.
type TestHook = (...args: any[]) => any;

interface TestBackoffState {
  failures: number;
  nextRetryAt: number;
}

interface TestBackoffMap {
  get(peerId: string): TestBackoffState;
  set(peerId: string, value: TestBackoffState): TestBackoffMap;
  has(peerId: string): boolean;
  delete(peerId: string): boolean;
}

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
  syncReconcilerBackoff: TestBackoffMap;
  subscribedContextGraphs: Map<string, Record<string, unknown>>;
  selectedSwmBootstrapAdmission: {
    readonly size: number;
    request: TestHook;
    isRetryRequired: TestHook;
    beginTransfer: TestHook;
    markTransferTerminal: TestHook;
    snapshot: TestHook;
  };
  syncOnConnectPeerScheduler: {
    readonly size: number;
    has: (peerId: string) => boolean;
  };
  rfc64SwmRecoveryCoordinatorV1: {
    authorize?: TestHook;
    authorizeForCatalogPass?: TestHook;
    revalidate?: TestHook;
    admitSelectedPublic?: TestHook;
  };
  attemptSelectedSwmRetryWithReconcilerAccounting: TestHook;
  attemptSyncFromPeerWithReconcilerAccounting: TestHook;
  canUseSharedMemoryForContextGraph: TestHook;
  clearNetworkRejectedPeerState: TestHook;
  discoverContextGraphsFromStore: TestHook;
  getPeerProtocols: TestHook;
  getSharedMemorySyncContextGraphs: TestHook;
  getSyncReconcilerProbe: TestHook;
  isCuratorOf: TestHook;
  isPrivateContextGraph: TestHook;
  persistLocalNodeMembership: TestHook;
  planSharedMemorySyncContextGraphs: TestHook;
  queueRfc64SwmRecoveryPlanFromPeerOnConnect: TestHook;
  queueSelectedSwmFromPeerOnConnect: TestHook;
  queueSyncFromPeerOnConnect: TestHook;
  reconcileSyncFromConnectedPeers: TestHook;
  recoverContextGraphSwmFromPeer: TestHook;
  refreshMetaFromCurator: TestHook;
  refreshMetaSyncedFlags: TestHook;
  resolveCuratorPeerId: TestHook;
  resolveRfc64CompleteSwmProviderPeerIdsV1: TestHook;
  runCatchupOverPeers: TestHook;
  runSelectedSwmRetryFromPeerOnConnect: TestHook;
  runSyncFromPeerOnConnect: TestHook;
  selectedSwmBootstrapContextGraphIdsForPeer: TestHook;
  syncFromPeerDetailed: TestHook;
  syncSelectedSharedMemoryFromPeerDetailed: TestHook;
  syncSharedMemoryFromPeerDetailed: TestHook;
  trySelectedSwmRetryFromPeer: TestHook;
  trySyncFromPeer: TestHook;
  waitForSyncProtocol: TestHook;
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
