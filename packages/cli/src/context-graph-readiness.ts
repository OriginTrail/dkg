import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import type {
  ContextGraphReadinessProvenance,
  DashboardDB,
} from '@origintrail-official/dkg-node-ui';
import {
  catchupPlaneCompletedWithoutFailure,
  type CatchupJobResult,
} from './catchup-runner.js';

export { catchupPlaneCompletedWithoutFailure } from './catchup-runner.js';

export const CONTEXT_GRAPH_READINESS_VERSION = 1;

export type ContextGraphReadinessStore = Pick<
  DashboardDB,
  'getContextGraphReadinessProvenance' | 'setContextGraphReadinessProvenance'
>;

export interface ContextGraphSubscriptionReadinessState {
  synced?: boolean;
  sharedMemorySynced?: boolean;
  metaSynced?: boolean;
  pendingMeta?: boolean;
}

export interface ContextGraphSubscriptionStatePatch {
  synced: boolean;
  sharedMemorySynced: boolean;
  metaSynced: boolean;
  pendingMeta: boolean;
}

export interface ContextGraphReadinessPatch {
  durableVerified: boolean;
  sharedMemoryVerified: boolean;
}

export function classifyExistingContextGraphReadiness(input: {
  subscription: ContextGraphSubscriptionReadinessState;
  readiness: ContextGraphReadinessProvenance;
  includeSharedMemory: boolean;
  hasConfirmedMeta: boolean;
}): {
  alreadyReady: boolean;
  statePatch?: ContextGraphSubscriptionStatePatch;
  readinessPatch?: ContextGraphReadinessPatch;
} {
  const currentReadinessProvenance =
    input.readiness.version >= CONTEXT_GRAPH_READINESS_VERSION;
  const overallReadinessVerified =
    input.readiness.durableVerified || input.readiness.sharedMemoryVerified;
  const requestedPlanesVerified =
    currentReadinessProvenance &&
    overallReadinessVerified &&
    (!input.includeSharedMemory || input.readiness.sharedMemoryVerified);
  const alreadyReady =
    input.hasConfirmedMeta &&
    requestedPlanesVerified &&
    input.subscription.synced === true &&
    (!input.includeSharedMemory || input.subscription.sharedMemorySynced === true);

  if (alreadyReady) return { alreadyReady: true };

  if (
    !input.hasConfirmedMeta &&
    (input.subscription.metaSynced ||
      input.subscription.synced ||
      input.subscription.sharedMemorySynced)
  ) {
    return {
      alreadyReady: false,
      statePatch: {
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        pendingMeta: true,
      },
      readinessPatch: {
        durableVerified: false,
        sharedMemoryVerified: false,
      },
    };
  }

  if (!input.hasConfirmedMeta) return { alreadyReady: false };

  const durableVerified =
    currentReadinessProvenance && input.readiness.durableVerified;
  const sharedMemoryVerified =
    currentReadinessProvenance && input.readiness.sharedMemoryVerified;
  const overallVerified = durableVerified || sharedMemoryVerified;
  const statePatch =
    input.subscription.synced !== overallVerified ||
    input.subscription.sharedMemorySynced !== sharedMemoryVerified
      ? {
          synced: overallVerified,
          sharedMemorySynced: sharedMemoryVerified,
          metaSynced: true,
          pendingMeta: false,
        }
      : undefined;

  return {
    alreadyReady: false,
    statePatch,
    readinessPatch: currentReadinessProvenance
      ? undefined
      : {
          durableVerified: false,
          sharedMemoryVerified: false,
        },
  };
}

function catchupServedUsableData(result: CatchupJobResult): boolean {
  return result.dataSynced > 0 || result.sharedMemorySynced > 0;
}

function cleanCompletionHasResponse(
  completion: { verifiedDataPeers: number; emptyPeers: number } | undefined,
): boolean {
  return (completion?.verifiedDataPeers ?? 0) > 0 ||
    (completion?.emptyPeers ?? 0) > 0;
}

