import { prepareDurableMetaPhase, type PreparedDurableMeta } from './durable-meta-phase.js';
import { createManifestSettlementCheckpointer } from './manifest-settlement-checkpointer.js';
import { DurableGraphSettlementGuard, type StoredDurablePrefix } from './durable-prefix-proof.js';
import type { DurableMetaContinuation } from './durable-meta-continuation.js';
import type { GraphOwnedRecoveryContext } from './graph-owned-recovery.js';
import { verifyDurablePage, prepareDurableVerifiedPage, persistDurableRemainingMetadata, persistDurableHoldingsMetadata } from './durable-verified-page.js';
export type { DurableMetaContinuation, DurableMetaContinuationState } from './durable-meta-continuation.js';
import type { DurableRecoveryRoundDecision, DurableRecoveryRoundOutcome } from '../durable-recovery-round.js';
import type { VerifiedDurableBoundary } from '../durable-recovery-boundary-seed.js';
import { physicalDurableSyncResult, type DetailedDurableSyncResult } from './durable-sync-result.js';
import { randomUUID } from 'node:crypto';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { PhaseCallback } from '@origintrail-official/dkg-publisher';
import type { DurableBatchVerificationMode } from '../../sync-verify-worker.js';
import {
  graphScopedDurableManifestPrefixAtOffset,
  isGraphScopedDurableManifestBoundary,
  planBoundedGraphScopedDurableBatch,
  type GraphScopedDurableManifestPlan,
} from '../durable-integrity.js';
import {
  didSyncPeerRespond,
  isSyncBackoffWorthyError,
  isSyncPermanentRejection,
  isSyncTargetSupersededError,
  isSyncTransportFailure,
} from '../error-tags.js';
import {
  createDurableSyncAccumulator,
  finalizeDurableSyncCompletion,
  mergeDurableSyncAccumulatorInto,
  type DurableSyncAccumulator,
  markDurableTerminalBoundary,
  recordDurableSyncDiagnostics,
  type InitializedDurableSyncResult,
} from '../durable-progress.js';
import {
  getSyncCheckpointKey,
  type DurableManifestDigest,
  type DurableManifestPrefixDigest,
  type SyncCheckpointScope,
} from '../checkpoint/state.js';
import type { SyncPageProgress, SyncPageResult } from './page-fetch.js';
import type {
  ChallengePinnedGraphScopedAsset,
  GraphScopedMaterializationOutcome,
  VerifiedGraphScopedAsset,
} from './graph-scoped-materialization.js';
import {
  partitionVerifiedGraphScopedAssets,
} from './verified-asset-preparation.js';
import type { DurableSyncBudget } from './durable-sync-budget.js';
import { createDurableDataRoundBoundary } from './durable-data-round.js';
import { prepareDurableHoldingsPhase, type PreparedHoldingsSettlement } from './durable-holdings-phase.js';
import { settleDurableDataFromHoldings, type DurableHoldingsPlan } from './durable-data-holdings.js';
import {
  normalizeDurableSyncContext,
  type LegacyDurableSyncContext, type NormalizedDurableSyncContext,
} from './durable-sync-compat.js';
import {
  classifyExactDurableFetch,
  classifyExactAssetResponderCapability,
  exactAssetFetchSessionPolicy,
  filterExactAssetDurablePayload,
  mergeExactAssetResponderCapability,
  mergeExactDurableFetchDisposition,
  type ExactAssetFetchSessionPolicy,
  type ExactAssetResponderCapability,
  type ExactDurableFetchDisposition,
} from './exact-durable-fetch.js';
import {
  exactAssetCommitmentsForSelection,
  exactAssetUalsForSelection,
  type ChallengePinnedExactAssetSelection,
  type ExactAssetCommitment,
  type ExactAssetSelection,
  type UalOnlyExactAssetSelection,
} from '../exact-assets.js';

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
export {
  assertNoLegacyRfc64ControlGraphs,
  partitionVerifiedGraphScopedAssets,
} from './verified-asset-preparation.js';
export type {
  ExactAssetResponderCapability,
  ExactDurableFetchDisposition,
} from './exact-durable-fetch.js';

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

export type { DetailedDurableSyncResult } from './durable-sync-result.js';

/** Invocation-local proof material returned by the non-durable exact fetch. */
export interface ChallengeExactAssetFetchResult {
  readonly result: InitializedDurableSyncResult;
  readonly disposition: ExactDurableFetchDisposition;
  readonly authenticatedAssets: readonly ChallengePinnedGraphScopedAsset[];
}

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
  readonly durableResumeBoundary?: VerifiedDurableBoundary;
  /** Canonical descriptor-prefix proof for safe cross-generation reuse. */
  readonly manifestPrefixDigestAtOffset?: (
    offset: number,
  ) => DurableManifestPrefixDigest | undefined;
  /**
   * Rebuild the responder row list instead of resuming an earlier phase.
   * Verified META and unbound DATA requests use this when a saved responder
   * session cannot prove the complete graph generation required for reuse.
   */
  readonly forceFreshSession?: boolean;
  /** Soft, progress-only page boundary supplied by a recovery owner. */
  readonly shouldStopAfterPage?: (progress: SyncPageProgress) => boolean;
  readonly returnAcceptedPrefixOnRetryableTransportFailure?: boolean;
  readonly requesterScope?: SyncCheckpointScope;
  /** Proof bytes own an invocation-local page/session store with terminal cleanup. */
  readonly ephemeralRequesterState?: boolean;
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

