import {
  parseDeterministicKnowledgeAssetUal,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  GRAPH_KNOWLEDGE_ASSET_CONFIRMATION_KIND_PREDICATE,
  readGraphKnowledgeAssetConfirmationKindV1,
  type PhaseCallback,
} from '@origintrail-official/dkg-publisher';
import type { DurableBatchVerificationMode } from '../../sync-verify-worker.js';
import { packKnowledgeAssetIdFromIdentity } from '../../ka-identity.js';
import {
  createGraphScopedDurableManifestPlan,
  graphScopedDurableManifestPrefixAtOffset,
  isGraphScopedDurableManifestBoundary,
  planBoundedGraphScopedDurableBatch,
  type GraphScopedDurableManifestPlan,
} from '../durable-integrity.js';
import { didSyncPeerRespond, isSyncBackoffWorthyError, isSyncPermanentRejection, isSyncTransportFailure } from '../error-tags.js';
import {
  createDurableSyncAccumulator,
  finalizeDurableSyncCompletion,
  markDurableTerminalBoundary,
  recordDurableSyncDiagnostics,
  type InitializedDurableSyncResult,
} from '../durable-progress.js';
import {
  getSyncCheckpointKey,
  type DurableManifestDigest,
  type DurableManifestPrefixDigest,
} from '../checkpoint/state.js';
import type { SyncPageResult } from './page-fetch.js';
import type {
  GraphScopedMaterializationOutcome,
  VerifiedGraphScopedAsset,
} from './graph-scoped-materialization.js';
import type { DurableSyncBudget } from './durable-sync-budget.js';
import {
  normalizeDurableSyncContext,
  type LegacyDurableSyncContext,
} from './durable-sync-compat.js';
import {
  classifyExactDurableFetch,
  filterExactAssetDurablePayload,
  mergeExactDurableFetchDisposition,
  type ExactDurableFetchDisposition,
} from './exact-durable-fetch.js';

export {
  createContextGraphSyncDeadline,
  createDurableMetaPhaseFetchDeadline,
  createDurableSyncBudget,
  createGraphScopedAuthenticationDeadline,
  DURABLE_DATA_PHASE_MIN_BUDGET_MS,
  DURABLE_META_PHASE_BUDGET_FRACTION,
  EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS,
  MAX_DURABLE_SYNC_TOTAL_TIMEOUT_MS,
  normalizeDurableSyncTimeoutMs,
} from './durable-sync-budget.js';
export type {
  DurableSyncBudget,
  DurableSyncContextGraphBudget,
  DurableSyncContextGraphBudgetRequest,
} from './durable-sync-budget.js';
export type { LegacyDurableSyncContext } from './durable-sync-compat.js';
export { filterExactAssetDurablePayload } from './exact-durable-fetch.js';
export type { ExactDurableFetchDisposition } from './exact-durable-fetch.js';

/** Normalize arbitrary AbortSignal reasons without mutating caller-owned errors. */
function normalizeDurableSyncAbortReason(reason: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;

  const error = new Error(
    reason instanceof Error
      ? reason.message || 'Durable sync aborted'
      : typeof reason === 'string'
        ? reason
        : 'Durable sync aborted',
  );
  error.name = 'AbortError';
  if (reason !== undefined) {
    (error as Error & { cause?: unknown }).cause = reason;
  }
  return error;
}

export interface DetailedDurableSyncResult {
  readonly result: InitializedDurableSyncResult;
  /** Present only when this physical run used an exact-asset filter. */
  readonly exactFetchDisposition?: ExactDurableFetchDisposition;
}

const DKG_NS = 'http://dkg.io/ontology/';
const CONTENT_SCOPE_VERSION = `${DKG_NS}contentScopeVersion`;
const KA_UAL = `${DKG_NS}kaUal`;
const ASSERTION_GRAPH = `${DKG_NS}assertionGraph`;
const ASSERTION_VERSION = `${DKG_NS}assertionVersion`;
const CONTEXT_GRAPH = `${DKG_NS}contextGraph`;
const BATCH_ID = `${DKG_NS}batchId`;
const MATERIALIZED_VERSION = `${DKG_NS}materializedVersion`;
const TRANSACTION_HASH = `${DKG_NS}transactionHash`;
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const PEER_UNTRUSTED_METADATA_PREDICATES = new Set([
  MATERIALIZED_VERSION,
  `${DKG_NS}accessPolicy`,
  `${DKG_NS}allowedPeer`,
  `${DKG_NS}publisherPeerId`,
  `${DKG_NS}status`,
]);
const GRAPH_SCOPED_SYNC_METADATA_PREDICATES = new Set([
  `${DKG_NS}merkleRoot`,
  `${DKG_NS}contentScopeVersion`,
  `${DKG_NS}kaUal`,
  ASSERTION_VERSION,
  `${DKG_NS}publicTripleCount`,
  `${DKG_NS}privateTripleCount`,
  `${DKG_NS}privateMerkleRoot`,
  ASSERTION_GRAPH,
  `${DKG_NS}contextGraph`,
  `${DKG_NS}subGraphName`,
  TRANSACTION_HASH,
  GRAPH_KNOWLEDGE_ASSET_CONFIRMATION_KIND_PREDICATE,
]);

/** Graph inventory from one clean, complete legacy full snapshot. */
export interface VerifiedFullSnapshot {
  contextGraphId: string;
  verifiedDataGraphs: ReadonlySet<string>;
  verifiedMetaGraphs: ReadonlySet<string>;
  /** False only when this CG's metadata phase was intentionally disabled. */
  metaFetched: boolean;
}

/** Fetch-specific time and cancellation boundary. */
export interface DurableSyncFetchContext {
  readonly deadline: number;
  readonly signal?: AbortSignal;
}

export interface DurableSyncFetchRequest {
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly phase: 'data' | 'meta';
  readonly graphUri: string;
  readonly snapshotRef?: string;
  readonly sinceBatchId?: string;
  readonly exactAssetUals?: string[];
  /** Canonical META generation that authorizes this DATA continuation. */
  readonly manifestDigest?: DurableManifestDigest;
  /** Canonical descriptor-prefix proof for safe cross-generation reuse. */
  readonly manifestPrefixDigestAtOffset?: (
    offset: number,
  ) => DurableManifestPrefixDigest | undefined;
  /** Identity is unprovable; rotate any saved DATA continuation before fetch. */
  readonly forceFreshSession?: boolean;
  readonly fetchContext: DurableSyncFetchContext;
}