function catchupHasRequestedCleanPeerResponse(
  result: CatchupJobResult,
  includeSharedMemory: boolean,
): boolean {
  return cleanCompletionHasResponse(result.cleanPlaneCompletions?.durable) ||
    (
      includeSharedMemory &&
      cleanCompletionHasResponse(result.cleanPlaneCompletions?.sharedMemory)
    );
}

export function catchupResultHasCleanResponse(result: CatchupJobResult): boolean {
  const durable = result.diagnostics?.durable;
  const sharedMemory = result.diagnostics?.sharedMemory;
  const peerReturnedMetadata =
    (durable?.metaOnlyResponses ?? 0) > 0 ||
    (durable?.fetchedMetaTriples ?? 0) > 0 ||
    (sharedMemory?.fetchedMetaTriples ?? 0) > 0;

  return cleanCompletionHasResponse(result.cleanPlaneCompletions?.durable) ||
    cleanCompletionHasResponse(result.cleanPlaneCompletions?.sharedMemory) ||
    catchupServedUsableData(result) ||
    (durable?.emptyResponses ?? 0) > 0 ||
    (sharedMemory?.emptyResponses ?? 0) > 0 ||
    (!result.denied && peerReturnedMetadata);
}

function catchupPlaneReadyThisRun(input: {
  result: CatchupJobResult;
  plane: 'durable' | 'sharedMemory';
  isPrivate: boolean;
}): boolean {
  const completion = input.result.cleanPlaneCompletions?.[input.plane];
  if (completion) {
    return completion.verifiedDataPeers > 0 ||
      (!input.isPrivate && completion.emptyPeers > 0);
  }

  // Backward compatibility for callers that construct a legacy result (for
  // example, an older in-process runner during a rolling upgrade). New worker
  // results always carry cleanPlaneCompletions, so aggregate failures are not
  // used as readiness evidence on the production path.
  const diagnostics = input.result.diagnostics?.[input.plane];
  const dataProgress = input.plane === 'durable'
    ? input.result.dataSynced > 0
    : input.result.sharedMemorySynced > 0;
  return catchupPlaneCompletedWithoutFailure(diagnostics) &&
    (dataProgress || (!input.isPrivate && (diagnostics?.emptyResponses ?? 0) > 0));
}

export interface ContextGraphCatchupReadinessClassification {
  jobStatus: 'done' | 'failed' | 'denied' | 'unreachable';
  error?: string;
  statePatch?: ContextGraphSubscriptionStatePatch;
  readinessPatch?: ContextGraphReadinessPatch;
  eventPayload?: {
    dataSynced: number;
    sharedMemorySynced: number;
  };
}

/**
 * Canonical policy for converting one catch-up result into externally visible
 * subscription readiness. The HTTP route gathers live metadata and applies
 * the returned patches; all readiness decisions remain in this pure function.
 */