export interface DurableSyncChallengePinnedAuthenticationRequest
  extends DurableSyncGraphScopedStoreRequest {
  readonly commitment: ExactAssetCommitment;
}

export type DurableSyncCheckpointWrite =
  | {
      readonly offset: number;
      readonly responderSessionOffset?: number;
      readonly binding?: never;
    }
  | {
      readonly offset: number;
      readonly responderSessionOffset?: number;
      readonly binding: {
        readonly manifestDigest: DurableManifestDigest;
        readonly manifestPrefixDigest: DurableManifestPrefixDigest;
        readonly terminal: boolean;
      };
    };

function prepareDurableVerificationPayload(input: {
  readonly rawDataResult: SyncPageResult;
  readonly rawMetaResult: SyncPageResult;
  readonly preparedMeta: PreparedDurableMeta;
  readonly exactAssetSelection?: ExactAssetSelection;
}): {
  readonly dataResult: SyncPageResult;
  readonly metaResult: SyncPageResult;
  readonly exactDescriptorCoverageComplete: boolean;
  readonly exactReturnedDescriptorCount: number;
} {
  if (input.exactAssetSelection === undefined) {
    return {
      dataResult: input.rawDataResult,
      metaResult: input.preparedMeta.metaForManifest,
      exactDescriptorCoverageComplete:
        input.preparedMeta.exactDescriptorCoverageComplete,
      exactReturnedDescriptorCount: 0,
    };
  }
  const exact = filterExactAssetDurablePayload(
    input.rawDataResult.quads,
    input.rawMetaResult.quads,
    input.exactAssetSelection,
  );
  const exactDataSet = new Set(exact.dataQuads);
  const exactDataRawOffsets = input.rawDataResult.quadRawOffsets?.filter(
    (_, index) => exactDataSet.has(input.rawDataResult.quads[index]!),
  );
  return {
    metaResult: { ...input.rawMetaResult, quads: exact.metaQuads },
    dataResult: {
      ...input.rawDataResult,
      quads: exact.dataQuads,
      ...(exactDataRawOffsets
        ? { quadRawOffsets: exactDataRawOffsets }
        : { quadRawOffsets: undefined }),
    },
    exactDescriptorCoverageComplete: exact.descriptorCoverageComplete,
    exactReturnedDescriptorCount: exact.returnedDescriptorCount,
  };
}

export interface DurableSyncCommonPorts {
  ctx: OperationContext;
  remotePeerId: string;
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
  /**
   * Soft scheduling boundary for graph-scoped settlement. The requester
   * always lets one asset cross authentication + atomic materialization, then
   * yields at the next manifest-bound checkpoint instead of starting another.
   */
  settlementSliceDeadline?: number;
  /** Whole-operation cancellation propagated by bounded foreground callers. */
  signal?: AbortSignal;
  storedPrefix?: StoredDurablePrefix;
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
  /** The recovery policy admits the entire verified page before its first commit. */
  admitVerifiedPage?: (page: ReturnType<typeof partitionVerifiedGraphScopedAssets>) => void;
  logInfo: (ctx: OperationContext, message: string) => void;
  logWarn: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}

export interface DurableSyncPageTransport {
  fetchSyncPages: (request: DurableSyncFetchRequest) => Promise<SyncPageResult>;
}
export interface DurableSyncCheckpointPorts {
  deleteCheckpoint: (key: string) => void;
  setCheckpoint: (key: string, checkpoint: DurableSyncCheckpointWrite) => void;
}
export interface DurableSyncMaterializationPorts {
  /** Exact replacement path for verified V2 KAs; absent capability fails closed. */
  storeGraphScopedAsset?: (
    request: DurableSyncGraphScopedStoreRequest,
  ) => Promise<GraphScopedMaterializationOutcome>;
}
interface DurableGraphScanOptions {
  /**
   * Phase C — optional, gap-safe per-CG delta high-water mark resolver. When it
   * returns a value for a CG, the durable DATA fetch carries `sinceBatchId` and
   * the responder returns only KAs with `dkg:batchId` greater than it. MUST be
   * backed by a CONTIGUOUS watermark. Undefined ⇒ full scan (default today).
   */
  sinceBatchIdFor?: (contextGraphId: string) => string | undefined;
  /** Runs after verified snapshot writes and before phase checkpoints advance. */
  onVerifiedFullSnapshot?: (snapshot: VerifiedFullSnapshot) => Promise<void>;
}

/** Ordinary fanout adds selection and durable materialization to the shared physical ports. */
export interface DurableSyncContext extends DurableSyncCommonPorts, DurableSyncPageTransport,
  DurableSyncCheckpointPorts, DurableSyncMaterializationPorts, DurableGraphScanOptions {
  contextGraphIds: string[];
  /** Atomic exact selection for durable VM recovery; undefined retains normal full/delta sync. */
  exactAssetSelectionFor?: (
    contextGraphId: string,
  ) => UalOnlyExactAssetSelection | undefined;
  exactAssetFetchPolicyFor?: (contextGraphId: string) => Exclude<ExactAssetFetchSessionPolicy, { kind: 'ephemeral-challenge' }> | undefined;
}

/** One graph's owned full recovery has no selection, delta or snapshot consumer. */
export interface GraphOwnedDurableSyncContext extends DurableSyncCommonPorts, DurableSyncPageTransport,
  DurableSyncCheckpointPorts, DurableSyncMaterializationPorts {
  readonly contextGraphId: string;
  readonly recovery: GraphOwnedRecoveryContext;
}