export interface DurableSyncStoreInsertRequest {
  readonly quads: Quad[];
  /** Whole-operation cancellation only; plain inserts have no auth deadline. */
  readonly signal?: AbortSignal;
}

export interface DurableSyncGraphScopedStoreRequest {
  readonly asset: VerifiedGraphScopedAsset;
  readonly authenticationDeadline: number;
  readonly signal?: AbortSignal;
}

export interface DurableSyncContext {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphIds: string[];
  onPhase?: PhaseCallback;
  /**
   * Invoked with the specific `contextGraphId` that was denied by the
   * remote peer (i.e. the remote responded with an `access-denied`
   * sync-protocol error for that CG). Callers use this to distinguish
   * "peer refused to serve this graph" from "sync completed but there
   * was nothing to send" — the two look identical at the summary level
   * but have very different operator meanings.
   */
  onAccessDenied?: (contextGraphId: string) => void;
  syncAgentsMeta?: boolean;
  durableSyncBudget: DurableSyncBudget;
  /** Whole-operation cancellation propagated by bounded foreground callers. */
  signal?: AbortSignal;
  fetchSyncPages: (request: DurableSyncFetchRequest) => Promise<SyncPageResult>;
  /**
   * Phase C — optional, gap-safe per-CG delta high-water mark resolver. When it
   * returns a value for a CG, the durable DATA fetch carries `sinceBatchId` and
   * the responder returns only KAs with `dkg:batchId` greater than it. MUST be
   * backed by a CONTIGUOUS watermark. Undefined ⇒ full scan (default today).
   */
  sinceBatchIdFor?: (contextGraphId: string) => string | undefined;
  /** Exact missing KAs for VM recovery; undefined retains normal full/delta sync. */
  exactAssetUalsFor?: (contextGraphId: string) => string[] | undefined;
  stopOnBackoffWorthyFailure?: boolean;
  processDurableBatchInWorker: (
    dataQuads: Quad[],
    metaQuads: Quad[],
    ctx: OperationContext,
    acceptUnverified: boolean,
    mode: DurableBatchVerificationMode,
  ) => Promise<{
    verifiedData: Quad[];
    verifiedMeta: Quad[];
    verifiedGraphScopedDataGraphs?: string[];
    /**
     * Worker-owned aggregate of meta rows deliberately consumed but not
     * persisted. REQUIRED (#1921): it is the single checkpoint-advance signal,
     * so every producer must set it — an optional field silently reading 0
     * would let the meta cursor pin with no type error.
     */
    consumedUnpersistedMetaTriples: number;
    totalFetchedDataQuads: number;
    totalFetchedMetaQuads: number;
    rejectedKcs: number;
    emptyResponses: number;
    metaOnlyResponses: number;
    verifiedPrivateOnlyResponses: number;
    dataRejectedMissingMeta: number;
  }>;
  storeInsert: (request: DurableSyncStoreInsertRequest) => Promise<void>;
  /** Exact replacement path for verified V2 KAs; absent capability fails closed. */
  storeGraphScopedAsset?: (
    request: DurableSyncGraphScopedStoreRequest,
  ) => Promise<GraphScopedMaterializationOutcome>;
  /** Runs after verified snapshot writes and before phase checkpoints advance. */
  onVerifiedFullSnapshot?: (snapshot: VerifiedFullSnapshot) => Promise<void>;
  deleteCheckpoint: (key: string) => void;
  setCheckpoint: (
    key: string,
    offset: number,
    manifestDigest?: DurableManifestDigest,
    manifestPrefixDigest?: DurableManifestPrefixDigest,
    terminal?: boolean,
  ) => void;
  logInfo: (ctx: OperationContext, message: string) => void;
  logWarn: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}

interface ManifestSettlementCheckpoint {
  readonly numericAdvance: boolean;
}

/**
 * Advance only across a contiguous prefix of graph descriptors whose exact
 * assets have finished the chain-authentication + atomic-materialization
 * boundary. A numeric offset can cover adjacent zero-public descriptors, so
 * the canonical prefix helper (not DATA row counts alone) decides when the
 * prefix is persistable.
 */
function createManifestSettlementCheckpointer(options: {
  manifest: GraphScopedDurableManifestPlan;
  checkpointKey: string;
  resumedFromOffset: number;
  maximumOffset: number;
  setCheckpoint: DurableSyncContext['setCheckpoint'];
}): (assertionGraph: string) => ManifestSettlementCheckpoint | undefined {
  const {
    manifest,
    checkpointKey,
    resumedFromOffset,
    maximumOffset,
    setCheckpoint,
  } = options;
  const descriptorByGraph = new Map(
    manifest.descriptors.map((descriptor) => [descriptor.assertionGraph, descriptor] as const),
  );
  const resumedPrefix = resumedFromOffset > 0
    ? graphScopedDurableManifestPrefixAtOffset(manifest, resumedFromOffset)
    : null;
  if (resumedFromOffset > 0 && !resumedPrefix) {
    throw new Error(
      `Cannot continue manifest settlement from non-boundary offset ${resumedFromOffset}`,
    );
  }

  let descriptorIndex = resumedPrefix?.descriptorCount ?? 0;
  let safeOffset = resumedFromOffset;
  let persistedDescriptorCount = descriptorIndex;
  let persistedOffset = resumedFromOffset;
  const settledGraphs = new Set<string>();

  return (assertionGraph: string): ManifestSettlementCheckpoint | undefined => {
    if (!descriptorByGraph.has(assertionGraph)) {
      throw new Error(
        `Refusing to checkpoint graph ${assertionGraph}: it is absent from the verified manifest`,
      );
    }
    settledGraphs.add(assertionGraph);
    while (
      descriptorIndex < manifest.descriptors.length
      && settledGraphs.has(manifest.descriptors[descriptorIndex]!.assertionGraph)
    ) {
      safeOffset += manifest.descriptors[descriptorIndex]!.publicTripleCount;
      descriptorIndex += 1;
    }
    if (!Number.isSafeInteger(safeOffset) || safeOffset > maximumOffset) {
      throw new Error(
        `Refusing to checkpoint settled durable prefix ${safeOffset} beyond verified offset ${maximumOffset}`,
      );
    }

    const prefix = graphScopedDurableManifestPrefixAtOffset(manifest, safeOffset);
    // The prefix helper includes every adjacent zero-public descriptor. Wait
    // until all of those descriptors have settled before binding this offset.
    if (!prefix || prefix.descriptorCount !== descriptorIndex) return undefined;
    if (
      safeOffset === persistedOffset
      && descriptorIndex === persistedDescriptorCount
    ) return undefined;

    const numericAdvance = safeOffset > persistedOffset;
    setCheckpoint(
      checkpointKey,
      safeOffset,
      manifest.manifestDigest,
      prefix.prefixDigest,
      false,
    );
    persistedOffset = safeOffset;
    persistedDescriptorCount = descriptorIndex;
    return { numericAdvance };
  };
}

