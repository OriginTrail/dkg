import { prepareDurableDataInput } from './durable-data-preparation.js';
import { persistDurableManifestBoundary } from './durable-manifest-checkpoint.js';
import { challengeAssetConsumer, materializedAssetConsumer, type DurableAssetConsumer, type DurableSettlementProgress } from './durable-asset-consumer.js';
import { prepareDurableMetaPhase, type PreparedDurableMeta } from './durable-meta-phase.js';
import { settleDurableVerifiedPage, type DurablePhaseSettlementOptions } from './durable-page-settlement.js';
import { DurableGraphSettlementGuard } from './durable-prefix-proof.js';
import type { HeldAssetContentSource } from './held-assets-contracts.js';
import type { DurableMetaContinuation } from './durable-meta-continuation.js';
import type { GraphOwnedRecoveryContext } from './graph-owned-recovery.js';
import { verifyDurablePage } from './durable-verified-page.js';
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
import { prepareDurableHoldingsPhase, type PreparedDurableDataStrategy } from './durable-holdings-phase.js';
import { type DurableDataStrategy } from './durable-data-holdings.js';
import {
  normalizeDurableSyncContext,
  type LegacyDurableSyncContext, type NormalizedDurableSyncContext,
} from './durable-sync-compat.js';
import {
  exactAssetFetchSessionPolicy,
  mergeExactAssetResponderCapability,
  mergeExactDurableFetchDisposition,
  type ExactAssetFetchSessionPolicy,
  type ExactAssetResponderCapability,
  type ExactDurableFetchDisposition,
} from './exact-durable-fetch.js';
import {
  exactAssetUalsForSelection,
  type ChallengePinnedExactAssetSelection,
  type ExactAssetCommitment,
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
  contentProofs?: HeldAssetContentSource;
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
  'exactAssetFetchPolicyFor' | 'storeGraphScopedAsset'
> {
  selectAssetExecution(contextGraphId: string, progress: DurableSettlementProgress): {
    readonly exactFetchPolicy?: ExactAssetFetchSessionPolicy;
    readonly settleAsset: DurableAssetConsumer;
  };
  proofOnlyChallengeFetch: boolean;
  proofRequesterScope?: `challenge-exact:${string}`;
}

interface InternalDetailedDurableSyncResult extends DetailedDurableSyncResult {
  readonly authenticatedExactAssets?: readonly ChallengePinnedGraphScopedAsset[];
}

interface DurableDataPolicy {
  readonly metaContinuation?: DurableMetaContinuation;
  selectDataPlan(meta: PreparedDurableMeta, settlement: DurableGraphSettlementGuard): Promise<PreparedDurableDataStrategy>;
}

/** Bind durable writes at the ordinary/owned boundary, including lazy legacy failure. */
function materializingAssetExecution(
  context: Pick<DurableSyncContext, 'ctx' | 'signal' | 'logDebug' | 'logWarn' | 'storeGraphScopedAsset'>,
  policyFor?: NormalizedDurableSyncContext['exactAssetFetchPolicyFor'],
): InternalDurableSyncContext['selectAssetExecution'] {
  const materialize = context.storeGraphScopedAsset ?? (async () => {
    throw Object.assign(new Error('Verified graph-scoped durable sync requires an exact materialization store path'),
      { code: 'VM_ATOMIC_REPLACE_UNSUPPORTED' });
  });
  return (contextGraphId, progress) => {
    const exactFetchPolicy = policyFor?.(contextGraphId);
    if (exactFetchPolicy && exactFetchPolicy.selection.kind !== 'ual-only') {
      throw new Error('Challenge-pinned exact retrieval requires the proof-only entry point');
    }
    return { exactFetchPolicy, settleAsset: materializedAssetConsumer({ context, materialize,
      accumulator: progress.accumulator,
      committedExactAssetUals: exactFetchPolicy ? progress.committedExactAssetUals : undefined }) };
  };
}

function materializingSyncContext(context: DurableSyncContext | LegacyDurableSyncContext): InternalDurableSyncContext {
  const normalized = normalizeDurableSyncContext(context);
  const { storeGraphScopedAsset: _storeGraphScopedAsset, exactAssetFetchPolicyFor, ...ports } = normalized;
  return { ...ports, proofOnlyChallengeFetch: false,
    selectAssetExecution: materializingAssetExecution(normalized, exactAssetFetchPolicyFor) };
}

interface DurableGraphExecutionResult extends Omit<InternalDetailedDurableSyncResult, 'result'> {
  /** Unfinalized physical counters and terminal boundaries fold without losing evidence. */
  readonly progress: DurableSyncAccumulator;
  readonly dataStrategy?: DurableDataStrategy<unknown, {
    readonly graphScoped: boolean; readonly continuation: 'full-graph' | 'reconsider-holdings' }>;
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
  return (await runDurableSyncWithBudget(materializingSyncContext(context))).result;
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
  return physicalDurableSyncResult(await runDurableSyncWithBudget(materializingSyncContext(context)));
}

/** One graph and its owner capabilities enter together; ordinary/exact inputs carry neither. */
export async function runGraphOwnedDurableSyncDetailed(
  context: GraphOwnedDurableSyncContext,
): Promise<DurableRecoveryRoundOutcome> {
  const { contextGraphId, recovery, storeGraphScopedAsset: _storeGraphScopedAsset, ...sharedContext } = context;
  const graph = await executeDurableGraph(
    { ...sharedContext, contextGraphId, remainingContextGraphs: 1, proofOnlyChallengeFetch: false,
      selectAssetExecution: materializingAssetExecution(context) }, {
      metaContinuation: recovery.meta,
      selectDataPlan: async (preparedMeta, settlement) => {
        const prepared = await prepareDurableHoldingsPhase({ context: sharedContext, contextGraphId,
          manifest: preparedMeta.manifestPlan, recovery, settlement });
        return prepared.kind === 'full' ? { ...prepared, boundary: recovery.boundary } : prepared;
      },
    });
  const strategy = graph.dataStrategy;
  const decision: DurableRecoveryRoundDecision = !strategy ? { strategy: 'not-started' }
    : strategy.kind === 'full' ? (strategy.graphScoped
      ? { strategy: 'full', continuation: strategy.continuation } : { strategy: 'legacy' })
    : strategy.kind === 'held' ? { strategy: 'held' }
    : { strategy: 'exact-missing', batches: strategy.batches };
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
    selectAssetExecution: (contextGraphId, progress) => {
      const selection = challengeSelectionFor(contextGraphId);
      return { exactFetchPolicy: exactAssetFetchSessionPolicy(selection),
        settleAsset: challengeAssetConsumer({ context: sharedContext, authenticate: authenticateChallengePinnedAsset,
          commitments: new Map(selection.commitments.map(commitment => [commitment.assetUal, commitment])),
          evidence: progress.authenticatedExactAssets }) };
    },
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
    selectAssetExecution,
    stopOnBackoffWorthyFailure = false,
    proofOnlyChallengeFetch,
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
    options: DurablePhaseSettlementOptions,
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
      persistDurableManifestBoundary({ checkpointKey: result.checkpointKey, manifest: options.manifestPlan,
        offset: result.nextOffset, terminal: true, session: { kind: 'fetched', rawOffset: result.rawNextOffset },
        deleteCheckpoint, setCheckpoint });
    } else if (result.completed) deleteCheckpoint(result.checkpointKey);
    else if (result.nextOffset > 0 || result.resumedFromOffset > 0) {
      if (options.manifestPlan) {
        persistDurableManifestBoundary({ checkpointKey: result.checkpointKey, manifest: options.manifestPlan,
          offset: result.nextOffset, terminal: false, session: { kind: 'fetched', rawOffset: result.rawNextOffset },
          deleteCheckpoint, setCheckpoint });
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
  }, context.contentProofs);
  let rejectedResumeOffset: number | undefined;
  let graphDataStrategy: DurableGraphExecutionResult['dataStrategy'];
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
    progress: accumulator, dataStrategy: graphDataStrategy, rejectedResumeOffset, continueFanout,
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
    const { exactFetchPolicy, settleAsset } = selectAssetExecution(pid,
      { accumulator, committedExactAssetUals, authenticatedExactAssets });
    const exactAssetSelection = exactFetchPolicy?.selection;
    const isProofOnlyChallengeFetch = exactFetchPolicy?.kind === 'ephemeral-challenge';
    const exactAssetUals = exactAssetSelection === undefined
      ? undefined
      : exactAssetUalsForSelection(exactAssetSelection);
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
    const dataPlan = await dataPolicy?.selectDataPlan(preparedMeta, settlement) ?? { kind: 'full' as const, held: 0, continuation: 'full-graph' as const };
    const graphScopedManifest = preparedMeta.manifestPlan;
    if (dataPlan.kind === 'full') graphDataStrategy = { ...dataPlan, graphScoped: graphScopedManifest !== null };
    const verificationInput = await prepareDurableDataInput(context, {
      contextGraphId: pid, dataGraph, metaResult, preparedMeta, dataPlan, sinceBatchId,
      isSystemContextGraph, exactAssetSelection, exactAssetUals, settlementSliceDeadline,
      requireCompleteSnapshot: onVerifiedFullSnapshot !== undefined,
      fetchData: createPhaseFetcher(undefined, dataPlan.kind === 'full' ? dataPlan.boundary : undefined),
      settlement, events: { peerResponded: () => { peerRespondedForContextGraph = true; },
        rejectResume: offset => { rejectedResumeOffset = offset; } },
    });
    endPhase();
    const fetchDurationMs = Date.now() - fetchStartedAt;

    startPhase('verify');
    const verifyStartedAt = Date.now();
    let processed: Awaited<ReturnType<DurableSyncContext['processDurableBatchInWorker']>>;
    try {
      processed = await verifyDurablePage(context, verificationInput, isSystemContextGraph);
    } catch (error) {
      if (verificationInput.kind === 'fetched' && graphScopedManifest && !signal?.aborted)
        deleteCheckpoint(verificationInput.rawDataResult.checkpointKey);
      throw error;
    }
    settlement.assertCurrent();
    endPhase();
    const verifyDurationMs = Date.now() - verifyStartedAt;

    logInfo(ctx, `  meta: ${processed.totalFetchedMetaQuads} triples fetched`);
    logInfo(ctx, `  data: ${processed.totalFetchedDataQuads} triples fetched`);
    recordDurableSyncDiagnostics(accumulator, {
      bytesReceived: metaResult.bytesReceived + (verificationInput.kind === 'fetched' ? verificationInput.rawDataResult.bytesReceived : 0),
      fetchedMetaTriples: processed.totalFetchedMetaQuads,
      fetchedDataTriples: processed.totalFetchedDataQuads,
      emptyResponses: processed.emptyResponses,
      metaOnlyResponses: processed.metaOnlyResponses,
      verifiedPrivateOnlyResponses: processed.verifiedPrivateOnlyResponses,
      dataRejectedMissingMeta: processed.dataRejectedMissingMeta,
    });

    // Physical verification counters are shared; only the DATA decision differs.
    const batchVerifiedCleanly = processed.rejectedKcs === 0;
    if (!batchVerifiedCleanly) {
      logWarn(ctx, `Rejected ${processed.rejectedKcs} KCs that failed durable integrity verification from ${remotePeerId}`);
      recordDurableSyncDiagnostics(accumulator, { rejectedKcs: processed.rejectedKcs });
    }
    const storeStartedAt = Date.now();
    const outcome = await settleDurableVerifiedPage(verificationInput, processed,
      { ...context, settleAsset, recordPhaseOutcome, onStoreStart: () => startPhase('store') },
      accumulator,
      { contextGraphId: pid, metaResult, graphScopedManifest, exactFetchPolicy, sinceBatchId, skipAgentsMeta,
        settlement, contextGraphBudget, deadline, settlementSliceDeadline });
    endPhase();
    if (outcome.kind === 'yielded') return finishGraph(false);
    if (verificationInput.kind === 'held') graphDataStrategy = verificationInput.holdings;
    if (outcome.exactDisposition !== undefined) {
      exactFetchDisposition = outcome.exactDisposition;
      exactResponderCapability = outcome.exactCapability;
    }
    if (outcome.timedOut && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) return finishGraph(false);
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
    settlement.close();
  }
  return finishGraph();
}