/** Challenge retrieval adds its authentication consumer and never receives durable checkpoints. */
export interface ChallengeExactAssetFetchContext extends DurableSyncCommonPorts, DurableSyncPageTransport,
  DurableGraphScanOptions {
  contextGraphIds: string[];
  challengeSelectionFor: (contextGraphId: string) => ChallengePinnedExactAssetSelection;
  authenticateChallengePinnedAsset: (
    request: DurableSyncChallengePinnedAuthenticationRequest,
  ) => Promise<ChallengePinnedGraphScopedAsset>;
}

interface InternalDurableSyncContext extends Omit<
  NormalizedDurableSyncContext,
  'exactAssetFetchPolicyFor'
> {
  exactAssetFetchPolicyFor?: (contextGraphId: string) => ExactAssetFetchSessionPolicy | undefined;
  authenticateChallengePinnedAsset?: (
    request: DurableSyncChallengePinnedAuthenticationRequest,
  ) => Promise<ChallengePinnedGraphScopedAsset>;
  proofOnlyChallengeFetch?: boolean;
  proofRequesterScope?: `challenge-exact:${string}`;
}

interface InternalDetailedDurableSyncResult extends DetailedDurableSyncResult {
  readonly authenticatedExactAssets?: readonly ChallengePinnedGraphScopedAsset[];
}

type DurableDataPlan =
  | { readonly kind: 'fetch'; readonly boundary?: VerifiedDurableBoundary;
      readonly continuation?: 'full-graph' | 'reconsider-holdings' }
  | { readonly kind: 'metadata'; readonly settlement: PreparedHoldingsSettlement };
interface DurableDataPolicy {
  readonly metaContinuation?: DurableMetaContinuation;
  selectDataPlan(meta: PreparedDurableMeta): Promise<DurableDataPlan>;
}

/** Physical DATA outcome; only the owned entry translates it into an owner decision. */
type DurableGraphSettlement =
  | { readonly kind: 'not-started' }
  | { readonly kind: 'fetch'; readonly graphScoped: boolean;
      readonly continuation: 'full-graph' | 'reconsider-holdings' }
  | { readonly kind: 'metadata'; readonly plan: Exclude<DurableHoldingsPlan, { kind: 'full' }> };
interface DurableGraphExecutionResult extends Omit<InternalDetailedDurableSyncResult, 'result'> {
  /** Unfinalized physical counters and terminal boundaries fold without losing evidence. */
  readonly progress: DurableSyncAccumulator;
  readonly settlement: DurableGraphSettlement;
  readonly rejectedResumeOffset?: number;
  readonly continueFanout: boolean;
}
interface DurableGraphExecutionContext extends Omit<InternalDurableSyncContext, 'contextGraphIds'> {
  readonly contextGraphId: string;
  readonly remainingContextGraphs: number;
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
  return physicalDurableSyncResult(await runDurableSyncWithBudget(normalizeDurableSyncContext(context)));
}

/** One graph and its owner capabilities enter together; ordinary/exact inputs carry neither. */
export async function runGraphOwnedDurableSyncDetailed(
  context: GraphOwnedDurableSyncContext,
): Promise<DurableRecoveryRoundOutcome> {
  const { contextGraphId, recovery, ...sharedContext } = context;
  const graph = await executeDurableGraph(
    { ...sharedContext, contextGraphId, remainingContextGraphs: 1 }, {
      metaContinuation: recovery.meta,
      selectDataPlan: async preparedMeta => {
        const prepared = await prepareDurableHoldingsPhase({ context: sharedContext, contextGraphId,
          manifest: preparedMeta.manifestPlan, recovery });
        return prepared.kind === 'metadata' ? prepared
          : { ...prepared, boundary: recovery.boundary };
      },
    });
  const settlement = graph.settlement;
  let decision: DurableRecoveryRoundDecision;
  switch (settlement.kind) {
    case 'not-started': decision = { strategy: 'not-started' }; break;
    case 'fetch': decision = settlement.graphScoped
      ? { strategy: 'full', continuation: settlement.continuation } : { strategy: 'legacy' }; break;
    case 'metadata': decision = settlement.plan.kind === 'held'
      ? { strategy: 'held' } : { strategy: 'exact-missing', batches: settlement.plan.batches }; break;
  }
  return { result: finishDurableSync(sharedContext, graph.progress),
    decision: graph.rejectedResumeOffset === undefined ? decision
      : { ...decision, rejectedResumeOffset: graph.rejectedResumeOffset } };
}

export async function runChallengeExactAssetFetch(
  context: ChallengeExactAssetFetchContext,
): Promise<ChallengeExactAssetFetchResult> {
  const {
    challengeSelectionFor,
    authenticateChallengePinnedAsset,
    ...sharedContext
  } = context;
  const detailed = await runDurableSyncWithBudget({
    ...sharedContext,
    exactAssetFetchPolicyFor: (contextGraphId) => exactAssetFetchSessionPolicy(challengeSelectionFor(contextGraphId)),
    authenticateChallengePinnedAsset,
    // Proof bytes are invocation-local. The proof-only entry point cannot
    // observe or mutate durable checkpoints, and the executor forces fresh
    // responder sessions for both phases.
    deleteCheckpoint: () => undefined,
    setCheckpoint: () => undefined,
    proofOnlyChallengeFetch: true,
    proofRequesterScope: `challenge-exact:${randomUUID()}`,
  });
  return {
    result: detailed.result,
    disposition: detailed.exactFetchDisposition ?? 'incomplete',
    authenticatedAssets: detailed.authenticatedExactAssets ?? [],
  };
}

