import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { DKGEvent, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import type {
  ContextGraphReadinessProvenance,
  DashboardDB,
} from '@origintrail-official/dkg-node-ui';
import {
  catchupPlaneCompletedWithoutFailure,
  catchupPlaneProvenByAuthorityHostedEmpty,
  catchupPlaneProvenByData,
  catchupPlaneProvenByUnanimousEmpty,
  catchupPlaneReady,
  type CatchupJobResult,
  type CatchupPlaneCompletionEvidence,
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

export type ContextGraphConvergencePlane = 'metadata' | 'durable' | 'sharedMemory';

export interface ContextGraphConvergenceSnapshot {
  state: 'pending' | 'partial' | 'complete';
  required: {
    metadata: true;
    durable: true;
    sharedMemory: boolean;
  };
  verified: {
    metadata: boolean;
    durable: boolean;
    sharedMemory: boolean;
  };
  missing: ContextGraphConvergencePlane[];
  readinessUpdatedAt?: number;
  observedAt: number;
}

/**
 * Describe the live, per-plane convergence of one selected context graph.
 * A VM/SWM proof is only effective while authoritative CG metadata is local;
 * stale provenance must not make a graph look complete after metadata loss.
 */
export function describeContextGraphConvergence(input: {
  readiness: ContextGraphReadinessProvenance;
  includeSharedMemory: boolean;
  hasConfirmedMeta: boolean;
  observedAt?: number;
}): ContextGraphConvergenceSnapshot {
  const currentReadinessProvenance =
    input.readiness.version >= CONTEXT_GRAPH_READINESS_VERSION;
  const metadataVerified = input.hasConfirmedMeta;
  const durableVerified = metadataVerified &&
    currentReadinessProvenance &&
    input.readiness.durableVerified;
  const sharedMemoryVerified = metadataVerified &&
    currentReadinessProvenance &&
    input.readiness.sharedMemoryVerified;
  const missing: ContextGraphConvergencePlane[] = [];
  if (!metadataVerified) missing.push('metadata');
  if (!durableVerified) missing.push('durable');
  if (input.includeSharedMemory && !sharedMemoryVerified) missing.push('sharedMemory');

  const anyVerified = metadataVerified || durableVerified ||
    (input.includeSharedMemory && sharedMemoryVerified);

  return {
    state: missing.length === 0 ? 'complete' : anyVerified ? 'partial' : 'pending',
    required: {
      metadata: true,
      durable: true,
      sharedMemory: input.includeSharedMemory,
    },
    verified: {
      metadata: metadataVerified,
      durable: durableVerified,
      sharedMemory: sharedMemoryVerified,
    },
    missing,
    ...(currentReadinessProvenance
      ? { readinessUpdatedAt: input.readiness.updatedAt }
      : {}),
    observedAt: input.observedAt ?? Date.now(),
  };
}

export interface MissingMetadataReadinessPatches {
  statePatch: ContextGraphSubscriptionStatePatch;
  readinessPatch: ContextGraphReadinessPatch;
}

/** Canonical fail-closed state for a graph without authoritative metadata. */
export function missingMetadataReadinessPatches(): MissingMetadataReadinessPatches {
  return {
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
  const requestedPlanesVerified =
    currentReadinessProvenance &&
    input.readiness.durableVerified &&
    (!input.includeSharedMemory || input.readiness.sharedMemoryVerified);
  const alreadyReady =
    input.hasConfirmedMeta &&
    requestedPlanesVerified &&
    input.subscription.synced === true &&
    (!input.includeSharedMemory || input.subscription.sharedMemorySynced === true);

  if (alreadyReady) return { alreadyReady: true };

  if (!input.hasConfirmedMeta) {
    const missingMetadata = missingMetadataReadinessPatches();
    const stateAlreadyFailClosed =
      input.subscription.synced === false &&
      input.subscription.sharedMemorySynced === false &&
      input.subscription.metaSynced === false &&
      input.subscription.pendingMeta === true;
    return {
      alreadyReady: false,
      statePatch: stateAlreadyFailClosed
        ? undefined
        : missingMetadata.statePatch,
      // Subscription flags and provenance are persisted independently. A
      // prior bootstrap may already have reset the flags while leaving v1
      // proof behind, so metadata absence must invalidate provenance even
      // when the visible state is already fail-closed.
      readinessPatch: missingMetadata.readinessPatch,
    };
  }

  const durableVerified =
    currentReadinessProvenance && input.readiness.durableVerified;
  const sharedMemoryVerified =
    currentReadinessProvenance && input.readiness.sharedMemoryVerified;
  const statePatch =
    input.subscription.synced !== durableVerified ||
    input.subscription.sharedMemorySynced !== sharedMemoryVerified
      ? {
          synced: durableVerified,
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

/**
 * Did ANY peer complete this plane cleanly, whatever it carried?
 *
 * Every carrier of clean-completion evidence must be listed here, not just the
 * ones that prove readiness: this predicate gates the denial and no-response
 * branches that run BEFORE `catchupPlaneReady` is ever consulted, so a form of
 * evidence missing from it is silently unreachable. The curator's hosted-empty
 * round is the newest carrier and is exactly that shape — no data, no wire-empty
 * response, and still a clean answer from the one peer that speaks for the graph.
 */
function cleanCompletionHasResponse(
  completion: CatchupPlaneCompletionEvidence | undefined,
): boolean {
  return (completion?.verifiedDataPeers ?? 0) > 0 ||
    (completion?.verifiedPrivateOnlyPeers ?? 0) > 0 ||
    (completion?.emptyPeers ?? 0) > 0 ||
    (completion?.authorityEmptyPeers ?? 0) > 0;
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

interface CatchupPlaneReadinessThisRun {
  /** Whether this plane counts as ready for THIS run's reported job status. */
  ready: boolean;
  /**
   * Whether the evidence is strong enough to PERSIST as sticky readiness
   * provenance.
   *
   * Readiness provenance is carried forward by an OR against
   * `readinessBeforeCatchup`, so anything recorded here is permanent for the
   * subscription. Verified content earns it outright, as does the curator's own
   * word that it hosts an empty graph.
   *
   * A unanimous-empty round earns it only when the round was FULLY ACCOUNTED:
   * every peer the walk attempted actually answered (`failedPeers === 0`).
   * Emptiness is a verdict derived from ABSENCE of evidence, so it is only as
   * good as the denominator it was taken over — with peers unaccounted for and
   * no authoritative curator to anchor it, a single unrelated empty response
   * produces the same verdict as a genuinely empty graph.
   *
   * Splitting it this way keeps both properties that pulled against each other:
   *
   * - LIVENESS. The per-run verdict is unchanged, so a graph on a lossy network
   *   still reports `done` instead of retrying forever. Failing the verdict
   *   itself closed on unaccounted peers was rejected for exactly that reason.
   * - NO FROZEN GUESS. Nothing derived from a partial round is written down, so
   *   a wrong empty verdict cannot outlive the run that produced it.
   *
   * This bit is what `statePatch.synced` is built from, and `synced` gates
   * write preflight (`contextGraphRowIsWritable`), so anything admitted here
   * grants durable readiness to consumers that never see the job result.
   */
  persistable: boolean;
}

function catchupPlaneReadinessThisRun(input: {
  result: CatchupJobResult;
  plane: 'durable' | 'sharedMemory';
  isPrivate: boolean;
}): CatchupPlaneReadinessThisRun {
  const diagnostics = input.result.diagnostics?.[input.plane];
  const completion = input.result.cleanPlaneCompletions?.[input.plane];
  const options = { isPrivate: input.isPrivate };
  // Every attempted peer answered, so the empty verdict was taken over the
  // whole peer set rather than over whoever happened to reply.
  const fullyAccounted = (diagnostics?.failedPeers ?? 0) === 0;
  if (completion) {
    const provenPositively = catchupPlaneProvenByData(completion)
      || catchupPlaneProvenByAuthorityHostedEmpty(completion, diagnostics, options);
    const unanimousEmpty = catchupPlaneProvenByUnanimousEmpty(completion, diagnostics, options);
    return {
      ready: provenPositively || unanimousEmpty,
      persistable: provenPositively || (unanimousEmpty && fullyAccounted),
    };
  }

  // Backward compatibility for callers that construct a legacy result (for
  // example, an older in-process runner during a rolling upgrade). New worker
  // results always carry cleanPlaneCompletions, so aggregate failures are not
  // used as readiness evidence on the production path. The same fail-closed
  // rule applies: aggregate counters can show that SOMEBODY answered empty, but
  // only a content-free, failure-free round proves the plane really is empty.
  const dataProgress = input.plane === 'durable'
    ? input.result.dataSynced > 0 ||
      (input.result.diagnostics?.durable.verifiedPrivateOnlyResponses ?? 0) > 0
    : input.result.sharedMemorySynced > 0;
  if (catchupPlaneCompletedWithoutFailure(diagnostics) && dataProgress) {
    return { ready: true, persistable: true };
  }
  // Pass NO completion evidence rather than an all-zero stand-in: the empty
  // proof consults the raw aggregate counters only when completion evidence is
  // genuinely absent, and a synthetic `emptyPeers: 0` would read as "the
  // per-peer view saw no clean empty response" and suppress the legacy path.
  const ready = catchupPlaneReady(undefined, diagnostics, options);
  return {
    ready,
    // No completion evidence means neither positive proof mode can fire, so
    // anything true here came from the aggregate empty counter and is subject
    // to the same fully-accounted requirement.
    persistable: ready && fullyAccounted,
  };
}

export interface ContextGraphCatchupReadinessClassification {
  jobStatus: 'done' | 'failed' | 'denied' | 'unreachable';
  error?: string;
  statePatch?: ContextGraphSubscriptionStatePatch;
  readinessPatch?: ContextGraphReadinessPatch;
  eventPayload?: {
    dataSynced: number;
    sharedMemorySynced: number;
    verifiedPrivateOnlyResponses: number;
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
      const missingMetadata = missingMetadataReadinessPatches();
      return {
        jobStatus: 'unreachable',
        error: 'No peer delivered authoritative context-graph metadata — the curator may be offline, or responding peers do not host this project.',
        ...missingMetadata,
      };
    }

    const durableThisRun = catchupPlaneReadinessThisRun({
      result,
      plane: 'durable',
      isPrivate: input.isPrivate,
    });
    const sharedMemoryThisRun = input.includeSharedMemory
      ? catchupPlaneReadinessThisRun({
        result,
        plane: 'sharedMemory',
        isPrivate: input.isPrivate,
      })
      : { ready: false, persistable: false };
    const durableReadyThisRun = durableThisRun.ready;
    const sharedMemoryReadyThisRun = sharedMemoryThisRun.ready;
    const currentReadinessProvenance =
      input.readinessBeforeCatchup.version >= CONTEXT_GRAPH_READINESS_VERSION;
    const durableVerifiedBefore =
      currentReadinessProvenance && input.readinessBeforeCatchup.durableVerified;
    const sharedMemoryVerifiedBefore =
      currentReadinessProvenance && input.readinessBeforeCatchup.sharedMemoryVerified;
    const durableVerified = durableVerifiedBefore || durableReadyThisRun;
    const sharedMemoryVerified = sharedMemoryVerifiedBefore || sharedMemoryReadyThisRun;
    // What this run is allowed to FREEZE, as opposed to what it reports. These
    // diverge only for a unanimous-empty verdict, which stays re-derived per run
    // so that a wrong empty verdict cannot become permanent.
    const durableVerifiedPersisted = durableVerifiedBefore || durableThisRun.persistable;
    const sharedMemoryVerifiedPersisted =
      sharedMemoryVerifiedBefore || sharedMemoryThisRun.persistable;
    const missingDurable = !durableVerified;
    const missingRequestedSharedMemory =
      input.includeSharedMemory && !sharedMemoryVerified;
    const madeIncompleteProgress =
      (durableDataProgress && !durableReadyThisRun) ||
      (sharedMemoryProgress && !sharedMemoryReadyThisRun);

    let jobStatus: ContextGraphCatchupReadinessClassification['jobStatus'] = 'done';
    let error: string | undefined;
    if (missingDurable || missingRequestedSharedMemory) {
      jobStatus = 'unreachable';
      if (madeIncompleteProgress) {
        error = 'Verified data was inserted, but catch-up did not complete without a timeout or failed phase. The incomplete plane remains unready; retry once the network is healthier.';
      } else if (input.isPrivate && missingDurable && sharedMemoryVerified) {
        error = 'Shared-memory catch-up completed, but no authorized peer delivered a verified durable VM snapshot. The selected graph remains incomplete.';
      } else if (input.isPrivate && missingDurable) {
        error = 'No authorized context-graph peer delivered verified durable VM data — empty or metadata-only responses cannot prove a private graph is fully synchronized, and the curator may be offline.';
      } else if (input.isPrivate && missingRequestedSharedMemory) {
        error = 'Durable context-graph data synchronized, but shared-memory catch-up did not complete. Retry to finish shared-memory synchronization.';
      } else if (missingDurable && sharedMemoryVerified) {
        error = 'Shared-memory catch-up completed, but durable VM catch-up did not complete. The selected graph remains incomplete.';
      } else {
        error = 'Context-graph catch-up did not complete cleanly for every requested data plane. Retry once the network is healthier.';
      }
    }

    return {
      jobStatus,
      error,
      statePatch: {
        // `synced` is a second persisted VM-readiness bit used by write
        // preflight, so it must match durable provenance rather than transient
        // empty-round evidence or independently verified SWM.
        synced: durableVerifiedPersisted,
        sharedMemorySynced: sharedMemoryVerifiedPersisted,
        metaSynced: true,
        pendingMeta: false,
      },
      readinessPatch: {
        durableVerified: durableVerifiedPersisted,
        sharedMemoryVerified: sharedMemoryVerifiedPersisted,
      },
      eventPayload: durableReadyThisRun || sharedMemoryReadyThisRun
        ? {
            dataSynced: durableReadyThisRun ? result.dataSynced : 0,
            sharedMemorySynced: sharedMemoryReadyThisRun
              ? result.sharedMemorySynced
              : 0,
            verifiedPrivateOnlyResponses: durableReadyThisRun
              ? result.cleanPlaneCompletions?.durable.verifiedPrivateOnlyPeers
                ?? result.diagnostics?.durable.verifiedPrivateOnlyResponses
                ?? 0
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

// Bootstrap invalidation and automatic PROJECT_SYNCED persistence can race
// during daemon startup. Serialize both against the same agent/CG key so the
// later operation always revalidates live metadata before it writes.
const contextGraphReadinessMutationTails = new WeakMap<
  DKGAgent,
  Map<string, Promise<void>>
>();

async function withContextGraphReadinessMutationLock<T>(
  agent: DKGAgent,
  contextGraphId: string,
  task: () => Promise<T>,
): Promise<T> {
  let tails = contextGraphReadinessMutationTails.get(agent);
  if (!tails) {
    tails = new Map<string, Promise<void>>();
    contextGraphReadinessMutationTails.set(agent, tails);
  }
  const previous = tails.get(contextGraphId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.then(() => undefined, () => undefined);
  tails.set(contextGraphId, tail);
  try {
    return await run;
  } finally {
    if (tails.get(contextGraphId) === tail) tails.delete(contextGraphId);
  }
}

/**
 * Revalidate live metadata and invalidate subscription/provenance together.
 * Returns false when authoritative metadata arrived before this reset acquired
 * the readiness lock, in which case newer PROJECT_SYNCED proof is preserved.
 */
export async function resetContextGraphReadinessForMissingMetadata(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
}): Promise<boolean> {
  const contextGraphId = input.contextGraphId.trim();
  if (!contextGraphId) return false;

  return withContextGraphReadinessMutationLock(input.agent, contextGraphId, async () => {
    const locallyCurated = typeof input.agent.isCuratorOf === 'function'
      ? await input.agent.isCuratorOf(contextGraphId).catch(() => false)
      : false;
    const hasConfirmedMeta = await input.agent.hasConfirmedMetaState(
      contextGraphId,
      { rejectUnregisteredPlaceholder: !locallyCurated },
    ).catch(() => false);
    if (hasConfirmedMeta) return false;

    const patches = missingMetadataReadinessPatches();
    input.agent.markContextGraphSubscriptionState(contextGraphId, patches.statePatch);
    writeContextGraphReadiness(input.store, contextGraphId, patches.readinessPatch);
    return true;
  });
}

/**
 * Persist readiness proven by the agent's automatic post-approval catch-up.
 * PROJECT_SYNCED is also used as a UI event, so fail closed unless it carries
 * actual inserted data or a cryptographically verified private-only response,
 * and the graph's authoritative metadata is present.
 */
export async function persistProjectSyncedReadiness(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
  dataSynced: number;
  sharedMemorySynced: number;
  verifiedPrivateOnlyResponses?: number;
}): Promise<boolean> {
  const contextGraphId = input.contextGraphId.trim();
  const verifiedPrivateOnlyResponses = input.verifiedPrivateOnlyResponses ?? 0;
  const durableCompleted = (Number.isFinite(input.dataSynced) && input.dataSynced > 0) || (
    Number.isFinite(verifiedPrivateOnlyResponses)
    && verifiedPrivateOnlyResponses > 0
  );
  const sharedMemoryCompleted = Number.isFinite(input.sharedMemorySynced) &&
    input.sharedMemorySynced > 0;
  if (
    !contextGraphId ||
    (!durableCompleted && !sharedMemoryCompleted) ||
    typeof input.store.setContextGraphReadinessProvenance !== 'function'
  ) return false;

  return withContextGraphReadinessMutationLock(input.agent, contextGraphId, async () => {
    const hasConfirmedMeta = await input.agent.hasConfirmedMetaState(
      contextGraphId,
      { rejectUnregisteredPlaceholder: true },
    ).catch(() => false);
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
  });
}

export interface ProjectSyncedReadinessPayload {
  contextGraphId: string;
  dataSynced: number;
  sharedMemorySynced: number;
  verifiedPrivateOnlyResponses: number;
}

export function parseProjectSyncedReadinessPayload(
  data: unknown,
): ProjectSyncedReadinessPayload | null {
  if (!data || typeof data !== 'object') return null;
  const candidate = data as Partial<ProjectSyncedReadinessPayload>;
  if (
    typeof candidate.contextGraphId !== 'string' ||
    typeof candidate.dataSynced !== 'number' ||
    !Number.isFinite(candidate.dataSynced) ||
    typeof candidate.sharedMemorySynced !== 'number' ||
    !Number.isFinite(candidate.sharedMemorySynced) ||
    (
      candidate.verifiedPrivateOnlyResponses !== undefined
      && (
        typeof candidate.verifiedPrivateOnlyResponses !== 'number'
        || !Number.isFinite(candidate.verifiedPrivateOnlyResponses)
      )
    )
  ) {
    return null;
  }
  return {
    contextGraphId: candidate.contextGraphId,
    dataSynced: candidate.dataSynced,
    sharedMemorySynced: candidate.sharedMemorySynced,
    verifiedPrivateOnlyResponses: candidate.verifiedPrivateOnlyResponses ?? 0,
  };
}

export function registerProjectSyncedReadinessPersistence(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  log: (message: string) => void;
}): void {
  input.agent.eventBus.on(DKGEvent.PROJECT_SYNCED, (data: unknown) => {
    const payload = parseProjectSyncedReadinessPayload(data);
    if (!payload) return;
    void persistProjectSyncedReadiness({
      agent: input.agent,
      store: input.store,
      ...payload,
    }).catch((err) => {
      input.log(
        `[warn] Failed to persist PROJECT_SYNCED readiness: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
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
