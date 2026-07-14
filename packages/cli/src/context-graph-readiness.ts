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

  if (!input.hasConfirmedMeta) {
    const stateAlreadyFailClosed =
      input.subscription.synced === false &&
      input.subscription.sharedMemorySynced === false &&
      input.subscription.metaSynced === false &&
      input.subscription.pendingMeta === true;
    return {
      alreadyReady: false,
      statePatch: stateAlreadyFailClosed
        ? undefined
        : {
            synced: false,
            sharedMemorySynced: false,
            metaSynced: false,
            pendingMeta: true,
          },
      // Subscription flags and provenance are persisted independently. A
      // prior bootstrap may already have reset the flags while leaving v1
      // proof behind, so metadata absence must invalidate provenance even
      // when the visible state is already fail-closed.
      readinessPatch: {
        durableVerified: false,
        sharedMemoryVerified: false,
      },
    };
  }

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
 * Persist readiness proven by the agent's automatic post-approval catch-up.
 * PROJECT_SYNCED is also used as a UI event, so fail closed unless it carries
 * actual inserted data and the graph's authoritative metadata is present.
 */
export async function persistProjectSyncedReadiness(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
  dataSynced: number;
  sharedMemorySynced: number;
}): Promise<boolean> {
  const contextGraphId = input.contextGraphId.trim();
  const durableCompleted = Number.isFinite(input.dataSynced) && input.dataSynced > 0;
  const sharedMemoryCompleted = Number.isFinite(input.sharedMemorySynced) &&
    input.sharedMemorySynced > 0;
  if (
    !contextGraphId ||
    (!durableCompleted && !sharedMemoryCompleted) ||
    typeof input.store.setContextGraphReadinessProvenance !== 'function'
  ) return false;

  const hasConfirmedMeta = await input.agent.hasConfirmedMetaState(
    contextGraphId,
    { rejectUnregisteredPlaceholder: true },
  )
    .catch(() => false);
  if (!hasConfirmedMeta) return false;

  const current = readContextGraphReadiness(input.store, contextGraphId);
  const currentVersionVerified = current.version >= CONTEXT_GRAPH_READINESS_VERSION;
  writeContextGraphReadiness(input.store, contextGraphId, {
    durableVerified: durableCompleted ||
      (currentVersionVerified && current.durableVerified),
    sharedMemoryVerified: sharedMemoryCompleted ||
      (currentVersionVerified && current.sharedMemoryVerified),
  });
  return true;
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
}): Promise<void> {
  const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS));

  for (const [contextGraphId, subscription] of input.agent.getSubscribedContextGraphs()) {
    if (systemContextGraphs.has(contextGraphId)) continue;
    const stored = readContextGraphReadiness(input.store, contextGraphId);
    if (stored.version >= CONTEXT_GRAPH_READINESS_VERSION) continue;

    // A locally curated graph is authoritative on this node, so its existing
    // flags can seed provenance. Remote membership proves authorization, not
    // that either data plane completed cleanly, and therefore cannot preserve
    // legacy readiness bits.
    const locallyCurated = typeof input.agent.isCuratorOf === 'function'
      ? await input.agent.isCuratorOf(contextGraphId).catch(() => false)
      : false;
    if (locallyCurated) {
      writeContextGraphReadiness(input.store, contextGraphId, {
        durableVerified: subscription.synced === true,
        sharedMemoryVerified: subscription.sharedMemorySynced === true,
      });
      input.log(
        `Preserved locally curated context-graph readiness during provenance migration: ${contextGraphId}`,
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