export function runDurableSync(
  context: DurableSyncContext,
): Promise<InitializedDurableSyncResult>;
export function runDurableSync(
  context: LegacyDurableSyncContext,
): Promise<InitializedDurableSyncResult>;
export async function runDurableSync(
  context: DurableSyncContext | LegacyDurableSyncContext,
): Promise<InitializedDurableSyncResult> {
  return (await runDurableSyncWithBudget(normalizeDurableSyncContext(context))).result;
}

export function runDurableSyncDetailed(
  context: DurableSyncContext,
): Promise<DetailedDurableSyncResult>;
export function runDurableSyncDetailed(
  context: LegacyDurableSyncContext,
): Promise<DetailedDurableSyncResult>;
export async function runDurableSyncDetailed(
  context: DurableSyncContext | LegacyDurableSyncContext,
): Promise<DetailedDurableSyncResult> {
  return runDurableSyncWithBudget(normalizeDurableSyncContext(context));
}

async function runDurableSyncWithBudget(
  context: DurableSyncContext,
): Promise<DetailedDurableSyncResult> {
  const {
    ctx,
    remotePeerId,
    contextGraphIds,
    onPhase,
    onAccessDenied,
    syncAgentsMeta = true,
    durableSyncBudget,
    signal,
    fetchSyncPages,
    sinceBatchIdFor,
    exactAssetUalsFor,
    stopOnBackoffWorthyFailure = false,
    processDurableBatchInWorker,
    storeInsert,
    storeGraphScopedAsset,
    onVerifiedFullSnapshot,
    deleteCheckpoint,
    setCheckpoint,
    logInfo,
    logWarn,
    logDebug,
  } = context;

  const throwIfOperationAborted = () => {
    if (!signal?.aborted) return;
    throw normalizeDurableSyncAbortReason(signal.reason);
  };
  const fetchContext = (deadline: number): DurableSyncFetchContext => ({
    deadline,
    signal,
  });

  const accumulator = createDurableSyncAccumulator();
  const exactFetchDispositions: ExactDurableFetchDisposition[] = [];

  const recordPhaseOutcome = (
    result: SyncPageResult,
    options: {
      updateCheckpoint: boolean;
      countProgress?: boolean;
      checkpointAdvanceAlreadyRecorded?: boolean;
      emptyPhase?: boolean;
      manifestPlan?: GraphScopedDurableManifestPlan;
      terminal?: boolean;
    },
  ) => {
    const countProgress = options.countProgress ?? true;
    let completedPhases = 0;
    let checkpointAdvances = 0;
    if (options.updateCheckpoint && countProgress) {
      if (
        result.completed &&
        !result.timedOut &&
        (
          options.emptyPhase === true ||
          result.resumedFromOffset > 0 ||
          result.nextOffset > result.resumedFromOffset
        )
      ) {
        completedPhases = 1;
      }
      if (
        result.nextOffset > result.resumedFromOffset
        && options.checkpointAdvanceAlreadyRecorded !== true
      ) {
        checkpointAdvances = 1;
      }
    }
    recordDurableSyncDiagnostics(accumulator, {
      resumedPhases: result.resumedFromOffset > 0 ? 1 : 0,
      timedOutPhases: result.timedOut ? 1 : 0,
      completedPhases,
      checkpointAdvances,
    });
    if (!options.updateCheckpoint) return;
    if (result.completed && options.manifestPlan && options.terminal === true) {
      if (result.nextOffset !== options.manifestPlan.manifestRowCount) {
        deleteCheckpoint(result.checkpointKey);
        throw new Error(
          `Refusing to persist terminal durable DATA offset ${result.nextOffset}: `
          + `manifest requires ${options.manifestPlan.manifestRowCount}`,
        );
      }
      const prefix = graphScopedDurableManifestPrefixAtOffset(
        options.manifestPlan,
        result.nextOffset,
      );
      if (!prefix) {
        deleteCheckpoint(result.checkpointKey);
        throw new Error(
          `Refusing to persist terminal durable DATA offset ${result.nextOffset}: `
          + 'the completed META manifest has no matching graph boundary',
        );
      }
      setCheckpoint(
        result.checkpointKey,
        result.nextOffset,
        options.manifestPlan.manifestDigest,
        prefix.prefixDigest,
        true,
      );
    } else if (result.completed) deleteCheckpoint(result.checkpointKey);
    else if (result.nextOffset > 0 || result.resumedFromOffset > 0) {
      if (options.manifestPlan) {
        const prefix = graphScopedDurableManifestPrefixAtOffset(
          options.manifestPlan,
          result.nextOffset,
        );
        if (!prefix) {
          deleteCheckpoint(result.checkpointKey);
          throw new Error(
            `Refusing to checkpoint durable DATA offset ${result.nextOffset}: `
            + 'the completed META manifest has no matching graph boundary',
          );
        }
        setCheckpoint(
          result.checkpointKey,
          result.nextOffset,
          options.manifestPlan.manifestDigest,
          prefix.prefixDigest,
          false,
        );
      } else {
        setCheckpoint(result.checkpointKey, result.nextOffset);
      }
    }
  };

  let peerFailed = false;
  const shouldStopAfterBackoffWorthyFailure = (contextGraphId: string, reason: string): boolean => {
    if (!stopOnBackoffWorthyFailure) return false;
    logInfo(ctx, `Stopping durable sync fanout for ${remotePeerId} after "${contextGraphId}" (${reason})`);
    return true;
  };
  for (const [contextGraphIndex, pid] of contextGraphIds.entries()) {
    let activePhase: 'fetch' | 'verify' | 'store' | undefined;
    let peerRespondedForContextGraph = false;
    let exactFetchDispositionIndex: number | undefined;
    const startPhase = (phase: 'fetch' | 'verify' | 'store') => {
      activePhase = phase;
      onPhase?.(phase, 'start');
    };
    const endPhase = () => {
      if (!activePhase) return;
      onPhase?.(activePhase, 'end');
      activePhase = undefined;
    };

    try {
      throwIfOperationAborted();
      const dataGraph = contextGraphDataGraphUri(pid);
      const metaGraph = contextGraphMetaGraphUri(pid);
      const isSystemContextGraph = (Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(pid);
      const contextGraphBudget = durableSyncBudget.createContextGraphBudget({
        contextGraphId: pid,
        remainingContextGraphs: contextGraphIds.length - contextGraphIndex,
      });
      const deadline = contextGraphBudget.fetchDeadline;
      // Meta may never outlive the CG window even if a budget hands out a
      // later phase deadline, so both phases combined stay inside the per-CG
      // wall clock. The data phase runs to the full CG deadline, which is how
      // a meta phase that finishes early rolls its unused time into data.
      // System CGs accept unverified payloads, so a capped partial meta page
      // can persist and resume. Verified CGs require joint meta/data
      // verification before either cursor advances; giving their meta phase an
      // earlier cap could make the same incomplete descriptor page repeat
      // forever.
      const metaFetchDeadline = isSystemContextGraph
        ? Math.min(contextGraphBudget.metaFetchDeadline ?? deadline, deadline)
        : deadline;
      const exactAssetUals = exactAssetUalsFor?.(pid);
      if (exactAssetUals !== undefined) {
        exactFetchDispositionIndex = exactFetchDispositions.push('incomplete') - 1;
      }

      logInfo(ctx, `Syncing context graph "${pid}" from ${remotePeerId}`);

      startPhase('fetch');
      const fetchStartedAt = Date.now();
      const skipAgentsMeta = pid === SYSTEM_CONTEXT_GRAPHS.AGENTS && syncAgentsMeta === false;
      if (skipAgentsMeta) {
        logInfo(ctx, `Skipping agents meta sync from ${remotePeerId} (syncAgentsMeta=false)`);
      }
      const fetchPhase = (
        phase: 'data' | 'meta',
        graphUri: string,
        sinceBatchId?: string,
        manifestDigest?: DurableManifestDigest,
        manifestPrefixDigestAtOffset?: (
          offset: number,
        ) => DurableManifestPrefixDigest | undefined,
        forceFreshSession?: boolean,
      ): Promise<SyncPageResult> => fetchSyncPages({
        ctx,
        remotePeerId,
        contextGraphId: pid,
        phase,
        graphUri,
        sinceBatchId,
        exactAssetUals,
        manifestDigest,
        manifestPrefixDigestAtOffset,
        forceFreshSession,
        fetchContext: fetchContext(phase === 'meta' ? metaFetchDeadline : deadline),
      });
      const metaResult: SyncPageResult = skipAgentsMeta
        ? {
            quads: [],
            bytesReceived: 0,
            resumedFromOffset: 0,
            nextOffset: 0,
            checkpointKey: getSyncCheckpointKey(remotePeerId, pid, false, 'meta'),
            completed: true,
            timedOut: false,
          }
        : await fetchPhase('meta', metaGraph);
      if (!skipAgentsMeta) peerRespondedForContextGraph = true;
      // A meta timeout can be the intentional phase boundary assigned by the
      // per-phase budget. Keep going so data can use the time reserved for it;
      // the post-processing timeout gate below still prevents fanout to the
      // next context graph when stopOnBackoffWorthyFailure is enabled.
      throwIfOperationAborted();
      const sinceBatchId = sinceBatchIdFor?.(pid);
      let effectiveMetaResult = metaResult;
      let exactAssetDescriptorCoverageComplete = true;
      if (exactAssetUals !== undefined) {
        // Scope META before it defines the DATA generation. Older responders
        // can ignore the exact-asset wire filter and over-return descriptors;
        // those unrelated assets must not enter the continuation digest or
        // bounded DATA plan for the requested subset.
        const exactMeta = filterExactAssetDurablePayload(
          [],
          metaResult.quads,
          exactAssetUals,
        );
        effectiveMetaResult = { ...metaResult, quads: exactMeta.metaQuads };
        exactAssetDescriptorCoverageComplete = exactMeta.descriptorCoverageComplete;
      }
      let graphScopedManifest: GraphScopedDurableManifestPlan | null = null;
      let forceFreshUnboundDataSession = false;
      if (sinceBatchId === undefined && !isSystemContextGraph) {
        if (
          !metaResult.completed
          || metaResult.timedOut
          || metaResult.resumedFromOffset !== 0
        ) {
          // A suffix or incomplete META phase is not a manifest. It cannot
          // identify the generation of a saved DATA OFFSET/session, so do not
          // fetch or advance DATA under it. A legacy resumed META checkpoint
          // is discarded so the next round can obtain the complete manifest.
          if (metaResult.resumedFromOffset !== 0) {
            deleteCheckpoint(metaResult.checkpointKey);
          }
          throw Object.assign(
            new Error(
              `Cannot authorize durable DATA continuation for "${pid}": `
              + 'META did not complete from offset zero',
            ),
            { code: 'SYNC_DATA_MANIFEST_INCOMPLETE' },
          );
        }
        graphScopedManifest = createGraphScopedDurableManifestPlan(
          effectiveMetaResult.quads,
          pid,
        );
        // Legacy/mixed/malformed metadata has no canonical generation identity.
        // It may still complete safely in one round, but never by trusting a
        // saved nonzero offset or responder token.
        forceFreshUnboundDataSession = graphScopedManifest === null;
      }
      const rawDataResult = await fetchPhase(
        'data',
        dataGraph,
        sinceBatchId,
        graphScopedManifest?.manifestDigest,
        graphScopedManifest
          ? (offset) => graphScopedDurableManifestPrefixAtOffset(
            graphScopedManifest!,
            offset,
          )?.prefixDigest
          : undefined,
        forceFreshUnboundDataSession,
      );
      throwIfOperationAborted();
      peerRespondedForContextGraph = true;
      endPhase();
      const fetchDurationMs = Date.now() - fetchStartedAt;
      let dataResult = rawDataResult;
      if (exactAssetUals !== undefined) {
        const exact = filterExactAssetDurablePayload(
          rawDataResult.quads,
          metaResult.quads,
          exactAssetUals,
        );
        effectiveMetaResult = { ...metaResult, quads: exact.metaQuads };
        dataResult = {
          ...rawDataResult,
          quads: exact.dataQuads,
        };
        exactAssetDescriptorCoverageComplete = exact.descriptorCoverageComplete;
        if (!exactAssetDescriptorCoverageComplete) {
          logWarn(
            ctx,
            `Exact durable response for "${pid}" did not cover every requested asset descriptor`,
          );
        }
      }

      let effectiveDataResult = dataResult;
      let dataForVerification = dataResult.quads;
      let verificationMode: DurableBatchVerificationMode = sinceBatchId === undefined
        ? { kind: 'fullSnapshot' }
        : { kind: 'sinceBatchId', sinceBatchId };

      // A rootless full snapshot is a deterministic concatenation of complete
      // exact graphs. Always compare a graph-scoped response with its verified
      // metadata manifest: a relayed stream can close cleanly after a prefix
      // and surface `completed=true` even though later graphs never arrived.
      // Verify and persist only complete leading graphs, checkpoint their
      // absolute row boundary, and call the phase complete only at the manifest
      // total. A partial final graph is deliberately discarded and retried.
      // This gives large V2 snapshots bounded memory and monotonic progress
      // without weakening legacy/mixed-layout fail-closed behaviour.
      if (
        sinceBatchId === undefined
        && !isSystemContextGraph
      ) {
        if (
          graphScopedManifest
          && dataResult.resumedFromOffset > 0
          && dataResult.manifestDigest !== graphScopedManifest.manifestDigest
        ) {
          deleteCheckpoint(dataResult.checkpointKey);
          throw Object.assign(
            new Error(
              `Discarding rootless durable response for "${pid}": resumed DATA `
              + 'continuation is not bound to the completed META generation',
            ),
            { code: 'SYNC_DATA_MANIFEST_UNBOUND' },
          );
        }
        const resumeIsManifestBoundary = dataResult.resumedFromOffset > 0
          ? isGraphScopedDurableManifestBoundary(
            graphScopedManifest ?? effectiveMetaResult.quads,
            dataResult.resumedFromOffset,
          )
          : true;
        if (resumeIsManifestBoundary === false) {
          // An OFFSET inside an exact assertion graph can never produce a
          // complete first graph in this round. Keeping it creates a permanent
          // N-1 verification loop (for example 9,999/10,000 rows). Delete the
          // paired responder session/checkpoint and retry from offset zero on
          // the next bounded sync; never store this non-contiguous suffix.
          deleteCheckpoint(dataResult.checkpointKey);
          throw Object.assign(
            new Error(
              `Discarding rootless durable response for "${pid}": resumed offset `
              + `${dataResult.resumedFromOffset} is inside an assertion graph; `
              + 'resetting the data checkpoint to a manifest boundary',
            ),
            { code: 'SYNC_GRAPH_CHECKPOINT_MISALIGNED' },
          );
        }
        const responderCursorDelta = dataResult.nextOffset - dataResult.resumedFromOffset;
        if (responderCursorDelta !== dataResult.quads.length) {
          logWarn(
            ctx,
            `Rootless durable cursor drift for "${pid}": responder advanced `
              + `${responderCursorDelta} row(s) but delivered ${dataResult.quads.length}; `
              + 'projecting only the verified complete-graph prefix',
          );
        }
        const bounded = planBoundedGraphScopedDurableBatch(
          dataResult.quads,
          graphScopedManifest ?? effectiveMetaResult.quads,
          dataResult.resumedFromOffset,
          dataResult.nextOffset,
          dataResult.completed,
        );
        if (bounded) {
          dataForVerification = bounded.dataQuads;
          effectiveDataResult = {
            ...dataResult,
            quads: bounded.dataQuads,
            nextOffset: bounded.safeNextOffset,
            completed: dataResult.completed
              && bounded.safeNextOffset === bounded.manifestRowCount,
          };
          verificationMode = {
            kind: 'changelogPage',
            changedDataGraphs: bounded.changedDataGraphs,
          };
          logInfo(
            ctx,
            `Rootless durable progress for "${pid}": `
              + `${bounded.completedGraphCount} complete graph(s), `
              + `safe offset ${dataResult.resumedFromOffset}->${bounded.safeNextOffset} `
              + `of ${bounded.manifestRowCount} (raw ${dataResult.nextOffset})`,
          );
        }
      }

      startPhase('verify');
      const verifyStartedAt = Date.now();
      let processed: Awaited<ReturnType<DurableSyncContext['processDurableBatchInWorker']>>;
      try {
        processed = await processDurableBatchInWorker(
          dataForVerification,
          effectiveMetaResult.quads,
          ctx,
          isSystemContextGraph,
          verificationMode,
        );
      } catch (error) {
        if (graphScopedManifest) deleteCheckpoint(rawDataResult.checkpointKey);
        throw error;
      }
      throwIfOperationAborted();
      endPhase();
      const verifyDurationMs = Date.now() - verifyStartedAt;

      logInfo(ctx, `  meta: ${processed.totalFetchedMetaQuads} triples fetched`);
      logInfo(ctx, `  data: ${processed.totalFetchedDataQuads} triples fetched`);
      recordDurableSyncDiagnostics(accumulator, {
        bytesReceived: metaResult.bytesReceived + rawDataResult.bytesReceived,
        fetchedMetaTriples: processed.totalFetchedMetaQuads,
        fetchedDataTriples: processed.totalFetchedDataQuads,
        emptyResponses: processed.emptyResponses,
        metaOnlyResponses: processed.metaOnlyResponses,
        verifiedPrivateOnlyResponses: processed.verifiedPrivateOnlyResponses,
        dataRejectedMissingMeta: processed.dataRejectedMissingMeta,
      });

      // A rejected KA means this page cannot be acknowledged safely. We may
      // still persist independently verified KAs from the page, but keeping
      // both cursors unchanged makes the next pass retry the rejected content
      // instead of silently skipping it.
      const batchVerifiedCleanly = processed.rejectedKcs === 0;
      if (!batchVerifiedCleanly) {
        if (graphScopedManifest) deleteCheckpoint(rawDataResult.checkpointKey);
        logWarn(
          ctx,
          `Rejected ${processed.rejectedKcs} KCs that failed durable integrity verification from ${remotePeerId}`,
        );
        recordDurableSyncDiagnostics(accumulator, { rejectedKcs: processed.rejectedKcs });
      }
      if (graphScopedManifest && processed.dataRejectedMissingMeta !== 0) {
        deleteCheckpoint(rawDataResult.checkpointKey);
      }

      const notifyVerifiedFullSnapshot = async (): Promise<void> => {
        if (
          !onVerifiedFullSnapshot
          || exactAssetUals !== undefined
          || sinceBatchId !== undefined
          || !batchVerifiedCleanly
          || processed.dataRejectedMissingMeta !== 0
          || !effectiveDataResult.completed
          || effectiveDataResult.timedOut
          || effectiveDataResult.resumedFromOffset !== 0
          || (!skipAgentsMeta && (!metaResult.completed || metaResult.timedOut))
          || (!skipAgentsMeta && metaResult.resumedFromOffset !== 0)
        ) return;

        const verifiedDataGraphs = new Set(processed.verifiedData.map((quad) => quad.graph));
        for (const graph of processed.verifiedGraphScopedDataGraphs ?? []) {
          verifiedDataGraphs.add(graph);
        }
        await onVerifiedFullSnapshot({
          contextGraphId: pid,
          verifiedDataGraphs,
          verifiedMetaGraphs: new Set(processed.verifiedMeta.map((quad) => quad.graph)),
          metaFetched: !skipAgentsMeta,
        });
      };

      const metadataOnlyResponse = processed.metaOnlyResponses > 0;
      // The worker reports, as ONE reason-agnostic count, how many fetched meta
      // rows the verifier deliberately consumed but did NOT persist — unverified
      // sync controls plus non-IRI `_meta` subjects (#1921). A metadata-only page
      // discarded ENTIRELY this way carries no verifiedMeta, so the meta cursor
      // must still advance or durable sync pins on the same page. Depending on the
      // aggregate (not per-reason counters) keeps checkpoint orchestration
      // decoupled from verifier discard policy; the per-reason counts remain as
      // verifier-side diagnostics only.
      const consumedUnpersistedMetaTriples = processed.consumedUnpersistedMetaTriples;
      const discardedOnlyMetadataResponse = metadataOnlyResponse
        && processed.verifiedData.length === 0
        && processed.verifiedMeta.length === 0
        && consumedUnpersistedMetaTriples > 0
        && consumedUnpersistedMetaTriples === processed.totalFetchedMetaQuads;
      const updateMetaCheckpoint = batchVerifiedCleanly
        && processed.dataRejectedMissingMeta === 0
        && (
          !metadataOnlyResponse
          || processed.verifiedMeta.length > 0
          || discardedOnlyMetadataResponse
        );
      const updateDataCheckpoint = batchVerifiedCleanly
        && processed.dataRejectedMissingMeta === 0
        && !metadataOnlyResponse;
      const reachedContextGraphTerminalBoundary = batchVerifiedCleanly
        && processed.dataRejectedMissingMeta === 0
        && exactAssetDescriptorCoverageComplete
        && updateMetaCheckpoint
        && updateDataCheckpoint
        && metaResult.completed
        && !metaResult.timedOut
        && effectiveDataResult.completed
        && !effectiveDataResult.timedOut;
      const settledExactDisposition = (): ExactDurableFetchDisposition => (
        classifyExactDurableFetch({
          requestedAssetCount: exactAssetUals?.length ?? 0,
          metaResult,
          dataResult: rawDataResult,
          metaFetched: !skipAgentsMeta,
          descriptorCoverageComplete: exactAssetDescriptorCoverageComplete,
          rejectedKcs: processed.rejectedKcs,
          dataRejectedMissingMeta: processed.dataRejectedMissingMeta,
        })
      );
      // Metadata-only pages may move the meta cursor after storage, but they
      // still are not usable data progress for freshness/backoff accounting.
      if (
        processed.emptyResponses > 0 ||
        processed.dataRejectedMissingMeta > 0 ||
        (processed.verifiedData.length === 0 && processed.verifiedMeta.length === 0 && processed.metaOnlyResponses > 0)
      ) {
        await notifyVerifiedFullSnapshot();
        throwIfOperationAborted();
        // The verifier reports an empty batch only when both fetched phase
        // payloads are empty. Record each phase independently: a completed
        // zero-offset phase is a real clean-empty response, while a sibling
        // timeout remains incomplete.
        const emptyPhase = processed.emptyResponses > 0;
        recordPhaseOutcome(metaResult, {
          updateCheckpoint: updateMetaCheckpoint,
          countProgress: !metadataOnlyResponse,
          emptyPhase,
        });
        recordPhaseOutcome(effectiveDataResult, {
          updateCheckpoint: updateDataCheckpoint,
          emptyPhase,
          manifestPlan: graphScopedManifest ?? undefined,
          terminal: reachedContextGraphTerminalBoundary,
        });
        markDurableTerminalBoundary(accumulator, reachedContextGraphTerminalBoundary);
        if (exactFetchDispositionIndex !== undefined) {
          exactFetchDispositions[exactFetchDispositionIndex] = settledExactDisposition();
        }
        if ((metaResult.timedOut || effectiveDataResult.timedOut) && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) {
          break;
        }
        continue;
      }

      startPhase('store');
      const storeStartedAt = Date.now();
      const partitioned = partitionVerifiedGraphScopedAssets(
        pid,
        processed.verifiedData,
        processed.verifiedMeta,
        processed.verifiedGraphScopedDataGraphs ?? [],
      );
      if (partitioned.assets.length > 0 && !storeGraphScopedAsset) {
        throw Object.assign(
          new Error('Verified graph-scoped durable sync requires an exact materialization store path'),
          { code: 'VM_ATOMIC_REPLACE_UNSUPPORTED' },
        );
      }
      // A rootless manifest contains only exact graph assets in the DATA
      // ordering. When there are no deferred legacy rows, each authenticated
      // atomic materialization is therefore a durable continuation boundary.
      // Persisting it immediately turns a later authentication deadline into
      // partial progress instead of replaying every earlier chain lookup.
      const checkpointSettledManifestGraph = graphScopedManifest
        && updateDataCheckpoint
        && exactAssetDescriptorCoverageComplete
        && partitioned.remainingData.length === 0
        && partitioned.remainingMeta.length === 0
        ? createManifestSettlementCheckpointer({
            manifest: graphScopedManifest,
            checkpointKey: effectiveDataResult.checkpointKey,
            resumedFromOffset: effectiveDataResult.resumedFromOffset,
            maximumOffset: effectiveDataResult.nextOffset,
            setCheckpoint,
          })
        : undefined;
      let incrementalCheckpointAdvanceRecorded = false;
      const graphScopedAuthenticationDeadline = partitioned.assets.length > 0
        ? contextGraphBudget.createGraphScopedAuthenticationDeadline()
        : deadline;
      for (const asset of partitioned.assets) {
        throwIfOperationAborted();
        const outcome = await storeGraphScopedAsset!({
          asset,
          authenticationDeadline: graphScopedAuthenticationDeadline,
          signal,
        });
        if (outcome === 'applied') {
          // Materialization is atomic per asset, not per fetched page. Account
          // for each committed asset immediately so a later asset failure does
          // not erase truthful progress from the returned summary.
          recordDurableSyncDiagnostics(accumulator, {
            insertedDataTriples: asset.dataQuads.length,
            insertedMetaTriples: asset.metadataQuads.length,
            insertedTriples: asset.dataQuads.length + asset.metadataQuads.length,
          });
        } else if (outcome === 'stale') {
          logDebug(ctx, `Skipped stale graph-scoped durable assertion ${asset.ual} v${asset.assertionVersion}`);
        } else {
          logWarn(ctx, `Quarantined graph-scoped durable assertion ${asset.ual} v${asset.assertionVersion}`);
        }
        const settledCheckpoint = checkpointSettledManifestGraph?.(asset.assertionGraph);
        if (settledCheckpoint?.numericAdvance && !incrementalCheckpointAdvanceRecorded) {
          recordDurableSyncDiagnostics(accumulator, { checkpointAdvances: 1 });
          incrementalCheckpointAdvanceRecorded = true;
        }
      }
      if (partitioned.remainingData.length > 0) {
        throwIfOperationAborted();
        await storeInsert({
          quads: partitioned.remainingData,
          signal,
        });
        recordDurableSyncDiagnostics(accumulator, {
          insertedTriples: partitioned.remainingData.length,
          insertedDataTriples: partitioned.remainingData.length,
        });
      }
      if (partitioned.remainingMeta.length > 0) {
        throwIfOperationAborted();
        await storeInsert({
          quads: partitioned.remainingMeta,
          signal,
        });
        recordDurableSyncDiagnostics(accumulator, {
          insertedTriples: partitioned.remainingMeta.length,
          insertedMetaTriples: partitioned.remainingMeta.length,
        });
      }
      // An already-started atomic write is awaited, counted, and manifest-
      // checkpointed truthfully. An expired operation may not enter another
      // commit boundary or claim the whole page terminal.
      throwIfOperationAborted();
      await notifyVerifiedFullSnapshot();
      throwIfOperationAborted();
      recordPhaseOutcome(metaResult, { updateCheckpoint: updateMetaCheckpoint, countProgress: !metadataOnlyResponse });
      recordPhaseOutcome(effectiveDataResult, {
        updateCheckpoint: updateDataCheckpoint,
        checkpointAdvanceAlreadyRecorded: incrementalCheckpointAdvanceRecorded,
        manifestPlan: graphScopedManifest ?? undefined,
        terminal: reachedContextGraphTerminalBoundary,
      });
      markDurableTerminalBoundary(accumulator, reachedContextGraphTerminalBoundary);
      if (exactFetchDispositionIndex !== undefined) {
        exactFetchDispositions[exactFetchDispositionIndex] = settledExactDisposition();
      }
      endPhase();
      if ((metaResult.timedOut || effectiveDataResult.timedOut) && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) {
        break;
      }
      const storeDurationMs = Date.now() - storeStartedAt;

      if (fetchDurationMs + verifyDurationMs + storeDurationMs > 100) {
        logDebug(
          ctx,
          `Requester durable timing for "${pid}": fetch=${fetchDurationMs}ms verify=${verifyDurationMs}ms store=${storeDurationMs}ms`,
        );
      }

    } catch (pidErr) {
      markDurableTerminalBoundary(accumulator, false);
      endPhase();
      logWarn(ctx, `Sync for context graph "${pid}" from ${remotePeerId} failed: ${pidErr instanceof Error ? pidErr.message : String(pidErr)}`);
      if (isSyncPermanentRejection(pidErr)) {
        // Missed-seam alarm (OT-RFC-56): the oversize guard should have
        // filtered this BEFORE the store insert. Reaching here means an
        // ingest path bypassed the guard — this page will fail identically
        // on every retry until that seam is wired.
        logWarn(ctx, `PERMANENT ingest rejection for "${pid}" reached the sync catch — an insert seam is missing the oversize guard (sync/oversize-filter.ts): ${pidErr instanceof Error ? pidErr.message : String(pidErr)}`);
      }
      const backoffWorthy = isSyncBackoffWorthyError(pidErr);
      if (backoffWorthy) {
        recordDurableSyncDiagnostics(accumulator, { backoffWorthyFailures: 1 });
      }
      if ((pidErr as Error & { syncDenied?: boolean }).syncDenied) {
        onAccessDenied?.(pid);
        recordDurableSyncDiagnostics(accumulator, { deniedPhases: 1 });
      } else if (
        peerRespondedForContextGraph ||
        didSyncPeerRespond(pidErr) ||
        !isSyncTransportFailure(pidErr)
      ) {
        recordDurableSyncDiagnostics(accumulator, { failedPhases: 1 });
      } else {
        peerFailed = true;
      }
      if (backoffWorthy && shouldStopAfterBackoffWorthyFailure(pid, 'backoff-worthy failure')) {
        break;
      }
      if (signal?.aborted) break;
    }
  }
  if (peerFailed) {
    recordDurableSyncDiagnostics(accumulator, { failedPeers: 1 });
  }
  const result = finalizeDurableSyncCompletion(accumulator);
  if (result.insertedTriples > 0) {
    logInfo(ctx, `Sync complete: ${result.insertedTriples} verified triples from ${remotePeerId}`);
  }
  const exactFetchDisposition = exactFetchDispositions.reduce<ExactDurableFetchDisposition | undefined>(
    mergeExactDurableFetchDisposition,
    undefined,
  );

  return {
    result,
    ...(exactFetchDisposition ? { exactFetchDisposition } : {}),
  };
}

function partitionVerifiedGraphScopedAssets(
  contextGraphId: string,
  verifiedData: Quad[],
  verifiedMeta: Quad[],
  verifiedGraphs: readonly string[],
): {
  assets: VerifiedGraphScopedAsset[];
  remainingData: Quad[];
  remainingMeta: Quad[];
} {
  const graphSet = new Set(verifiedGraphs);
  // Apply the peer-control quarantine only to graph-scoped metadata subjects.
  // Legacy read-only KAs still rely on their already-verified status/access
  // rows, and stripping those globally would make an otherwise valid legacy
  // snapshot unreadable. An assertionVersion-only subject is included here as
  // a fail-closed torn-V2 marker even when its remaining envelope is missing.
  const graphScopedMetadataSubjects = new Set(
    verifiedMeta
      .filter((quad) => (
        quad.predicate === CONTENT_SCOPE_VERSION
        || quad.predicate === ASSERTION_GRAPH
        || quad.predicate === ASSERTION_VERSION
      ))
      .map((quad) => quad.subject),
  );
  // These predicates participate in local stale-write control. A peer may
  // supply assertionVersion only inside a fully verified graph-scoped asset;
  // materializedVersion is never peer-owned.
  const peerSafeMetadata = verifiedMeta.filter(
    (quad) => (
      !graphScopedMetadataSubjects.has(quad.subject)
      || !PEER_UNTRUSTED_METADATA_PREDICATES.has(quad.predicate)
    ),
  );
  if (graphSet.size === 0) {
    return {
      assets: [],
      remainingData: verifiedData,
      remainingMeta: peerSafeMetadata.filter((quad) => !(
        graphScopedMetadataSubjects.has(quad.subject)
        && quad.predicate === ASSERTION_VERSION
      )),
    };
  }

  const dataByGraph = new Map<string, Quad[]>();
  const remainingData: Quad[] = [];
  for (const quad of verifiedData) {
    if (!graphSet.has(quad.graph)) {
      remainingData.push(quad);
      continue;
    }
    const graphQuads = dataByGraph.get(quad.graph) ?? [];
    graphQuads.push(quad);
    dataByGraph.set(quad.graph, graphQuads);
  }

  const ualByGraph = new Map<string, Set<string>>();
  const metadataBySubject = new Map<string, Quad[]>();
  for (const quad of peerSafeMetadata) {
    const subjectQuads = metadataBySubject.get(quad.subject) ?? [];
    subjectQuads.push(quad);
    metadataBySubject.set(quad.subject, subjectQuads);
  }
  // One V2 KA has two legitimate metadata subjects that may point at the same
  // exact graph: the self-bound UAL descriptor and the name-keyed lifecycle
  // row. Only the descriptor owns the graph. Treating every assertionGraph
  // pointer as an owner rejects normal publishes as "2 metadata owners".
  //
  // The self-binding is also a fail-closed boundary: a second complete KA
  // descriptor must carry `<candidate> dkg:kaUal <candidate>` and therefore is
  // still counted as a conflicting owner, while lifecycle/provenance pointers
  // cannot impersonate one merely by naming the exact graph.
  const descriptorSubjects = new Set(
    [...metadataBySubject.entries()]
      .filter(([subject, quads]) => quads.some(
        (quad) => quad.predicate === KA_UAL && stripLiteral(quad.object) === subject,
      ))
      .map(([subject]) => subject),
  );
  for (const quad of peerSafeMetadata) {
    if (quad.predicate !== ASSERTION_GRAPH || !descriptorSubjects.has(quad.subject)) continue;
    const graph = stripLiteral(quad.object);
    if (!graphSet.has(graph)) continue;
    const owners = ualByGraph.get(graph) ?? new Set<string>();
    owners.add(quad.subject);
    ualByGraph.set(graph, owners);
  }

  const assets: VerifiedGraphScopedAsset[] = [];
  const handledUals = new Set<string>();
  for (const assertionGraph of [...graphSet].sort()) {
    const owners = ualByGraph.get(assertionGraph);
    if (!owners || owners.size !== 1) {
      throw new Error(`Verified graph-scoped assertion ${assertionGraph} has ${owners?.size ?? 0} metadata owners`);
    }
    const [ual] = owners;
    // Carry only structural fields plus the bounded provenance discriminator
    // and receipt claim consumed by the chain authenticator below. ACLs,
    // status, timestamps, and local ordering are never accepted as trusted
    // controls from a peer.
    const metadataQuads = (metadataBySubject.get(ual) ?? []).filter(
      (quad) => GRAPH_SCOPED_SYNC_METADATA_PREDICATES.has(quad.predicate),
    );
    const versions = new Set(
      metadataQuads
        .filter((quad) => quad.predicate === ASSERTION_VERSION)
        .map((quad) => stripLiteral(quad.object)),
    );
    if (versions.size !== 1) {
      throw new Error(`Verified graph-scoped KA ${ual} has ${versions.size} assertion versions`);
    }
    const [versionRaw] = versions;
    if (!versionRaw || !/^\d+$/.test(versionRaw)) {
      throw new Error(`Verified graph-scoped KA ${ual} has invalid assertionVersion ${versionRaw ?? '<missing>'}`);
    }
    try {
      readGraphKnowledgeAssetConfirmationKindV1(metadataQuads);
    } catch (cause) {
      throw new Error(
        `Verified graph-scoped KA ${ual} has invalid confirmation metadata`,
        { cause },
      );
    }
    const metaGraphs = new Set(metadataQuads.map((quad) => quad.graph));
    if (metaGraphs.size !== 1) {
      throw new Error(`Verified graph-scoped KA ${ual} spans ${metaGraphs.size} metadata graphs`);
    }
    const [metaGraph] = metaGraphs;
    const expectedContextGraph = `did:dkg:context-graph:${contextGraphId}`;
    const contextGraphs = new Set(
      metadataQuads
        .filter((quad) => quad.predicate === CONTEXT_GRAPH)
        .map((quad) => stripLiteral(quad.object)),
    );
    if (
      metaGraph !== `${expectedContextGraph}/_meta`
      || contextGraphs.size !== 1
      || !contextGraphs.has(expectedContextGraph)
    ) {
      throw new Error(
        `Verified graph-scoped KA ${ual} is not bound to requested context graph ${contextGraphId}`,
      );
    }
    const identity = parseDeterministicKnowledgeAssetUal(ual);
    const batchId = packKnowledgeAssetIdFromIdentity(identity);
    metadataQuads.push({
      subject: ual,
      predicate: BATCH_ID,
      object: `"${batchId}"^^<${XSD_INTEGER}>`,
      graph: metaGraph,
    });
    assets.push({
      contextGraphId,
      ual,
      assertionVersion: BigInt(versionRaw),
      assertionGraph,
      metaGraph,
      dataQuads: dataByGraph.get(assertionGraph) ?? [],
      metadataQuads,
    });
    handledUals.add(ual);
  }

  return {
    assets,
    remainingData,
    remainingMeta: peerSafeMetadata.filter(
      (quad) => (
        !handledUals.has(quad.subject)
        && !(
          graphScopedMetadataSubjects.has(quad.subject)
          && quad.predicate === ASSERTION_VERSION
        )
      ),
    ),
  };
}

function stripLiteral(raw: string): string {
  const match = raw.match(/^"(.*)"(?:\^\^.*|@.*)?$/);
  return match ? match[1]! : raw;
}