/** Fanout aggregates physical graph results; owner policy never enters this loop. */
async function runDurableSyncWithBudget(context: InternalDurableSyncContext): Promise<InternalDetailedDurableSyncResult> {
  const { contextGraphIds, ...sharedContext } = context;
  const progress = createDurableSyncAccumulator();
  let exactFetchDisposition: ExactDurableFetchDisposition | undefined;
  let exactResponderCapability: ExactAssetResponderCapability | undefined;
  const authenticatedExactAssets: ChallengePinnedGraphScopedAsset[] = [];
  const committedExactAssetUals: string[] = [];
  for (const [index, contextGraphId] of contextGraphIds.entries()) {
    const graph = await executeDurableGraph({ ...sharedContext, contextGraphId,
      remainingContextGraphs: contextGraphIds.length - index });
    mergeDurableSyncAccumulatorInto(progress, graph.progress);
    if (graph.exactFetchDisposition !== undefined) {
      exactFetchDisposition = mergeExactDurableFetchDisposition(exactFetchDisposition, graph.exactFetchDisposition);
      exactResponderCapability = mergeExactAssetResponderCapability(exactResponderCapability, graph.exactResponderCapability);
    }
    authenticatedExactAssets.push(...graph.authenticatedExactAssets ?? []);
    committedExactAssetUals.push(...graph.committedExactAssetUals ?? []);
    if (!graph.continueFanout) break;
  }
  return {
    result: finishDurableSync(context, progress),
    ...(exactFetchDisposition ? { exactFetchDisposition, committedExactAssetUals: Object.freeze(committedExactAssetUals) } : {}),
    ...(exactResponderCapability ? { exactResponderCapability } : {}),
    ...(authenticatedExactAssets.length === 0 ? {} : { authenticatedExactAssets: Object.freeze(authenticatedExactAssets) }),
  };
}

function finishDurableSync(
  context: Pick<DurableSyncContext, 'ctx' | 'remotePeerId' | 'logInfo'>,
  progress: DurableSyncAccumulator,
): InitializedDurableSyncResult {
  const result = finalizeDurableSyncCompletion(progress);
  if (result.insertedTriples > 0) {
    context.logInfo(context.ctx, `Sync complete: ${result.insertedTriples} verified triples from ${context.remotePeerId}`);
  }
  return result;
}