export function classifyContextGraphCatchupReadiness(input: {
  result: CatchupJobResult;
  includeSharedMemory: boolean;
  hasConfirmedMeta: boolean;
  isPrivate: boolean;
  readinessBeforeCatchup: ContextGraphReadinessProvenance;
}): ContextGraphCatchupReadinessClassification {
  const { result } = input;
  const durableDataProgress = result.dataSynced > 0;
  const sharedMemoryProgress = result.sharedMemorySynced > 0;
  const servedUsableData = durableDataProgress || sharedMemoryProgress;
  const totalConnectedPeers = result.totalPeers ?? result.connectedPeers;
  const selectedConnectedPeers = result.selectedPeers ?? result.connectedPeers;
  const hasRequestedCleanPeerResponse = catchupHasRequestedCleanPeerResponse(
    result,
    input.includeSharedMemory,
  );

  if (result.denied && !servedUsableData && !hasRequestedCleanPeerResponse) {
    return {
      jobStatus: 'denied',
      error: result.deniedPeers > 1
        ? `Sync denied by ${result.deniedPeers} remote peers`
        : 'Sync denied by remote peer',
    };
  }

  if (catchupResultHasCleanResponse(result)) {
    if (!input.hasConfirmedMeta) {
      return {
        jobStatus: 'unreachable',
        error: 'No peer delivered authoritative context-graph metadata — the curator may be offline, or responding peers do not host this project.',
        statePatch: {
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
          pendingMeta: true,
        },
        readinessPatch: {
          durableVerified: false,
          sharedMemoryVerified: false,
        },
      };
    }

    const durableReadyThisRun = catchupPlaneReadyThisRun({
      result,
      plane: 'durable',
      isPrivate: input.isPrivate,
    });
    const sharedMemoryReadyThisRun = input.includeSharedMemory &&
      catchupPlaneReadyThisRun({
        result,
        plane: 'sharedMemory',
        isPrivate: input.isPrivate,
      });
    const currentReadinessProvenance =
      input.readinessBeforeCatchup.version >= CONTEXT_GRAPH_READINESS_VERSION;
    const durableVerified =
      (currentReadinessProvenance && input.readinessBeforeCatchup.durableVerified) ||
      durableReadyThisRun;
    const sharedMemoryVerified =
      (currentReadinessProvenance && input.readinessBeforeCatchup.sharedMemoryVerified) ||
      sharedMemoryReadyThisRun;
    const overallVerified = durableVerified || sharedMemoryVerified;
    const missingGraphProof = !overallVerified;
    const missingRequestedSharedMemory =
      input.includeSharedMemory && !sharedMemoryVerified;
    const madeIncompleteProgress =
      (durableDataProgress && !durableReadyThisRun) ||
      (sharedMemoryProgress && !sharedMemoryReadyThisRun);

    let jobStatus: ContextGraphCatchupReadinessClassification['jobStatus'] = 'done';
    let error: string | undefined;
    if (missingGraphProof || missingRequestedSharedMemory) {
      jobStatus = 'unreachable';
      if (madeIncompleteProgress) {
        error = 'Verified data was inserted, but catch-up did not complete without a timeout or failed phase. The incomplete plane remains unready; retry once the network is healthier.';
      } else if (input.isPrivate && missingGraphProof) {
        error = 'No authorized context-graph peer delivered verified durable or shared-memory data — empty or metadata-only responses cannot prove a private graph is fully synchronized, and the curator may be offline.';
      } else if (input.isPrivate) {
        error = 'Durable context-graph data synchronized, but shared-memory catch-up did not complete. Retry to finish shared-memory synchronization.';
      } else {
        error = 'Context-graph catch-up did not complete cleanly for every requested data plane. Retry once the network is healthier.';
      }
    }

    return {
      jobStatus,
      error,
      statePatch: {
        synced: overallVerified,
        sharedMemorySynced: sharedMemoryVerified,
        metaSynced: true,
        pendingMeta: false,
      },
      readinessPatch: {
        durableVerified,
        sharedMemoryVerified,
      },
      eventPayload: durableReadyThisRun || sharedMemoryReadyThisRun
        ? {
            dataSynced: durableReadyThisRun ? result.dataSynced : 0,
            sharedMemorySynced: sharedMemoryReadyThisRun
              ? result.sharedMemorySynced
              : 0,
          }
        : undefined,
    };
  }

  if (result.peersTried > 0 && (result.peersResponded ?? result.peersSucceeded) === 0) {
    return {
      jobStatus: 'unreachable',
      error: "No peer could deliver this project's data — the curator may be offline, or no node currently holds the data. You can still send a signed join request; they will receive it next time they come online.",
    };
  }
  if (result.peersTried > 0) {
    return {
      jobStatus: 'failed',
      error: 'Sync did not complete — all reachable peers failed (timeouts or transport errors). Retry once the network is healthier.',
    };
  }
  if (
    totalConnectedPeers > 0 &&
    selectedConnectedPeers >= totalConnectedPeers &&
    result.syncCapablePeers === 0
  ) {
    return {
      jobStatus: 'unreachable',
      error: 'No sync-capable peers found for catch-up — the curator may be offline.',
    };
  }
  if (totalConnectedPeers === 0) {
    return {
      jobStatus: 'unreachable',
      error: "No peers connected — couldn't reach the curator. They may be offline, or your node hasn't bootstrapped to the network yet.",
    };
  }

  return { jobStatus: 'done' };
}