async function executeDurableGraph(
  context: DurableGraphExecutionContext,
  dataPolicy?: DurableDataPolicy,
): Promise<DurableGraphExecutionResult> {
  const {
    ctx,
    remotePeerId,
    contextGraphId: pid,
    remainingContextGraphs,
    onPhase,
    onAccessDenied,
    syncAgentsMeta = true,
    durableSyncBudget,
    settlementSliceDeadline,
    signal,
    fetchSyncPages,
    sinceBatchIdFor,
    exactAssetFetchPolicyFor,
    stopOnBackoffWorthyFailure = false,
    storeInsert,
    storeGraphScopedAsset,
    authenticateChallengePinnedAsset,
    proofOnlyChallengeFetch = false,
    proofRequesterScope,
    onVerifiedFullSnapshot,
    deleteCheckpoint,
    setCheckpoint,
    logInfo,
    logWarn,
    logDebug,
  } = context;

  const fetchContext = (deadline: number): DurableSyncFetchContext => ({
    deadline,
    signal,
  });

  const accumulator = createDurableSyncAccumulator();
  let exactFetchDisposition: ExactDurableFetchDisposition | undefined;
  let exactResponderCapability: ExactAssetResponderCapability | undefined;
  const authenticatedExactAssets: ChallengePinnedGraphScopedAsset[] = [];
  const committedExactAssetUals: string[] = [];

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
      setCheckpoint(result.checkpointKey, {
        offset: result.nextOffset,
        responderSessionOffset: result.rawNextOffset,
        binding: {
          manifestDigest: options.manifestPlan.manifestDigest,
          manifestPrefixDigest: prefix.prefixDigest,
          terminal: true,
        },
      });
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
        setCheckpoint(result.checkpointKey, {
          offset: result.nextOffset,
          responderSessionOffset: result.rawNextOffset,
          binding: {
            manifestDigest: options.manifestPlan.manifestDigest,
            manifestPrefixDigest: prefix.prefixDigest,
            terminal: false,
          },
        });
      } else {
        setCheckpoint(result.checkpointKey, {
          offset: result.nextOffset,
          responderSessionOffset: result.rawNextOffset,
        });
      }
    }
  };

  const shouldStopAfterBackoffWorthyFailure = (contextGraphId: string, reason: string): boolean => {
    if (!stopOnBackoffWorthyFailure) return false;
    logInfo(ctx, `Stopping durable sync fanout for ${remotePeerId} after "${contextGraphId}" (${reason})`);
    return true;
  };
  const settlement = new DurableGraphSettlementGuard(() => {
    if (signal?.aborted) throw normalizeDurableSyncAbortReason(signal.reason);
  });
  let rejectedResumeOffset: number | undefined;
  let graphSettlement: DurableGraphSettlement = { kind: 'not-started' };
  let heldSettlement: PreparedHoldingsSettlement | undefined;
  let activePhase: 'fetch' | 'verify' | 'store' | undefined;
  let peerRespondedForContextGraph = false;
  const startPhase = (phase: 'fetch' | 'verify' | 'store') => {
    activePhase = phase;
    onPhase?.(phase, 'start');
  };
  const endPhase = () => {
    if (!activePhase) return;
    onPhase?.(activePhase, 'end');
    activePhase = undefined;
  };

  const finishGraph = (continueFanout = true): DurableGraphExecutionResult => ({
    progress: accumulator, settlement: graphSettlement, rejectedResumeOffset, continueFanout,
    ...(exactFetchDisposition ? { exactFetchDisposition, committedExactAssetUals: Object.freeze([...committedExactAssetUals]) } : {}),
    ...(exactResponderCapability ? { exactResponderCapability } : {}),
    ...(authenticatedExactAssets.length === 0 ? {} : { authenticatedExactAssets: Object.freeze([...authenticatedExactAssets]) }),
  });

  try {
    settlement.assertCurrent();
    const dataGraph = contextGraphDataGraphUri(pid);
    const metaGraph = contextGraphMetaGraphUri(pid);
    const isSystemContextGraph = (Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(pid);
    const contextGraphBudget = durableSyncBudget.createContextGraphBudget({
      contextGraphId: pid,
      remainingContextGraphs,
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
    const sinceBatchId = sinceBatchIdFor?.(pid);
    const exactFetchPolicy = exactAssetFetchPolicyFor?.(pid);
    const exactAssetSelection = exactFetchPolicy?.selection;
    const isProofOnlyChallengeFetch = exactFetchPolicy?.kind === 'ephemeral-challenge';
    if (isProofOnlyChallengeFetch && !proofOnlyChallengeFetch) {
      throw new Error('Challenge-pinned exact retrieval requires the proof-only entry point');
    }
    const exactAssetUals = exactAssetSelection === undefined
      ? undefined
      : exactAssetUalsForSelection(exactAssetSelection);
    const challengeCommitments = new Map(
      exactAssetSelection === undefined
        ? []
        : (exactAssetCommitmentsForSelection(exactAssetSelection) ?? [])
            .map((commitment) => [commitment.assetUal, commitment]),
    );
    const exactRequesterScope: SyncCheckpointScope | undefined =
      isProofOnlyChallengeFetch
        ? proofRequesterScope ?? exactFetchPolicy.requesterScope
        : exactFetchPolicy?.requesterScope;
    const rootlessVerifiedFullSnapshot = sinceBatchId === undefined
      && !isSystemContextGraph;
    if (exactAssetUals !== undefined) {
      exactFetchDisposition = 'incomplete';
    }

    logInfo(ctx, `Syncing context graph "${pid}" from ${remotePeerId}`);

    const skipAgentsMeta = pid === SYSTEM_CONTEXT_GRAPHS.AGENTS && syncAgentsMeta === false;
    const createPhaseFetcher = (durableMetaContinuation?: DurableMetaContinuation, durableResumeBoundary?: VerifiedDurableBoundary) => (
      phase: 'data' | 'meta',
      graphUri: string,
      sinceBatchId?: string,
      manifestDigest?: DurableManifestDigest,
      manifestPrefixDigestAtOffset?: (
        offset: number,
      ) => DurableManifestPrefixDigest | undefined,
      forceFreshSession?: boolean,
      shouldStopAfterPage?: (progress: SyncPageProgress) => boolean,
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
      durableResumeBoundary: phase === 'data' ? durableResumeBoundary : undefined,
      // DATA safely resumes at verified graph boundaries. META is the
      // manifest that proves those boundaries, so resuming it independently
      // would return only a suffix and make the DATA prefix unverifiable.
      // The durable recovery coordinator retains and validates its own META
      // prefix across slices, so its scoped continuation must remain resumable.
      forceFreshSession: exactFetchPolicy?.forceFreshSession === true
        || forceFreshSession
        || (
          phase === 'meta'
          && rootlessVerifiedFullSnapshot
          && durableMetaContinuation === undefined
        ),
      shouldStopAfterPage,
      ...(phase === 'meta' && durableMetaContinuation
        ? { returnAcceptedPrefixOnRetryableTransportFailure: true }
        : {}),
      requesterScope: exactRequesterScope
        ?? (phase === 'meta' ? durableMetaContinuation?.requesterScope : undefined),
      ephemeralRequesterState: isProofOnlyChallengeFetch || undefined,
      fetchContext: fetchContext(phase === 'meta' ? metaFetchDeadline : deadline),
    });
    // One graph scope owns phase order, accounting, checkpoint effects and finalization.
    const continuation = dataPolicy?.metaContinuation;
    startPhase('fetch');
    const fetchStartedAt = Date.now();
    if (skipAgentsMeta) logInfo(ctx, `Skipping agents meta sync from ${remotePeerId} (syncAgentsMeta=false)`);
    const rawMetaResult: SyncPageResult = skipAgentsMeta
      ? { quads: [], bytesReceived: 0, resumedFromOffset: 0, nextOffset: 0,
        checkpointKey: getSyncCheckpointKey(remotePeerId, pid, false, 'meta'), completed: true, timedOut: false }
      : await createPhaseFetcher(continuation)('meta', metaGraph);
    if (!skipAgentsMeta) peerRespondedForContextGraph = true;
    settlement.assertCurrent();
    const metaPhase = prepareDurableMetaPhase({ contextGraphId: pid, rawMetaResult,
      buildsManifest: sinceBatchId === undefined && !isSystemContextGraph, exactAssetSelection,
      retainPrefix: !skipAgentsMeta && continuation !== undefined, retained: continuation?.state });
    if (continuation) continuation.state = metaPhase.kind === 'retained' ? metaPhase.state : undefined;
    if (metaPhase.kind === 'rejected') {
      for (const key of metaPhase.discardCheckpoints) deleteCheckpoint(key);
      throw metaPhase.error;
    }
    if (metaPhase.kind === 'retained') {
      recordPhaseOutcome(rawMetaResult, { updateCheckpoint: true });
      throw Object.assign(new Error(`Retained bounded durable META prefix for "${pid}" through raw offset ${metaPhase.state.rawNextOffset}`),
        { code: 'SYNC_META_CONTINUATION_PENDING' });
    }
    const { preparedMeta, metaResult } = metaPhase;
    const dataPlan = await dataPolicy?.selectDataPlan(preparedMeta) ?? { kind: 'fetch' as const };
    if (dataPlan.kind === 'metadata') {
      heldSettlement = dataPlan.settlement;
      const held = heldSettlement;
      const assertHeldCurrent = () => { settlement.assertCurrent(); held.assertCurrent(); };
      assertHeldCurrent();
      await persistDurableHoldingsMetadata(context, pid, metaResult, held.descriptors, accumulator, assertHeldCurrent);
      assertHeldCurrent();
      recordPhaseOutcome(metaResult, { updateCheckpoint: true });
      logInfo(ctx, settleDurableDataFromHoldings({ plan: held.plan, remotePeerId, contextGraphId: pid,
        manifest: held.manifest, metaResult, accumulator, deleteCheckpoint, setCheckpoint }));
      graphSettlement = { kind: 'metadata', plan: held.plan };
      endPhase();
      return finishGraph();
    }
    graphSettlement = { kind: 'fetch', graphScoped: preparedMeta.manifestPlan !== null,
      continuation: dataPlan.continuation ?? 'full-graph' };
    const graphScopedManifest = preparedMeta.manifestPlan;
    const fetchPhase = createPhaseFetcher(undefined, dataPlan.boundary);
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
      preparedMeta.forceFreshUnboundDataSession || (graphScopedManifest !== null && !context.storedPrefix),
      // A full-graph round holds what it fetched until it is verified and
      // stored, so it ends at a checkpointable graph within a row/heap budget.
      // A caller that needs one complete snapshot from row 0 keeps one round.
      graphScopedManifest && exactAssetUals === undefined && onVerifiedFullSnapshot === undefined
        ? createDurableDataRoundBoundary({ manifest: graphScopedManifest, settlementSliceDeadline,
            onHardLimit: ({ resumedFromOffset, nextOffset, acceptedQuads }) => logWarn(ctx,
              `Durable data round for "${pid}" reached its hard limit at ${acceptedQuads} rows `
                + `(offset ${resumedFromOffset}->${nextOffset}) without a complete graph to checkpoint`) })
        : undefined,
    );
    settlement.assertCurrent();
    peerRespondedForContextGraph = true;
    endPhase();
    const fetchDurationMs = Date.now() - fetchStartedAt;
    const preparedPayload = prepareDurableVerificationPayload({
      rawDataResult,
      rawMetaResult: metaResult,
      preparedMeta,
      exactAssetSelection,
    });
    const dataResult = preparedPayload.dataResult;
    const effectiveMetaResult = preparedPayload.metaResult;
    const exactAssetDescriptorCoverageComplete =
      preparedPayload.exactDescriptorCoverageComplete;
    const exactAssetReturnedDescriptorCount =
      preparedPayload.exactReturnedDescriptorCount;
    if (exactAssetUals !== undefined && !exactAssetDescriptorCoverageComplete) {
      logWarn(
        ctx,
        `Exact durable response for "${pid}" did not cover every requested asset descriptor`,
      );
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
        ? graphScopedManifest !== null
          && isGraphScopedDurableManifestBoundary(
            graphScopedManifest,
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
      const responderCursorDelta = (dataResult.rawNextOffset ?? dataResult.nextOffset)
        - (dataResult.rawResumedFromOffset ?? dataResult.resumedFromOffset);
      if (responderCursorDelta !== dataResult.quads.length) {
        logWarn(
          ctx,
          `Rootless durable cursor drift for "${pid}": responder advanced `
            + `${responderCursorDelta} row(s) but delivered ${dataResult.quads.length}; `
            + 'projecting only the verified complete-graph prefix',
        );
      }
      const bounded = graphScopedManifest
        ? planBoundedGraphScopedDurableBatch(
            dataResult.quads,
            graphScopedManifest,
            dataResult.resumedFromOffset,
            dataResult.rawNextOffset ?? dataResult.nextOffset,
            dataResult.completed,
            dataResult.rawResumedFromOffset ?? dataResult.resumedFromOffset,
            dataResult.quadRawOffsets,
          )
        : null;
      if (!bounded && graphScopedManifest) {
        deleteCheckpoint(dataResult.checkpointKey);
        if (dataResult.resumedFromOffset > 0) rejectedResumeOffset = dataResult.resumedFromOffset;
        throw Object.assign(
          new Error(
            `Discarding rootless durable response for "${pid}": responder and manifest coordinates cannot be reconciled`,
          ),
          { code: 'SYNC_DATA_CURSOR_UNMAPPABLE' },
        );
      }
      if (bounded) {
        dataForVerification = bounded.dataQuads;
        const boundedCompleted = dataResult.completed
          && bounded.safeNextOffset === bounded.manifestRowCount;
        if (boundedCompleted) {
          const { localYield: _impossibleLocalYield, ...completedResult } = dataResult;
          effectiveDataResult = {
            ...completedResult,
            quads: bounded.dataQuads,
            nextOffset: bounded.safeNextOffset,
            rawNextOffset: bounded.safeRawNextOffset,
            completed: true,
          };
        } else {
          effectiveDataResult = {
            ...dataResult,
            quads: bounded.dataQuads,
            nextOffset: bounded.safeNextOffset,
            rawNextOffset: bounded.safeRawNextOffset,
            completed: false,
          };
        }
        verificationMode = {
          kind: 'changelogPage',
          changedDataGraphs: bounded.changedDataGraphs,
        };
        logInfo(
          ctx,
          `Rootless durable progress for "${pid}": `
            + `${bounded.completedGraphCount} complete graph(s), `
            + `safe offset ${dataResult.resumedFromOffset}->${bounded.safeNextOffset} `
            + `of ${bounded.manifestRowCount} (raw ${dataResult.rawNextOffset ?? dataResult.nextOffset}->${bounded.safeRawNextOffset})`,
        );
      }
    }

    if (graphScopedManifest && dataResult.resumedFromOffset > 0) {
      await settlement.acquire(context.storedPrefix, graphScopedManifest, dataResult.resumedFromOffset, () => {
        deleteCheckpoint(dataResult.checkpointKey);
        deleteCheckpoint(metaResult.checkpointKey);
        rejectedResumeOffset = dataResult.resumedFromOffset;
      }, signal);
    }

    startPhase('verify');
    const verifyStartedAt = Date.now();
    let processed: Awaited<ReturnType<DurableSyncContext['processDurableBatchInWorker']>>;
    try {
      processed = await verifyDurablePage(
        context, dataForVerification,
        effectiveMetaResult.quads,
        isSystemContextGraph,
        verificationMode,
      );
    } catch (error) {
      if (graphScopedManifest && !signal?.aborted) deleteCheckpoint(rawDataResult.checkpointKey);
      throw error;
    }
    settlement.assertCurrent();
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
    const metaPhaseCanAdvance = batchVerifiedCleanly
      && processed.dataRejectedMissingMeta === 0
      && (
        !metadataOnlyResponse
        || processed.verifiedMeta.length > 0
        || discardedOnlyMetadataResponse
      );
    const dataPhaseCanAdvance = batchVerifiedCleanly
      && processed.dataRejectedMissingMeta === 0
      && !metadataOnlyResponse;
    const allowDurableCheckpoints = exactFetchPolicy?.allowDurableCheckpoints ?? true;
    const updateMetaCheckpoint = metaPhaseCanAdvance && allowDurableCheckpoints;
    const updateDataCheckpoint = dataPhaseCanAdvance && allowDurableCheckpoints;
    const reachedContextGraphTerminalBoundary = batchVerifiedCleanly
      && processed.dataRejectedMissingMeta === 0
      && exactAssetDescriptorCoverageComplete
      && metaPhaseCanAdvance
      && dataPhaseCanAdvance
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
    const settledExactResponderCapability = (): ExactAssetResponderCapability | undefined => {
      if (exactAssetSelection?.kind !== 'ual-only') return undefined;
      return classifyExactAssetResponderCapability({
        requestedAssetCount: exactAssetUals?.length ?? 0,
        metaResult,
        dataResult: rawDataResult,
        metaFetched: !skipAgentsMeta,
        descriptorCoverageComplete: exactAssetDescriptorCoverageComplete,
        returnedDescriptorCount: exactAssetReturnedDescriptorCount,
        rejectedKcs: processed.rejectedKcs,
        dataRejectedMissingMeta: processed.dataRejectedMissingMeta,
      });
    };
    // Metadata-only pages may move the meta cursor after storage, but they
    // still are not usable data progress for freshness/backoff accounting.
    if (
      processed.emptyResponses > 0 ||
      processed.dataRejectedMissingMeta > 0 ||
      (processed.verifiedData.length === 0 && processed.verifiedMeta.length === 0 && processed.metaOnlyResponses > 0)
    ) {
      await notifyVerifiedFullSnapshot();
      settlement.assertCurrent();
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
      if (exactFetchDisposition !== undefined) {
        exactFetchDisposition = settledExactDisposition();
        exactResponderCapability = settledExactResponderCapability();
      }
      if ((metaResult.timedOut || effectiveDataResult.timedOut)
        && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) return finishGraph(false);
      return finishGraph();
    }

    startPhase('store');
    const storeStartedAt = Date.now();
    const partitioned = prepareDurableVerifiedPage(context, pid, processed);
    if (partitioned.assets.length && exactAssetSelection?.kind !== 'challenge-pinned' && !storeGraphScopedAsset)
      throw Object.assign(new Error('Verified graph-scoped durable sync requires an exact materialization store path'),
        { code: 'VM_ATOMIC_REPLACE_UNSUPPORTED' });
    if (partitioned.assets.length && exactAssetSelection?.kind === 'challenge-pinned' && !authenticateChallengePinnedAsset)
      throw Object.assign(new Error('Challenge-pinned durable sync requires a proof-only authentication path'),
        { code: 'VM_CHALLENGE_AUTHENTICATION_UNSUPPORTED' });
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
          rawResumedFromOffset: effectiveDataResult.rawResumedFromOffset
            ?? effectiveDataResult.resumedFromOffset,
          maximumOffset: effectiveDataResult.nextOffset,
          dataQuads: effectiveDataResult.quads,
          quadRawOffsets: effectiveDataResult.quadRawOffsets,
          setCheckpoint,
        })
      : undefined;
    let incrementalCheckpointAdvanceRecorded = false;
    let mayYieldAtSettledManifestBoundary = false;
    let yieldedAtSettledManifestBoundary = false;
    const graphScopedAuthenticationDeadline = partitioned.assets.length > 0
      ? contextGraphBudget.createGraphScopedAuthenticationDeadline()
      : deadline;
    for (const [assetIndex, asset] of partitioned.assets.entries()) {
      // Bounded verification includes private-only assets in every round.
      // The proven prefix already owns these copies; rewriting them would
      // invalidate its content watch without adding any settled work.
      if (settlement.covers(asset.ual)) continue;
      if (
        assetIndex > 0
        && mayYieldAtSettledManifestBoundary
        && settlementSliceDeadline !== undefined
        && Date.now() >= settlementSliceDeadline
      ) {
        yieldedAtSettledManifestBoundary = true;
        break;
      }
      settlement.assertCurrent();
      const challengeCommitment = challengeCommitments.get(asset.ual);
      if (exactAssetSelection?.kind === 'challenge-pinned') {
        if (challengeCommitment === undefined) {
          throw new Error(`Challenge-pinned durable sync returned unselected asset ${asset.ual}`);
        }
        const authenticated = await authenticateChallengePinnedAsset!({
          asset,
          commitment: challengeCommitment,
          authenticationDeadline: graphScopedAuthenticationDeadline,
          signal,
        });
        authenticatedExactAssets.push(authenticated);
        logDebug(ctx, `Authenticated challenge-scoped exact asset ${asset.ual}`);
      } else {
        const outcome = await storeGraphScopedAsset!({
          asset,
          authenticationDeadline: graphScopedAuthenticationDeadline,
          signal,
        });
        if (outcome === 'applied') {
          if (exactAssetSelection !== undefined) committedExactAssetUals.push(asset.ual);
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
      }
      // Preserve a physically settled first prefix on cancellation. A reused
      // prefix still must pass its ownership/content proof before advancing.
      settlement.assertPrefixCurrent();
      const settledCheckpoint = checkpointSettledManifestGraph?.(asset.assertionGraph);
      if (settledCheckpoint) mayYieldAtSettledManifestBoundary = true;
      if (settledCheckpoint?.numericAdvance && !incrementalCheckpointAdvanceRecorded) {
        recordDurableSyncDiagnostics(accumulator, { checkpointAdvances: 1 });
        incrementalCheckpointAdvanceRecorded = true;
      }
    }
    if (yieldedAtSettledManifestBoundary) {
      logInfo(
        ctx,
        `Yielding durable recovery for "${pid}" at an authenticated manifest boundary after the settlement slice expired`,
      );
      // As after a whole page: the next round proves its DATA boundary with META fetched again from row zero.
      if (updateMetaCheckpoint && metaResult.completed) deleteCheckpoint(metaResult.checkpointKey);
      markDurableTerminalBoundary(accumulator, false);
      endPhase();
      return finishGraph(false);
    }
    if (partitioned.remainingData.length > 0) {
      settlement.assertCurrent();
      await storeInsert({
        quads: partitioned.remainingData,
        signal,
      });
      recordDurableSyncDiagnostics(accumulator, {
        insertedTriples: partitioned.remainingData.length,
        insertedDataTriples: partitioned.remainingData.length,
      });
    }
    await persistDurableRemainingMetadata(context, partitioned.remainingMeta, accumulator, settlement.assertCurrent);
    // An already-started atomic write is awaited, counted, and manifest-
    // checkpointed truthfully. An expired operation may not enter another
    // commit boundary or claim the whole page terminal.
    settlement.assertCurrent();
    await notifyVerifiedFullSnapshot();
    settlement.assertCurrent();
    recordPhaseOutcome(metaResult, { updateCheckpoint: updateMetaCheckpoint, countProgress: !metadataOnlyResponse });
    recordPhaseOutcome(effectiveDataResult, {
      updateCheckpoint: updateDataCheckpoint,
      checkpointAdvanceAlreadyRecorded: incrementalCheckpointAdvanceRecorded,
      manifestPlan: graphScopedManifest ?? undefined,
      terminal: reachedContextGraphTerminalBoundary,
    });
    markDurableTerminalBoundary(accumulator, reachedContextGraphTerminalBoundary);
    if (exactFetchDisposition !== undefined) {
      exactFetchDisposition = settledExactDisposition();
      exactResponderCapability = settledExactResponderCapability();
    }
    endPhase();
    if ((metaResult.timedOut || effectiveDataResult.timedOut) && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) {
      return finishGraph(false);
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
    if (isSyncTargetSupersededError(pidErr)) {
      // The node adopted this name-hash id's cleartext id mid-sync. Nothing
      // was written under the retired id, and it is no fault of the peer.
      logDebug(ctx, `Sync for context graph "${pid}" from ${remotePeerId} stopped: ${pidErr.message}`);
      return finishGraph(!signal?.aborted);
    }
    logWarn(ctx, `Sync for context graph "${pid}" from ${remotePeerId} failed: ${pidErr instanceof Error ? pidErr.message : String(pidErr)}`);
    if (
      proofOnlyChallengeFetch
      && (pidErr as { code?: unknown }).code === 'SYNC_EXACT_DESCRIPTOR_MISMATCH'
    ) {
      // A proof-only caller must distinguish an authenticated clean miss from
      // a responder descriptor that contradicts the pinned challenge. Do not
      // collapse this integrity failure into the ordinary best-effort sync
      // diagnostics returned by the multi-CG durable fanout.
      throw pidErr;
    }
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
      recordDurableSyncDiagnostics(accumulator, { failedPeers: 1 });
    }
    if (backoffWorthy && shouldStopAfterBackoffWorthyFailure(pid, 'backoff-worthy failure')) {
      return finishGraph(false);
    }
    if (signal?.aborted) return finishGraph(false);
  } finally {
    heldSettlement?.close();
    settlement.close();
  }
  return finishGraph();
}