export function readContextGraphReadiness(
  store: Partial<ContextGraphReadinessStore>,
  contextGraphId: string,
): ContextGraphReadinessProvenance {
  const stored = store.getContextGraphReadinessProvenance?.(contextGraphId);
  return stored ?? {
    version: 0,
    durableVerified: false,
    sharedMemoryVerified: false,
    updatedAt: 0,
  };
}

export function writeContextGraphReadiness(
  store: Partial<ContextGraphReadinessStore>,
  contextGraphId: string,
  readiness: Pick<ContextGraphReadinessProvenance, 'durableVerified' | 'sharedMemoryVerified'>,
): void {
  store.setContextGraphReadinessProvenance?.(contextGraphId, {
    version: CONTEXT_GRAPH_READINESS_VERSION,
    durableVerified: readiness.durableVerified,
    sharedMemoryVerified: readiness.sharedMemoryVerified,
  });
}

/**
 * One-time migration for subscription flags written before readiness carried
 * durable per-plane proof. Private/unconfirmed rows fail closed and must
 * complete a new catch-up. Confirmed public rows retain historical clean-empty
 * compatibility and receive provenance matching their already-persisted bits.
 */
export async function migrateLegacyContextGraphReadiness(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  log: (message: string) => void;
  durableJoinApprovedContextGraphIds?: ReadonlySet<string>;
}): Promise<void> {
  const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS));

  for (const [contextGraphId, subscription] of input.agent.getSubscribedContextGraphs()) {
    if (systemContextGraphs.has(contextGraphId)) continue;
    const stored = readContextGraphReadiness(input.store, contextGraphId);
    if (stored.version >= CONTEXT_GRAPH_READINESS_VERSION) continue;

    // Locally curated graphs and memberships admitted by the new durable
    // join-approved flow have an authoritative source for their persisted
    // readiness bits. Resetting either class would strand a curator's own
    // private graph, or throw away a clean post-approval recovery merely
    // because the daemon restarted before the HTTP route could observe it.
    const locallyCurated = typeof input.agent.isCuratorOf === 'function'
      ? await input.agent.isCuratorOf(contextGraphId).catch(() => false)
      : false;
    const durablyJoinApproved = input.durableJoinApprovedContextGraphIds?.has(contextGraphId) === true;
    if (locallyCurated || durablyJoinApproved) {
      writeContextGraphReadiness(input.store, contextGraphId, {
        durableVerified: subscription.synced === true,
        sharedMemoryVerified: subscription.sharedMemorySynced === true,
      });
      input.log(
        `Preserved ${locallyCurated ? 'locally curated' : 'durably join-approved'} ` +
        `context-graph readiness during provenance migration: ${contextGraphId}`,
      );
      continue;
    }

    const hasConfirmedMeta = await input.agent.hasConfirmedMetaState(contextGraphId)
      .catch(() => false);
    const locallyPrivate = hasConfirmedMeta
      ? await input.agent.isPrivateContextGraph(contextGraphId).catch(() => true)
      : true;
    const onChainPolicy = typeof input.agent.getContextGraphOnChainPolicy === 'function'
      ? await input.agent.getContextGraphOnChainPolicy(contextGraphId).catch(() => ({}))
      : {};
    const chainPrivate = (onChainPolicy as { accessPolicy?: number }).accessPolicy === 1;
    const confirmedPublic = !chainPrivate && hasConfirmedMeta && !locallyPrivate;

    if (confirmedPublic) {
      writeContextGraphReadiness(input.store, contextGraphId, {
        durableVerified: subscription.synced === true,
        sharedMemoryVerified: subscription.sharedMemorySynced === true,
      });
      input.log(`Preserved confirmed public context-graph readiness during provenance migration: ${contextGraphId}`);
      continue;
    }

    const authoritativePrivateMeta = hasConfirmedMeta && locallyPrivate;
    input.agent.markContextGraphSubscriptionState(contextGraphId, {
      synced: false,
      sharedMemorySynced: false,
      metaSynced: authoritativePrivateMeta,
      pendingMeta: !authoritativePrivateMeta,
    });
    writeContextGraphReadiness(input.store, contextGraphId, {
      durableVerified: false,
      sharedMemoryVerified: false,
    });
    input.log(`Reset legacy unproven context-graph readiness: ${contextGraphId}`);
  }
}
