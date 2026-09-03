import { contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri, validateSubGraphName } from '@origintrail-official/dkg-core';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SwmSnapshotCoverage } from '../../dkg-agent-types.js';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { SyncPhase } from '../auth/request-build.js';
import { didSyncPeerRespond, isSyncBackoffWorthyError, isSyncPermanentRejection, isSyncTransportFailure } from '../error-tags.js';
import { isSharedMemoryBucketDescendantDataGraph } from '../shared-memory-graphs.js';
import {
  type SyncPageFetchOptions,
  type SyncPageResult,
} from './page-fetch.js';
import {
  canonicalizeGraphScopedSwmHeadRows,
  materializeGraphScopedSwmRecoveryAsset,
  parseGraphScopedSwmRecoveryDescriptors,
  type GraphScopedSwmRecoveryDescriptor,
} from '../graph-scoped-swm-recovery.js';
import type { SharedMemorySnapshotMaterializer } from './swm-snapshot-materializer.js';
import {
  createRecoveryExecutionBoundary,
  type RecoveryExecutionBoundary,
  type RecoveryExecutionGuard,
} from './recovery-execution-guard.js';

const DKG = 'http://dkg.io/ontology/';

/**
 * Cap on identifiers reported for an unresolved manifest. A public peer chooses
 * how many snapshots it advertises, so an unbounded list would let it size a
 * structure on this node; the exact figure travels as `missingCount`.
 */
const PUBLIC_SNAPSHOT_MISSING_SAMPLE_LIMIT = 10;
/**
 * Stored length of ONE sampled ref.
 *
 * A ref is a `dkg:publicSnapshotRef` literal chosen by a remote peer and only
 * `.trim()`ed on the way in, so its length is peer-controlled. Capping the
 * SAMPLE SIZE bounds how many we keep, not how big each one is: ten refs of a
 * megabyte each still cross the worker RPC and sit in the diagnostics record.
 *
 * Bounded at the source as well as at the renderer. The renderer's bound is what
 * protects the operator-facing sentence; this one keeps an oversized literal out
 * of memory and off the wire, which the renderer cannot do from the far side.
 */
const PUBLIC_SNAPSHOT_REF_SAMPLE_MAX_CHARS = 128;

/** Bound one sampled ref. Truncation is marked so it cannot read as complete. */
function boundSampledRef(ref: string): string {
  return ref.length > PUBLIC_SNAPSHOT_REF_SAMPLE_MAX_CHARS
    ? `${ref.slice(0, PUBLIC_SNAPSHOT_REF_SAMPLE_MAX_CHARS)}\u2026`
    : ref;
}

function metadataQuadKey(quad: Quad): string {
  // JSON's tuple boundaries are unambiguous even when a literal contains the
  // whitespace/delimiter text that made the former flattened key lossy.
  return JSON.stringify([quad.graph, quad.subject, quad.predicate, quad.object]);
}

/**
 * Own the one-round metadata commit policy for graph-scoped snapshots.
 * Per-KA writes, finalized-twin suppression, the final bulk append and counter
 * compensation all consult this object so a caller cannot update only one of
 * those ledgers and accidentally resurrect retired SWM metadata.
 */
type FinalizedTwinMetadataDisposition = 'preserve' | 'suppress-metadata';
type FinalizedTwinReconciler = (
  contextGraphId: string,
  descriptor: GraphScopedSwmRecoveryDescriptor,
) => Promise<FinalizedTwinMetadataDisposition>;

class GraphScopedSnapshotCommitCoordinator {
  readonly #verifiedKeys: ReadonlySet<string>;
  readonly #writtenKeys = new Set<string>();
  readonly #suppressedKeys = new Set<string>();
  readonly #reconcileFinalizedTwin: FinalizedTwinReconciler | undefined;

  constructor(
    verifiedMeta: readonly Quad[],
    reconcileFinalizedTwin: FinalizedTwinReconciler | undefined,
  ) {
    this.#verifiedKeys = new Set(verifiedMeta.map(metadataQuadKey));
    this.#reconcileFinalizedTwin = reconcileFinalizedTwin;
  }

  unwrittenVerifiedRows(descriptor: GraphScopedSwmRecoveryDescriptor): Quad[] {
    return descriptor.metadataQuads.filter((quad) => {
      const key = metadataQuadKey(quad);
      return this.#verifiedKeys.has(key)
        && !this.#writtenKeys.has(key)
        && !this.#suppressedKeys.has(key);
    });
  }

  recordWritten(rows: readonly Quad[]): void {
    for (const quad of rows) this.#writtenKeys.add(metadataQuadKey(quad));
  }

  /**
   * GH#2273 — ROW-level suppression for identity-preserving decisions. Only
   * the specific rows named here are withheld from this round's remaining
   * writes (`insertVerifiedDescriptorMeta` and the bulk append both honour the
   * same ledger). Deliberately NOT descriptor-level: after a head repair the
   * head subject holds only what the repair re-inserted, and suppressing a
   * descriptor's WHOLE metadata there would withhold the four required head
   * rows too, leaving a head the resolver permanently fails closed on. The
   * key identity with `verifiedMetaForInsert` holds because canonicalization
   * only REMOVES rows — a canonicalizer that rewrites rows would silently
   * break this ledger.
   */
  suppressRows(rows: readonly Quad[]): void {
    for (const quad of rows) {
      const key = metadataQuadKey(quad);
      if (this.#verifiedKeys.has(key)) this.#suppressedKeys.add(key);
    }
  }

  suppressedRows(rows: readonly Quad[]): Quad[] {
    return rows.filter((quad) => this.#suppressedKeys.has(metadataQuadKey(quad)));
  }

  #suppress(descriptor: GraphScopedSwmRecoveryDescriptor): void {
    for (const quad of descriptor.metadataQuads) {
      const key = metadataQuadKey(quad);
      if (this.#verifiedKeys.has(key)) this.#suppressedKeys.add(key);
    }
  }

  /**
   * Own post-materialization reconciliation and its metadata disposition as
   * one commit decision. The caller cannot retire a twin without updating the
   * same ledger that filters the round's final bulk append.
   */
  async reconcileAfterMaterialization(params: {
    contextGraphId: string;
    descriptor: GraphScopedSwmRecoveryDescriptor;
    onDeferred: (cause: unknown) => void;
  }): Promise<void> {
    if (!this.#reconcileFinalizedTwin) return;
    try {
      const disposition = await this.#reconcileFinalizedTwin(
        params.contextGraphId,
        params.descriptor,
      );
      if (disposition === 'suppress-metadata') this.#suppress(params.descriptor);
    } catch (cause) {
      // Snapshot materialization is already durable. Preserve the twin and
      // retry on a later pass instead of reclassifying a successful sync.
      params.onDeferred(cause);
    }
  }

  bulkRows(rows: readonly Quad[]): Quad[] {
    return this.#suppressedKeys.size === 0
      ? [...rows]
      : rows.filter((quad) => !this.#suppressedKeys.has(metadataQuadKey(quad)));
  }

  alreadyCountedRetainedRows(): number {
    let count = 0;
    for (const key of this.#writtenKeys) {
      if (!this.#suppressedKeys.has(key)) count += 1;
    }
    return count;
  }
}

/**
 * Snapshot-walk progress carried OUT of a throw.
 *
 * A snapshot-phase transport failure throws, and the throw unwinds past the
 * point where the caller reads the walk's return value — so a round that
 * materialized 120 Knowledge Assets and then failed on the 121st reported
 * ZERO. That is not merely a diagnostics gap: the continuation loop's progress
 * signal is `swmCoverage.snapshotsResolved`, so the high-water mark never
 * moved, and the loop declared `coverage-stalled` and abandoned a peer that
 * was converging — the exact behaviour #2050 exists to remove.
 *
 * The counts are the walk's own, so `snapshotsResolved + missingCount ===
 * snapshotsTotal` holds on this path exactly as it does on the returned one.
 */
export interface PublicSnapshotWalkProgress {
  readySnapshots: number;
  totalSnapshots: number;
  missingCount: number;
  missingSample: string[];
}

/** Non-enumerable so the payload never widens a structured-clone or log dump. */
const PUBLIC_SNAPSHOT_PROGRESS_KEY = '__swmPublicSnapshotProgress';

function attachPublicSnapshotWalkProgress(err: unknown, progress: PublicSnapshotWalkProgress): void {
  if (typeof err !== 'object' || err === null) return;
  try {
    Object.defineProperty(err, PUBLIC_SNAPSHOT_PROGRESS_KEY, {
      value: progress,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // A frozen or exotic error is not worth failing the round over; the
    // caller simply records no coverage for it, exactly as before.
  }
}

/** Read progress attached by {@link syncPublicSnapshotsForMeta} before it rethrew. */
export function readPublicSnapshotWalkProgress(err: unknown): PublicSnapshotWalkProgress | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const progress = (err as Record<string, unknown>)[PUBLIC_SNAPSHOT_PROGRESS_KEY];
  if (typeof progress !== 'object' || progress === null) return undefined;
  const candidate = progress as Partial<PublicSnapshotWalkProgress>;
  // Validated rather than trusted: this crosses an `unknown` boundary, and a
  // fabricated denominator would corrupt the coverage record the pass loop and
  // the terminal message both read.
  if (
    !Number.isSafeInteger(candidate.readySnapshots)
    || !Number.isSafeInteger(candidate.totalSnapshots)
    || !Number.isSafeInteger(candidate.missingCount)
    || !Array.isArray(candidate.missingSample)
  ) {
    return undefined;
  }
  return candidate as PublicSnapshotWalkProgress;
}

export interface SharedMemorySyncSummary {
  insertedTriples: number;
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  bytesReceived: number;
  resumedPhases: number;
  timedOutPhases: number;
  completedPhases: number;
  checkpointAdvances: number;
  deniedPhases: number;
  emptyResponses: number;
  droppedDataTriples: number;
  failedPeers: number;
  failedPhases: number;
  backoffWorthyFailures: number;
  /** Context Graph admissions deferred by local scheduler pressure. */
  deferredBackpressure: number;
  /**
   * Snapshot phases that stopped on the local clock with refs still unfetched.
   * A voluntary yield, NOT a peer fault — see `SwmSnapshotCoverage` and the
   * note on `SharedMemorySyncDiagnostics.snapshotPlaneIncomplete`.
   */
  snapshotPlaneIncomplete: number;
  /** Selected-only metadata deadline yields whose exact prefixes were retained. */
  metadataContinuationYields: number;
  /** Coherent snapshot coverage for this round; reduced only by {@link selectSwmSnapshotCoverage}. */
  swmCoverage?: SwmSnapshotCoverage;
  /**
   * The REPLAY half of `bytesReceived` — metadata AND aggregate data, the two
   * phases a repeated pass re-fetches in full. `bytesReceived` merges these
   * with snapshot bytes into one scalar, which leaves the accepted cost of
   * repeating the peer walk unmeasurable in bytes.
   */
  replayPhaseBytesReceived: number;
  /** The USEFUL half of `bytesReceived` — immutable snapshot content. */
  snapshotPhaseBytesReceived: number;
}

export interface SharedMemoryMetadataFetchRequest {
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly graphUri: string;
  readonly deadline: number;
}

export interface SharedMemoryMetadataFetchOutcome {
  readonly result: SyncPageResult;
  /** True when this exact invocation retained a resumable metadata prefix. */
  readonly continuationYielded: boolean;
}

/**
 * Selected-provider snapshot progress bound to one exact, ordered manifest.
 *
 * The owner keeps only refs whose content was already materialized locally.
 * A changed manifest replaces the continuation, and a process restart drops
 * it, so a skipped ref can never outlive the evidence that justified the skip.
 */
export interface SharedMemorySnapshotWalkContinuation {
  /** Take an immutable copy of the exact ordered manifest owning the resolved refs below. */
  orderedManifestSnapshot(): readonly PublicSnapshotMetadata[];
  /** Query live owner state without exposing its mutable backing collection. */
  isResolved(ref: string): boolean;
  resolvedCount(): number;
  /** Take an immutable point-in-time view for reporting or batch setup. */
  resolvedRefsSnapshot(): readonly string[];
  /** Exact verified metadata rows withheld when this ref was resolved. */
  suppressedMetadataRows(ref: string): readonly Quad[];
  markResolved(ref: string, suppressedMetadataRows?: readonly Quad[]): void;
}

type PublicSnapshotWalkSource =
  | {
    /** Ordinary lanes derive their walk from the verified metadata page. */
    readonly metaQuads: readonly Quad[];
    readonly recoveryOrder?: 'manifest' | 'recent-balanced';
    readonly snapshotWalk?: never;
  }
  | {
    /**
     * Selected lanes pass one manifest-bound continuation value. Keeping the
     * order and its resolved-ref evidence in the same object makes it
     * impossible to combine metadata from one manifest with skip evidence
     * from another.
     */
    readonly snapshotWalk: SharedMemorySnapshotWalkContinuation;
    readonly metaQuads?: never;
    readonly recoveryOrder?: never;
  };

/**
 * Strategy boundary for metadata retrieval.
 *
 * The default requester performs one ordinary page fetch. Selected RFC-64 SWM
 * injects a strategy that owns its exceptional retained-prefix/session state;
 * the canonical SWM pipeline only consumes the resulting page and yield bit.
 */
export interface SharedMemoryMetadataFetcher {
  fetch(request: SharedMemoryMetadataFetchRequest): Promise<SharedMemoryMetadataFetchOutcome>;
  release(contextGraphId: string): void;
  snapshotWalk?(
    contextGraphId: string,
    orderedManifest: readonly PublicSnapshotMetadata[],
  ): SharedMemorySnapshotWalkContinuation;
}

/**
 * Pick the coverage record a caller should report, WHOLE.
 *
 * This is the single reduction for {@link SwmSnapshotCoverage}, used both when
 * one peer's rounds are merged across Context Graphs (`mergeSharedMemorySyncResults`)
 * and when a catch-up walk merges across peers. It never builds a new pair of
 * counts — the returned record is byte-for-byte one of its inputs, so the
 * counts, the peer they are attributed to, and the missing sample always
 * describe the same round.
 *
 * Order: authority evidence, then a complete manifest (an incomplete one's
 * denominator is only a lower bound), then the LARGEST manifest, then the most
 * resolved within that manifest, then a lexicographic peer-id tiebreak.
 *
 * **Largest manifest, not best fraction.** Ranking by `resolved/total` picks
 * `200/200` over `178/250` and so reports "0 outstanding" on a job that is 72
 * Knowledge Assets short. That is worse than the synthetic `200/250` this
 * record shape exists to prevent, because it is internally self-consistent and
 * nothing downstream can detect it. The largest complete manifest is the best
 * known lower bound on what the graph actually holds, so the shortfall is
 * reported against that.
 *
 * Residual, stated: a peer that sorts first on authority still wins with a
 * stale or smaller manifest, and can report converged while a
 * non-authoritative peer knows of more. That one is accepted — the curator is
 * definitionally authoritative about its own Context Graph's inventory.
 */
export function selectSwmSnapshotCoverage(
  a: SwmSnapshotCoverage | undefined,
  b: SwmSnapshotCoverage | undefined,
): SwmSnapshotCoverage | undefined {
  if (!a) return b;
  if (!b) return a;
  if ((a.fromAuthority ?? false) !== (b.fromAuthority ?? false)) {
    return a.fromAuthority ? a : b;
  }
  if (a.manifestComplete !== b.manifestComplete) return a.manifestComplete ? a : b;
  if (a.snapshotsTotal !== b.snapshotsTotal) return a.snapshotsTotal > b.snapshotsTotal ? a : b;
  if (a.snapshotsResolved !== b.snapshotsResolved) {
    return a.snapshotsResolved > b.snapshotsResolved ? a : b;
  }
  // Genuinely indistinguishable records. This settles a cross-PEER tie only:
  // in the cross-Context-Graph merge both records come from the SAME peer, so
  // the suffixes are equal and the choice falls through to `a` — that is,
  // to Context Graph iteration order. Deterministic either way, but not
  // because of this comparison.
  return a.peerIdSuffix <= b.peerIdSuffix ? a : b;
}

export interface SharedMemorySyncContext {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphIds: string[];
  createContextGraphSyncDeadline: (remainingContextGraphs: number) => number;
  fetchSyncPages: (
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
    options?: SyncPageFetchOptions,
  ) => Promise<SyncPageResult>;
  processSharedMemoryBatch: (
    wsDataQuads: Quad[],
    wsMetaQuads: Quad[],
    contextGraphId: string,
    registeredSubGraphNames?: readonly string[],
    excludedSubGraphNames?: readonly string[],
  ) => Promise<{
    verifiedData: Quad[];
    verifiedMeta: Quad[];
    totalFetchedDataQuads: number;
    totalFetchedMetaQuads: number;
    droppedDataTriples: number;
    emptyResponses: number;
    entityCreators: Array<{ dataGraph: string; entity: string; creator: string }>;
  }>;
  ensureContextGraph: (contextGraphId: string) => Promise<void>;
  storeInsert: (quads: Quad[]) => Promise<void>;
  /**
   * Everything needed to MATERIALIZE verified public SWM snapshots into the
   * triple store, as ONE cohesive dependency — the contract (and the
   * production implementation) live in `swm-snapshot-materializer.ts`.
   *
   * Why it exists at all: contentScopeVersion-2 KAs carry no dkg:rootEntity,
   * so the aggregate data phase legitimately returns 0 data quads for them —
   * their content travels as immutable snapshots. The catch-up lane fetched
   * and VERIFIED those snapshots and then never wrote them, so a node that
   * missed the live gossip stayed empty forever ("0 data + N meta triples").
   * Absent entirely => materialization is skipped (never half-applied).
   */
  snapshotMaterializer?: SharedMemorySnapshotMaterializer;
  /**
   * Optional VM-aware effect used by the round-owned snapshot commit
   * coordinator. It is deliberately separate from the generic materializer:
   * only the coordinator may translate its result into metadata suppression.
   */
  reconcileFinalizedTwin?: FinalizedTwinReconciler;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  getRegisteredSubGraphNames?: (contextGraphId: string) => Promise<readonly string[]>;
  getExcludedSubGraphNames?: (contextGraphId: string) => Promise<readonly string[]>;
  stopOnBackoffWorthyFailure?: boolean;
  /** Optional lane-owned policy for deciding whether snapshot evidence is sufficient. */
  snapshotEvidencePolicy?: {
    accepts: (evidence: {
      verifiedMetadataTriples: number;
      snapshotReferences: number;
      graphBackedOperations: number;
    }) => boolean;
  };
  /** Optional metadata retrieval strategy; ordinary callers use page fetch. */
  metadataFetcher?: SharedMemoryMetadataFetcher;
  /**
   * Selected cold-join recovery may interleave recent snapshots with the
   * oldest outstanding history. Ordinary sync preserves manifest order.
   */
  snapshotRecoveryOrder?: 'manifest' | 'recent-balanced';
  /** Current-authority capability for selected recovery; ordinary sync omits it. */
  recoveryGuard?: RecoveryExecutionGuard;
  deleteCheckpoint: (key: string) => void;
  setCheckpoint: (key: string, offset: number) => void;
  ensureOwnedMap: (ownershipKey: string) => Map<string, string>;
  logInfo: (ctx: OperationContext, message: string) => void;
  logWarn: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}


/**
 * True when the locally stored head version outranks the descriptor we are
 * about to materialize. BigInt-compared when both parse; anything unparseable
 * is treated as OUTRANKING — failing safe means never destroying local state
 * whose ordering we cannot establish.
 */
function storedVersionOutranksDescriptor(stored: string, descriptorVersion: string): boolean {
  try {
    return BigInt(stored) > BigInt(descriptorVersion);
  } catch {
    return true;
  }
}

export async function runSharedMemorySync(context: SharedMemorySyncContext): Promise<SharedMemorySyncSummary> {
  const {
    ctx,
    remotePeerId,
    contextGraphIds,
    createContextGraphSyncDeadline,
    fetchSyncPages,
    processSharedMemoryBatch,
    ensureContextGraph,
    storeInsert,
    snapshotMaterializer,
    reconcileFinalizedTwin,
    publicSnapshotStore,
    getRegisteredSubGraphNames,
    getExcludedSubGraphNames,
    stopOnBackoffWorthyFailure = false,
    snapshotEvidencePolicy,
    metadataFetcher,
    snapshotRecoveryOrder = 'manifest',
    recoveryGuard,
    deleteCheckpoint,
    setCheckpoint,
    ensureOwnedMap,
    logInfo,
    logWarn,
    logDebug,
  } = context;
  const recoveryBoundary = createRecoveryExecutionBoundary(recoveryGuard);
  recoveryBoundary.assertCurrent();
  const fetchRecoveryPages = (
    contextGraphId: string,
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
  ): Promise<SyncPageResult> => {
    const commonArgs = [
      ctx,
      remotePeerId,
      contextGraphId,
      true,
      phase,
      graphUri,
      deadline,
    ] as const;
    return recoveryBoundary.signal === undefined
      ? fetchSyncPages(...commonArgs)
      : fetchSyncPages(...commonArgs, { signal: recoveryBoundary.signal });
  };

  const summary: SharedMemorySyncSummary = {
    insertedTriples: 0,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 0,
    insertedMetaTriples: 0,
    insertedDataTriples: 0,
    bytesReceived: 0,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 0,
    checkpointAdvances: 0,
    deniedPhases: 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 0,
    failedPhases: 0,
    backoffWorthyFailures: 0,
    deferredBackpressure: 0,
    snapshotPlaneIncomplete: 0,
    metadataContinuationYields: 0,
    replayPhaseBytesReceived: 0,
    snapshotPhaseBytesReceived: 0,
  };

  const recordPhaseOutcome = (
    result: SyncPageResult,
    options: { updateCheckpoint?: boolean; emptyPhase?: boolean } = {},
  ) => {
    recoveryBoundary.assertCurrent();
    const updateCheckpoint = options.updateCheckpoint ?? true;
    summary.resumedPhases += result.resumedFromOffset > 0 ? 1 : 0;
    summary.timedOutPhases += result.timedOut ? 1 : 0;
    if (!updateCheckpoint) return;
    if (
      result.completed &&
      !result.timedOut &&
      (
        options.emptyPhase === true ||
        result.resumedFromOffset > 0 ||
        result.nextOffset > result.resumedFromOffset
      )
    ) {
      summary.completedPhases += 1;
    }
    if (result.nextOffset > result.resumedFromOffset) {
      summary.checkpointAdvances += 1;
    }
    if (result.completed) recoveryBoundary.commit(() => deleteCheckpoint(result.checkpointKey));
    else if (result.nextOffset > 0 || result.resumedFromOffset > 0) {
      recoveryBoundary.commit(() => setCheckpoint(result.checkpointKey, result.nextOffset));
    }
  };

  let peerFailed = false;
  const shouldStopAfterBackoffWorthyFailure = (contextGraphId: string, reason: string): boolean => {
    if (!stopOnBackoffWorthyFailure) return false;
    logInfo(ctx, `Stopping SWM sync fanout for ${remotePeerId} after "${contextGraphId}" (${reason})`);
    return true;
  };
  /**
   * The ONE place a coverage record is built. Both the success path and the
   * throw path go through it, so a record can never be reassembled in a catch
   * block from scalars that did not travel together — the failure mode the
   * whole-record contract exists to prevent.
   *
   * `walk` supplies every count as one coherent group; only the round-level
   * attribution is added here.
   */
  const recordSnapshotCoverage = (
    walk: PublicSnapshotWalkProgress,
    manifestComplete: boolean,
    descriptorsAuthoritative: boolean,
    materializationFailures: number,
    materializedRefCount: number,
    unwrittenRefSample: readonly string[],
    contextGraphId: string,
  ): void => {
    // A zero snapshot-ref denominator is ambiguous on a non-empty metadata
    // response: it can mean a legacy graph-backed asset whose transport graph
    // is not part of this snapshot walk. Do not turn that into terminal 0/0
    // evidence. The genuinely empty two-phase response has its own explicit
    // builder below.
    if (walk.totalSnapshots <= 0) return;
    // RESOLVED MEANS LOCALLY MATERIALIZED, not fetched.
    //
    // `walk.readySnapshots` counts refs retrieved and digest-valid in the blob
    // cache, and the walk increments it unconditionally after the
    // materialization hook — the hook swallows its own failures. Reporting that
    // as resolved made an all-cached round whose writes ALL failed look like
    // `250/250`: the capability gate computed `250 < 250` false and dropped the
    // peer, the high-water mark advanced to maximal, and the continuation
    // stopped silently having written nothing — inside the fix meant to prevent
    // exactly that.
    //
    // Deriving `missingCount` from the same figure keeps
    // `resolved + missing === total` true by construction, and makes it cover
    // both never-fetched and fetched-but-unwritten refs without either being
    // tracked twice.
    const snapshotsResolved = Math.min(materializedRefCount, walk.totalSnapshots);
    summary.swmCoverage = selectSwmSnapshotCoverage(summary.swmCoverage, {
      contextGraphId,
      peerIdSuffix: remotePeerId.slice(-8),
      snapshotsResolved,
      snapshotsTotal: walk.totalSnapshots,
      manifestComplete,
      descriptorsAuthoritative,
      missingCount: walk.totalSnapshots - snapshotsResolved,
      // Never-retrieved refs first, then retrieved-but-unwritten ones. Deduped
      // across BOTH sources so the sample can never exceed `missingCount`, which
      // is what the renderer subtracts it from to size its "(+N more)" suffix.
      missingSample: [...new Set([...walk.missingSample, ...unwrittenRefSample])]
        .slice(0, PUBLIC_SNAPSHOT_MISSING_SAMPLE_LIMIT),
      materializationFailures,
    });
  };

  for (const [index, pid] of contextGraphIds.entries()) {
    recoveryBoundary.assertCurrent();
    let peerRespondedForContextGraph = false;
    // Hoisted out of the `try` so the `catch` can still say whether this peer's
    // manifest was whole. Without it a throwing round could only report a
    // denominator with no way to mark it a lower bound.
    let manifestComplete = false;
    // Likewise: materialization failures recorded before the throw are real and
    // must reach the coverage record, not be lost with the stack.
    let materializedFailuresForCg = 0;
    let materializedRefsForCg = 0;
    let descriptorsAuthoritativeForCg = true;
    const unresolvedRefSampleForCg: string[] = [];
    try {
      const wsGraph = contextGraphWorkspaceGraphUri(pid);
      const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(pid);
      const deadline = createContextGraphSyncDeadline(contextGraphIds.length - index);

      logInfo(ctx, `Syncing shared memory for context graph "${pid}" from ${remotePeerId}`);

      const fetchStartedAt = Date.now();
      const metadataOutcome = metadataFetcher
        ? await recoveryBoundary.read(() => metadataFetcher.fetch({
          ctx,
          remotePeerId,
          contextGraphId: pid,
          graphUri: wsMetaGraph,
          deadline,
        }))
        : {
          result: await recoveryBoundary.read(() => fetchRecoveryPages(
            pid,
            'meta',
            wsMetaGraph,
            deadline,
          )),
          continuationYielded: false,
        };
      const wsMetaResult = metadataOutcome.result;
      manifestComplete = wsMetaResult.completed;
      peerRespondedForContextGraph = true;
      if (metadataOutcome.continuationYielded) {
        // Retain first, checkpoint second. A non-zero cursor is safe only while
        // the exact prefix it skips remains available to the same invocation.
        summary.bytesReceived += wsMetaResult.bytesReceived;
        summary.replayPhaseBytesReceived += wsMetaResult.bytesReceived;
        summary.metadataContinuationYields += 1;
        recordPhaseOutcome(wsMetaResult);
        break;
      }
      if (wsMetaResult.timedOut && shouldStopAfterBackoffWorthyFailure(pid, 'meta timeout')) {
        recordPhaseOutcome(wsMetaResult, { updateCheckpoint: false });
        break;
      }
      const wsDataResult = await recoveryBoundary.read(() => fetchRecoveryPages(
        pid,
        'data',
        wsGraph,
        deadline,
      ));
      peerRespondedForContextGraph = true;
      const fetchDurationMs = Date.now() - fetchStartedAt;

      const verifyStartedAt = Date.now();
      const registeredSubGraphNames = getRegisteredSubGraphNames
        ? await recoveryBoundary.read(() => getRegisteredSubGraphNames(pid))
        : undefined;
      const excludedSubGraphNames = getExcludedSubGraphNames
        ? await recoveryBoundary.read(() => getExcludedSubGraphNames(pid))
        : undefined;
      const processed = await recoveryBoundary.read(() => processSharedMemoryBatch(
        wsDataResult.quads,
        wsMetaResult.quads,
        pid,
        registeredSubGraphNames,
        excludedSubGraphNames,
      ));
      const verifyDurationMs = Date.now() - verifyStartedAt;
      logInfo(ctx, `  shared memory: ${processed.totalFetchedDataQuads} data + ${processed.totalFetchedMetaQuads} meta triples fetched`);
      summary.bytesReceived += wsMetaResult.bytesReceived + wsDataResult.bytesReceived;
      summary.replayPhaseBytesReceived += wsMetaResult.bytesReceived + wsDataResult.bytesReceived;
      summary.fetchedMetaTriples += processed.totalFetchedMetaQuads;
      summary.fetchedDataTriples += processed.totalFetchedDataQuads;
      summary.emptyResponses += processed.emptyResponses;

      if (processed.emptyResponses > 0) {
        // Only a clean terminal response from BOTH empty phases proves that
        // this selected graph has no snapshot-backed or graph-backed SWM
        // assets. A non-empty metadata response with zero snapshot refs is
        // deliberately excluded: it can describe graph-backed assets whose
        // aggregate transport has not been integrity-verified here.
        if (
          wsMetaResult.completed
          && !wsMetaResult.timedOut
          && wsDataResult.completed
          && !wsDataResult.timedOut
        ) {
          summary.swmCoverage = selectSwmSnapshotCoverage(summary.swmCoverage, {
            contextGraphId: pid,
            peerIdSuffix: remotePeerId.slice(-8),
            snapshotsResolved: 0,
            snapshotsTotal: 0,
            manifestComplete: true,
            descriptorsAuthoritative: true,
            missingCount: 0,
            missingSample: [],
            materializationFailures: 0,
          });
        }
        // Count a genuinely empty public graph as complete without requiring
        // cursor movement. Each phase still owns its outcome, so a timeout in
        // one phase cannot be hidden by the sibling's clean empty response.
        recordPhaseOutcome(wsMetaResult, { emptyPhase: true });
        recordPhaseOutcome(wsDataResult, { emptyPhase: true });
        if (
          wsMetaResult.completed
          && !wsMetaResult.timedOut
          && wsDataResult.completed
          && !wsDataResult.timedOut
        ) {
          if (metadataFetcher) {
            recoveryBoundary.commit(() => metadataFetcher.release(pid));
          }
        }
        if ((wsMetaResult.timedOut || wsDataResult.timedOut) && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) {
          break;
        }
        continue;
      }

      const validWsQuads = processed.verifiedData;
      const dropped = processed.droppedDataTriples;
      const hydrateOwnership = () => {
        for (const { dataGraph, entity, creator } of processed.entityCreators) {
          const ownershipKey = sharedMemoryOwnershipKeyFromGraph(pid, dataGraph);
          if (!ownershipKey) {
            logWarn(ctx, `SWM sync skipped ownership cache hydration for "${entity}" from unexpected graph "${dataGraph}"`);
            continue;
          }
          const ownedMap = ensureOwnedMap(ownershipKey);
          if (!ownedMap.has(entity)) {
            ownedMap.set(entity, creator);
          }
        }
      };
      if (dropped > 0) {
        logWarn(ctx, `SWM sync dropped ${dropped} triples with invalid subjects (not in meta rootEntity or skolemized child)`);
        summary.droppedDataTriples += dropped;
      }

      // MATERIALIZE verified snapshots into the store, mirroring the private
      // recovery lane (`swm-recovery.ts` materializeReadySnapshot).
      //
      // Descriptors are parsed ONLY from verified meta, and only when the meta
      // phase completed: parseGraphScopedSwmRecoveryDescriptors throws on
      // incomplete metadata, and this lane pages meta, so a timed-out page would
      // otherwise abort the whole CG fanout. A parse failure here must degrade to
      // "no materialization this round" — never take down the sync.
      const snapshotDescriptorsByRef = new Map<string, GraphScopedSwmRecoveryDescriptor[]>();
      let verifiedMetaForInsert = processed.verifiedMeta;
      // Whether the descriptor map is an AUTHORITATIVE statement about this
      // round's metadata, i.e. whether "this ref has no descriptor" may be read
      // as "this ref has nothing to materialize".
      //
      // `manifestComplete` cannot answer that. The parse below runs INSIDE a
      // block whose entry condition is `wsMetaResult.completed`, so on the
      // failure path `manifestComplete` is guaranteed true exactly where the map
      // is guaranteed empty-for-the-wrong-reason. Manifest complete AND
      // descriptors never parsed is a third state, distinct both from a
      // truncated meta phase and from a genuine entity-share manifest that has
      // no head rows to describe.
      if (snapshotMaterializer && publicSnapshotStore && wsMetaResult.completed) {
        try {
          const descriptors = parseGraphScopedSwmRecoveryDescriptors({
            contextGraphId: pid,
            metaQuads: processed.verifiedMeta,
            // Without the subgraph admission context every KA under a
            // REGISTERED subgraph is judged to live in an unregistered metadata
            // graph. The parser then throws, the catch clears ALL descriptors,
            // and materialization is silently disabled for the whole context
            // graph — not just for the subgraph KA that triggered it.
            ...(registeredSubGraphNames ? { registeredSubGraphNames } : {}),
            ...(excludedSubGraphNames ? { excludedSubGraphNames } : {}),
          });
          verifiedMetaForInsert = canonicalizeGraphScopedSwmHeadRows({
            metaQuads: processed.verifiedMeta,
            descriptors,
          });
          for (const descriptor of descriptors) {
            const ref = descriptor.publicSnapshotRef;
            if (!ref) continue; // no immutable snapshot for this KA
            const list = snapshotDescriptorsByRef.get(ref) ?? [];
            list.push(descriptor);
            snapshotDescriptorsByRef.set(ref, list);
          }
        } catch (err) {
          logWarn(ctx, `SWM sync could not parse graph-scoped snapshot descriptors for "${pid}": `
            + `${err instanceof Error ? err.message : String(err)}`);
          snapshotDescriptorsByRef.clear();
          // The map is now empty because parsing FAILED, not because there was
          // nothing to describe. Without this the vacuity rule would read every
          // manifest ref as "nothing to write" and report the graph fully
          // materialized while zero assertion graphs were written — and because
          // the parser builds its whole array before returning, ONE malformed
          // head discards the descriptors of every valid KA alongside it.
          descriptorsAuthoritativeForCg = false;
        }
      }
      let materializedGraphs = 0;
      let materializationFailures = 0;
      let materializedQuads = 0;
      const manifestSnapshots = collectPublicSnapshotMetadata(processed.verifiedMeta);
      const orderedManifestSnapshots = snapshotRecoveryOrder === 'recent-balanced'
        ? orderPublicSnapshotsForBalancedRecency(manifestSnapshots)
        : manifestSnapshots;
      const snapshotWalk = metadataFetcher?.snapshotWalk?.(pid, orderedManifestSnapshots);
      const materializedKeys = new Set<string>();
      /** Snapshot refs whose every descriptor is locally present. */
      const materializedRefs = new Set<string>(snapshotWalk?.resolvedRefsSnapshot() ?? []);
      materializedRefsForCg = materializedRefs.size;
      /** Refs that fetched but could not be written; named in the shortfall. */
      const unresolvedRefSample: string[] = [];

      // #2050 G7. `replaceHeadMetadata` is DELETE-ONLY, and the compensating
      // `storeInsert(processed.verifiedMeta)` sits below the `continue` on the
      // incomplete branch — so a round that ran out of clock mid-list deleted the
      // head rows of the KAs it had just materialized and never rewrote them:
      // content present, heads absent, invisible to every head reader, and
      // permanent, because the next round sees the content and skips.
      //
      // Each KA's own verified metadata is therefore rewritten here, inside the
      // same write lock, immediately after the delete — narrowing a window that
      // already exists rather than opening a new one.
      const snapshotCommit = new GraphScopedSnapshotCommitCoordinator(
        processed.verifiedMeta,
        reconcileFinalizedTwin,
      );
      // A selected continuation skips blob and assertion-graph work for its
      // verified prefix, but the final bulk metadata append is owned by this
      // round. Reapply the exact suppression decisions captured with each
      // resolved ref so a later successful suffix cannot resurrect metadata
      // that the prefix deliberately withheld.
      if (snapshotWalk) {
        for (const resolvedRef of snapshotWalk.resolvedRefsSnapshot()) {
          snapshotCommit.suppressRows(snapshotWalk.suppressedMetadataRows(resolvedRef));
        }
      }
      let contextGraphEnsured = false;
      const ensureContextGraphOnce = async (): Promise<void> => {
        if (contextGraphEnsured) return;
        await ensureContextGraph(pid);
        contextGraphEnsured = true;
      };
      /**
       * True when the stored head already certifies exactly THIS descriptor's
       * version. Anything else — no head at all, or an older one — must be
       * rewritten: by this point `storedVersionOutranksDescriptor` has already
       * returned for every stored version that outranks or fails to parse, so a
       * surviving mismatch is a head that under-states what the store holds.
       * That is reachable whenever a pass replaced the graph and stopped before
       * the head swap, and it never self-heals through partial rounds — which is
       * the only kind of round #2050's scenario gets.
       */
      const headCertifiesDescriptor = (stored: string | null, descriptorVersion: string): boolean => {
        if (stored === null) return false;
        try {
          return BigInt(stored) === BigInt(descriptorVersion);
        } catch {
          return false;
        }
      };
      /**
       * Write this descriptor's verified metadata, and count each distinct row
       * once. The filter is defensive only: on the public lane descriptors are
       * parsed from `processed.verifiedMeta` itself and `metadataQuads` is a
       * partition of that same input, so it cannot drop a row here — but it is
       * what makes the ledger provably a subset of this round's verified keys,
       * which is what makes the bulk subtraction below exact.
       */
      const insertVerifiedDescriptorMeta = async (
        descriptor: GraphScopedSwmRecoveryDescriptor,
      ): Promise<void> => {
        const rows = snapshotCommit.unwrittenVerifiedRows(descriptor);
        if (rows.length === 0) return;
        await ensureContextGraphOnce();
        await storeInsert([...rows]);
        snapshotCommit.recordWritten(rows);
        summary.insertedTriples += rows.length;
        summary.insertedMetaTriples += rows.length;
      };
      /**
       * GH#2273 — every head rewrite on this lane goes through ONE decision:
       * when the stored operations the head references are identity-equivalent
       * to the descriptor's (same content commitment, envelope and author under
       * a different operation id — the storage-ACK/originator residue), repair
       * PRESERVES a stored identity instead of adopting the descriptor's,
       * because a queued VM-publish job may have frozen that stored id at
       * admission and rotating it kills the job terminally. Any genuine
       * difference routes to `replaceHeadMetadata` — exactly today's behavior,
       * which is the correct outcome for a real content or policy change.
       * The loser id row is suppressed so neither the per-KA meta insert nor
       * the round's bulk append re-stacks it onto the repaired head.
       */
      /**
       * The ONE preserve step: withholding the losing descriptor id from
       * every later write this round (per-KA meta insert AND the bulk append)
       * is inseparable from the decision to preserve — a caller that decided
       * without withholding would let the bulk append re-stack the rejected
       * id onto the head it just protected. Both preserve paths below go
       * through here.
       */
      /**
       * The ONE preserve operation: DECIDING is WITHHOLDING. When a stored
       * identity wins, the losing descriptor id row is suppressed from every
       * later write this round (per-KA meta insert AND the bulk append) in
       * the same call that made the decision — no call site can select a
       * winner and forget the ledger, which would let the bulk append
       * re-stack the rejected id onto the head it just protected. Returns
       * the winning stored id, or null when the descriptor wins.
       */
      const decideAndWithholdStoredIdentity = async (
        descriptor: GraphScopedSwmRecoveryDescriptor,
        how: string,
      ): Promise<string | null> => {
        const preserved = await snapshotMaterializer!.selectRepairIdentity(pid, descriptor);
        if (!preserved) return null;
        // The materializer returns the complete plan: winner + the exact rows
        // to withhold. Suppression consumes that plan, not a re-derivation.
        snapshotCommit.suppressRows(preserved.withholdRows);
        logInfo(ctx, `SWM sync for "${pid}": ${how} for ${descriptor.kaUal} preserving `
          + `stored operation identity ${preserved.winnerShareOperationId} `
          + `(descriptor offered equivalent ${descriptor.shareOperationId})`);
        return preserved.winnerShareOperationId;
      };
      const repairOrReplaceHead = async (
        descriptor: GraphScopedSwmRecoveryDescriptor,
      ): Promise<void> => {
        const winner = await decideAndWithholdStoredIdentity(descriptor, 'repaired head');
        if (winner !== null) {
          await snapshotMaterializer!.repairHeadPreservingIdentity(pid, descriptor, winner);
        } else {
          await snapshotMaterializer!.replaceHeadMetadata(pid, descriptor);
        }
        await insertVerifiedDescriptorMeta(descriptor);
      };
      const materializeReadySnapshot = async (snapshotRef: string): Promise<void> => {
        const descriptors = snapshotDescriptorsByRef.get(snapshotRef);
        // Missing WIRING means nothing CAN be written, so the ref stays
        // UNRESOLVED: a fetched-but-unwritten ref must never look like progress
        // to the continuation loop.
        if (!snapshotMaterializer || !publicSnapshotStore) return;
        // No descriptors is a DIFFERENT case, and collapsing the two made a
        // fully-synced peer permanently capable.
        //
        // The denominator (`snapshotsTotal`) counts refs in the peer's manifest;
        // the numerator counts refs we materialized. A manifest ref that this
        // round's verified metadata does not describe — a superseded
        // share-operation row, say — has no descriptor, so it could never enter
        // `materializedRefs`. `snapshotsResolved < snapshotsTotal` then held
        // FOREVER: `capablePeersForNextPass` kept calling that peer capable, and
        // every future catch-up job spent its whole pass budget re-walking a
        // graph that was already complete, at O(KA size) per cached ref.
        //
        // When the manifest is complete, "no descriptor" means there is genuinely
        // nothing to write for this ref, so it is resolved by vacuity. Gated on
        // `manifestComplete` because a truncated meta phase never parsed
        // descriptors at all — there "no descriptor" means "not known yet", and
        // counting it would inflate coverage for a peer that advertised nothing.
        if (!descriptors?.length) {
          // `descriptorsAuthoritative` as well as `manifestComplete`: a parse
          // failure empties this map while the meta phase reports complete, and
          // treating that as vacuity reports full coverage on a round that wrote
          // nothing — wrong in the flattering direction, which is the direction
          // no downstream reader can detect.
          if (manifestComplete && descriptorsAuthoritativeForCg) {
            materializedRefs.add(snapshotRef);
            materializedRefsForCg = materializedRefs.size;
          }
          return;
        }
        let refMaterialized = true;
        for (const descriptor of descriptors) {
          const graphKey = `${descriptor.metaGraph}\u0000${descriptor.assertionGraph}`;
          if (materializedKeys.has(graphKey)) continue;
          try {
            await recoveryBoundary.commit(() => snapshotMaterializer.withKaWriteLock(
              pid,
              descriptor.subGraphName,
              descriptor.kaUal,
              async () => {
                recoveryBoundary.assertCurrent();
                // ALL decisions live INSIDE the lock. Between our pre-lock view
                // of the world and acquisition, live gossip may have committed
                // this KA — the lock stops the interleaving, and the two
                // re-checks below stop the other failure the lock alone cannot:
                // replacing newer content with an older verified snapshot.
                //
                // (a) Version ordering. A stored head newer than the descriptor
                // means gossip advanced this KA past our snapshot; replacing
                // would be overwrite-with-older, byte-for-byte the regression
                // this path once shipped (peer at 76 quads clobbered to 27).
                // Unparseable versions count as newer: when we cannot reason
                // about ordering we must not destroy. Nor may we "repair" the
                // head rows here — gossip owns a newer head and its
                // delete-then-insert already wrote it unambiguously.
                const storedHead = await snapshotMaterializer.readStoredHead(descriptor);
                if (
                  storedHead.version !== null
                  && storedVersionOutranksDescriptor(storedHead.version, descriptor.assertionVersion)
                ) {
                  // GH#2273 — the skipped descriptor's HEAD rows must not reach
                  // the round's bulk append either: an older version's rows
                  // union-inserted onto the live head make it multi-VERSIONED,
                  // which is the overwrite-with-older hazard above arriving via
                  // the metadata side. Operation-subject rows may still land as
                  // immutable history; only the head subject is withheld.
                  snapshotCommit.suppressRows(descriptor.metadataQuads.filter(
                    (quad) => quad.subject === descriptor.headSubject,
                  ));
                  materializedKeys.add(graphKey);
                  logDebug(ctx, `SWM sync for "${pid}": snapshot ${snapshotRef} superseded by `
                    + `stored version ${storedHead.version} (descriptor ${descriptor.assertionVersion}); skipping`);
                  return;
                }
                // (b) Exact content already present. Count AND digest: a
                // marker-only or short graph is the pre-fix broken state and
                // must be REPAIRED; an equal-count graph with a different
                // digest is an OLDER version of the same size and must be
                // replaced, not skipped.
                if (await snapshotMaterializer.isGraphAssetMaterialized(descriptor)) {
                  // Content is already this descriptor's. Two states still need
                  // the head rewritten, and BOTH are invisible to a reader that
                  // only looks at content:
                  //
                  // (1) union-insert residue — several version/operation rows on
                  //     one subject, left by a prior round that replaced the
                  //     graph and failed before finishing the metadata swap;
                  // (2) a head that does not certify THIS descriptor's version —
                  //     absent entirely (the r26 residual: content written, head
                  //     deleted, never rewritten), or an older version left by a
                  //     pass that stopped between the replace and the swap.
                  //
                  // Both are repaired the same way and for the same reason: on a
                  // partial round nothing else writes this head, so leaving it
                  // means the KA stays unreadable no matter how many passes run.
                  if (
                    storedHead.needsRepair
                    || !headCertifiesDescriptor(storedHead.version, descriptor.assertionVersion)
                  ) {
                    await repairOrReplaceHead(descriptor);
                  } else if (
                    storedHead.shareOperationId !== null
                    && storedHead.shareOperationId !== descriptor.shareOperationId
                  ) {
                    // Decision delegated to the materializer's single owner
                    // (shared with the private recovery lane) via
                    // decideAndWithholdStoredIdentity below.
                    // GH#2273 stage 1 — content identical, head healthy, but the
                    // peer references a DIFFERENT operation id. When the stored
                    // operation is identity-equivalent (selectRepairIdentity
                    // compares the full allow-list under the held lock), the
                    // stored identity wins: suppress the descriptor's head-id
                    // row so the bulk append cannot union it onto the head —
                    // that union is what made the head multi-valued and, one
                    // round later, rotated it to the remote id and terminally
                    // killed any queued VM-publish job frozen on the local id.
                    // Non-equivalent (genuine policy/author change): no
                    // suppression, today's convergence to remote authority.
                    //
                    // Preserving is a REWRITE, not a skip: version/id
                    // cardinality is all this branch checked, but the resolver
                    // validates MORE head rows than that — a stale extra
                    // assertionGraph/kaUal row is invisible here yet corrupt to
                    // the reader, and suppressing the descriptor's id row would
                    // otherwise freeze that residue in place round after round
                    // (one clean version + one clean id = this same branch
                    // forever). The preserving repair rewrites the head from
                    // the descriptor's rows with the stored winner id, purging
                    // anything the cardinality check cannot model — the same
                    // decide-and-enact shape the private recovery lane uses.
                    const winner = await decideAndWithholdStoredIdentity(descriptor, 'kept head');
                    if (winner !== null) {
                      await snapshotMaterializer.repairHeadPreservingIdentity(pid, descriptor, winner);
                    }
                  }
                  materializedKeys.add(graphKey);
                  return;
                }
                const asset = await materializeGraphScopedSwmRecoveryAsset({
                  descriptor,
                  fetchedDataQuads: [],
                  publicSnapshotStore,
                });
                await ensureContextGraphOnce();
                await snapshotMaterializer.replaceGraph(asset.assertionGraph, [...asset.quads]);
                // Graph first, THEN the head swap — a crash between the two
                // leaves content newer than the head, which the next round
                // repairs (digest matches → head rewritten above). The swap
                // deletes the old head + its operations so the insert that
                // follows lands on a clean subject instead of stacking a second
                // version onto it (LIMIT-1 head readers would otherwise see an
                // arbitrary mix).
                // GH#2273 — this call site rotates identity too: a KA whose
                // content was absent but whose head references a live local
                // operation (the r26 head-present/graph-absent residual) must
                // not lose that identity when the graph is filled from an
                // equivalent peer snapshot. Same single decision as the
                // repair exit above; the meta insert stays immediately after
                // and inside this KA's lock — the delete inside is the whole
                // of G7 without it, since `storeInsert(processed.verifiedMeta)`
                // is below the incomplete branch's `continue` and never runs
                // on a partial round.
                await repairOrReplaceHead(descriptor);
                materializedKeys.add(graphKey);
                materializedGraphs += 1;
                materializedQuads += asset.quads.length;
                // Counted HERE, not after the snapshot phase returns. A
                // snapshot-phase transport failure THROWS, and the prefix-salvage
                // path does not cover this phase, so the throw unwinds past every
                // post-call merge — a round that materialized 120 KAs and then
                // threw used to report zero inserted triples. The KA is already
                // committed at this point (graph replaced, head rewritten, both
                // inside this lock), so the counter is describing work that is
                // durably done rather than work still in flight.
                summary.insertedTriples += asset.quads.length;
                // Also DATA progress: lifecycle readiness classifies a round with
                // zero `insertedDataTriples` as metadata-only, which would
                // mis-report a successful graph-scoped materialization as "no
                // data".
                summary.insertedDataTriples += asset.quads.length;
                logInfo(ctx, `SWM sync for "${pid}": materialized snapshot ${snapshotRef} `
                  + `as ${asset.assertionGraph} (${asset.quads.length} triples)`);
              },
            ));
            // The opposite ordering from durable VM catch-up is equally
            // possible: VM may already be present when this SWM snapshot
            // arrives. Reconcile only after releasing the materialization
            // lock; the production callback reacquires the same per-KA lock
            // and re-verifies current head + both graph digests before delete.
            await recoveryBoundary.commit(() => snapshotCommit.reconcileAfterMaterialization({
              contextGraphId: pid,
              descriptor,
              onDeferred: (cause) => logWarn(
                ctx,
                `SWM sync deferred finalized-twin reconciliation for ${descriptor.kaUal}: `
                  + `${cause instanceof Error ? cause.message : String(cause)}`,
              ),
            }));
          } catch (err) {
            // Revocation must escape this best-effort materialization catch;
            // treating it as one failed snapshot would let the stale run keep
            // walking and reach later commit points.
            recoveryBoundary.assertCurrent();
            // A failed replace must never be able to look materialized later.
            // Suppressing it here while the surrounding sync still inserts the
            // graph-scoped head marker makes the loss PERMANENT: the next pass
            // sees that marker, isGraphAssetMaterialized returns true, and the
            // missing assertion graph is skipped forever. Record the failure so
            // the caller keeps the phase incomplete and withholds the metadata
            // that would otherwise certify a graph that was never written.
            materializationFailures += 1;
            refMaterialized = false;
            // Deduped by ref, not merely capped: `materializationFailures`
            // increments per DESCRIPTOR, so one ref carrying several descriptors
            // pushed itself once per failure and the sample read
            // "including refX, refX, refX". The count it is a sample OF is per
            // REF, so an undeduped sample can also grow longer than
            // `missingCount`, driving the renderer's `missingCount - sample.length`
            // negative and silently suppressing the "(+N more)" suffix.
            if (
              unresolvedRefSample.length < PUBLIC_SNAPSHOT_MISSING_SAMPLE_LIMIT
              && !unresolvedRefSample.includes(snapshotRef)
            ) {
              unresolvedRefSample.push(boundSampledRef(snapshotRef));
              // Mirrored outside the `try`, like the counters, so a later throw
              // cannot lose refs we already know failed to write.
              unresolvedRefSampleForCg.push(boundSampledRef(snapshotRef));
            }
            // Mirrored outside the `try` so a later throw cannot lose it.
            materializedFailuresForCg = materializationFailures;
            logWarn(ctx, `SWM sync failed to materialize snapshot ${snapshotRef} for "${pid}": `
              + `${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // Resolved means LOCALLY MATERIALIZED — every descriptor for this ref
        // written or already present. A ref that fetched and then failed to
        // write is not resolved, which is what stops an all-cached round whose
        // writes all failed from reporting maximal coverage and silently
        // ending the continuation.
        if (refMaterialized) {
          materializedRefs.add(snapshotRef);
          materializedRefsForCg = materializedRefs.size;
        }
      };

      const snapshotStartedAt = Date.now();
      recoveryBoundary.assertCurrent();
      const snapshotSync = await syncPublicSnapshotsForMeta({
        ctx,
        remotePeerId,
        contextGraphId: pid,
        deadline,
        ...(snapshotWalk
          ? { snapshotWalk }
          : {
            metaQuads: processed.verifiedMeta,
            recoveryOrder: snapshotRecoveryOrder,
          }),
        publicSnapshotStore,
        fetchSyncPages,
        deleteCheckpoint,
        setCheckpoint,
        executionBoundary: recoveryBoundary,
        // Fires for BOTH 'cache' and 'network' sources, so a node whose earlier
        // runs already cached the blobs materializes them on the next pass
        // without refetching a byte.
        //
        // Wired UNCONDITIONALLY. It used to be gated on
        // `snapshotDescriptorsByRef.size > 0`, which looked like an optimisation
        // and was the reason a whole class of Context Graph reported `0/N`
        // snapshots for ever.
        //
        // The manifest and the descriptors come from different readers.
        // `collectPublicSnapshotMetadata` accepts any subject carrying
        // `dkg:publicQuadsDigest` + `dkg:publicQuadsCount`, while
        // `parseGraphScopedSwmRecoveryDescriptors` anchors on `#dkg-swm-head`
        // subjects only. An entity-level share writes its public slice under a
        // `urn:dkg:public-stage:...` subject and no head row, so a CG written
        // entirely by that path — the primary shared-memory write API — produces
        // refs in the manifest and NO descriptors at all. The hook was then never
        // wired, `materializeReadySnapshot` never ran, and the ref could not be
        // counted resolved by any path.
        //
        // `snapshotsResolved < snapshotsTotal` therefore held permanently, so
        // `capablePeersForNextPass` kept nominating a peer that owed us nothing,
        // on every pass of every catch-up job, at O(KA size) per cached ref.
        //
        // Wiring it always is what makes the descriptor-less branch inside
        // `materializeReadySnapshot` reachable, and that branch is where the
        // vacuity decision — and its `manifestComplete` guard — actually lives.
        // The hook still early-returns when the materializer or the store is
        // absent, so this costs nothing when there is genuinely no wiring.
        onSnapshotReady: async (snapshot: PublicSnapshotMetadata) => {
          await materializeReadySnapshot(snapshot.ref);
          recoveryBoundary.assertCurrent();
          if (materializedRefs.has(snapshot.ref)) {
            const suppressedRows = (snapshotDescriptorsByRef.get(snapshot.ref) ?? [])
              .flatMap((descriptor) => snapshotCommit.suppressedRows(descriptor.metadataQuads));
            snapshotWalk?.markResolved(snapshot.ref, suppressedRows);
          }
        },
      });
      if (materializedGraphs > 0) {
        // Reporting only — the counters were already added per KA, inside the
        // write lock, so they survive a snapshot-phase throw. Adding them again
        // here would double-count every materialized triple.
        logInfo(ctx, `SWM sync for "${pid}": materialized ${materializedGraphs} graph-scoped `
          + `KA snapshot(s) totalling ${materializedQuads} triples`);
      }
      summary.bytesReceived += snapshotSync.bytesReceived;
      summary.snapshotPhaseBytesReceived += snapshotSync.bytesReceived;
      summary.resumedPhases += snapshotSync.resumedPhases;
      summary.timedOutPhases += snapshotSync.timedOutPhases;
      summary.completedPhases += snapshotSync.completedPhases;
      summary.checkpointAdvances += snapshotSync.checkpointAdvances;
      // Coverage is recorded HERE — above the incomplete branch below — because
      // a partial round is exactly the round whose coverage the caller needs.
      // The counts, the peer they are attributed to and the missing sample all
      // come from this one round and stay together from here on.
      //
      // No record for a non-empty graph that declared no snapshot refs. That
      // shape can contain graph-backed assets and is not terminal until their
      // count/digest-bound transport is implemented. Only the clean
      // two-phase-empty branch above emits explicit 0/0 completion.
      //
      // Across a MULTI-CG call the reduction keeps exactly ONE graph's record,
      // named by its `contextGraphId`; the others are dropped. Foreground
      // catch-up always passes a single CG (`syncPublicContextGraph` in
      // `dkg-agent-lifecycle.ts`, the only caller of this function), so that
      // only bites the on-connect fan-out, where this field is a diagnostic
      // rather than a decision input.
      recordSnapshotCoverage(
        snapshotSync,
        wsMetaResult.completed,
        descriptorsAuthoritativeForCg,
        materializationFailures,
        materializedRefs.size,
        unresolvedRefSample,
        pid,
      );
      // A voluntary yield is OUR budget decision, not the peer's fault. It is
      // recorded here and deliberately kept out of `timedOutPhases`, which
      // feeds `backoffWorthyFailure` and would back the peer off for it. It is
      // NOT kept out of `failedPhases` below: the round really did not complete
      // the plane, and without that the round classifies as clean and reports
      // the graph `done` while Knowledge Assets are still missing.
      if (snapshotSync.yieldedAtDeadline) {
        summary.snapshotPlaneIncomplete += 1;
        logInfo(ctx, `SWM sync for "${pid}": yielded at the round deadline with `
          + `${snapshotSync.missingCount} of ${snapshotSync.totalSnapshots} snapshot(s) unresolved`);
      }
      const snapshotDurationMs = Date.now() - snapshotStartedAt;
      // A snapshot that verified but could not be written must be treated
      // exactly like a snapshot phase that did not complete. Otherwise the meta
      // insert below stamps a graph-scoped head marker for an assertion graph
      // that was never materialized, and every later pass skips it as already
      // present — turning a transient store error into permanent, silent loss.
      // `descriptorsAuthoritative` belongs in this conjunction for the same
      // reason `materializationFailures` does: in both cases snapshots were
      // fetched and verified but the Knowledge Assets behind them were NOT
      // written. A parse failure produces no `materializationFailures` — nothing
      // was ever attempted — so without this the phase reads usable, the bulk
      // `storeInsert(processed.verifiedMeta)` below lands head rows certifying
      // assertion graphs that hold nothing, and the next round's
      // `isGraphAssetMaterialized` sees those markers and skips the KAs for
      // good. That is the same permanent-invisibility failure the G7 repair in
      // this PR exists to prevent, arrived at from a different direction.
      // The requester applies the caller's evidence policy without knowing
      // which synchronization lane owns it. A stricter lane can therefore
      // reject shapes it cannot yet prove while ordinary SWM keeps the
      // canonical permissive default.
      const snapshotEvidenceAccepted = snapshotEvidencePolicy?.accepts({
        verifiedMetadataTriples: processed.verifiedMeta.length,
        snapshotReferences: snapshotSync.totalSnapshots,
        graphBackedOperations: countGraphBackedSnapshotOperations(processed.verifiedMeta),
      }) ?? true;
      const snapshotPhaseUsable = snapshotSync.completed
        && materializationFailures === 0
        && (descriptorsAuthoritativeForCg || snapshotSync.totalSnapshots === 0)
        && snapshotEvidenceAccepted;
      if (materializationFailures > 0) {
        logWarn(ctx, `SWM sync for "${pid}": ${materializationFailures} snapshot(s) verified but `
          + `not materialized — holding the phase incomplete so metadata cannot certify them`);
      }
      if (!descriptorsAuthoritativeForCg) {
        logWarn(ctx, `SWM sync for "${pid}": snapshot descriptors could not be parsed — holding `
          + `the phase incomplete so metadata cannot certify Knowledge Assets that were never written`);
      }
      if (!snapshotEvidenceAccepted) {
        logWarn(ctx, `SWM sync for "${pid}": snapshot evidence policy rejected the verified metadata shape; `
          + 'holding the phase incomplete until the caller can prove the referenced content');
      }
      if (!snapshotPhaseUsable) {
        // The responder was reachable, but the snapshot phase did not produce
        // a complete, verified snapshot. Preserve any verified data prefix
        // below, while keeping the overall sync result non-successful so the
        // lifecycle scheduler retries instead of stamping this peer as caught
        // up with dangling/missing public snapshot state.
        summary.failedPhases += 1;
        if (validWsQuads.length > 0) {
          await recoveryBoundary.commit(async () => {
            await ensureContextGraph(pid);
            await storeInsert(validWsQuads);
            // Ownership belongs to the same admitted logical write as the
            // verified data. Revocation may be observed after this unit, but
            // must never leave inserted entities without their arbitration
            // state merely because it landed during the awaited insert.
            hydrateOwnership();
          });
          summary.insertedTriples += validWsQuads.length;
          summary.insertedDataTriples += validWsQuads.length;
          recordPhaseOutcome(wsDataResult);
        }
        if (snapshotSync.timedOutPhases > 0 && shouldStopAfterBackoffWorthyFailure(pid, 'snapshot timeout')) {
          break;
        }
        continue;
      }

      const storeStartedAt = Date.now();
      let metaForBulkInsert: Quad[] = [];
      let newlyCountedMeta = 0;
      if (verifiedMetaForInsert.length > 0) {
        // Rows written by the per-KA path are ordinarily harmless to replay —
        // an RDF store is a set. Rows for a twin retired after that path are
        // different: replaying them would recreate a dangling SWM head/op after
        // its exact graph was removed, so those rows are excluded from the
        // actual bulk write.
        //
        // The COUNT subtracts what was already counted, which makes
        // `insertedMetaTriples` mean this:
        //   - usable round  → `processed.verifiedMeta.length`, byte-identical to
        //     the pre-#2050 counter. No existing round's number moves.
        //   - partial round → the rows the per-KA path wrote: strictly > 0 when
        //     anything materialized, strictly < the full meta length.
        //
        // That second line INVERTS the field's diagnostic meaning, which matters
        // because `insertedMetaTriples === 0` is the discriminator for whether a
        // job hit G7 at all. Pre-fix, zero on a partial round WAS the symptom.
        // Post-fix, non-zero on a partial round is the expected repair signal,
        // and zero means nothing was materialized rather than that the writes
        // were thrown away.
        //
        // Keep the old count identity for ordinary rows. Only retired rows are
        // filtered, while the per-KA ledger remains a key-set subset of the
        // verified input and is subtracted solely when its row survives.
        metaForBulkInsert = snapshotCommit.bulkRows(verifiedMetaForInsert);
        const retainedAlreadyCounted = snapshotCommit.alreadyCountedRetainedRows();
        newlyCountedMeta = metaForBulkInsert.length - retainedAlreadyCounted;
      }

      // The aggregate data, its verified metadata and the in-memory ownership
      // projection form one admitted recovery unit. Once the first awaited
      // mutation starts, a selection revocation is deliberately observed only
      // after all three effects drain, preventing a stale invocation from
      // leaving a data-only or metadata-without-ownership state.
      await recoveryBoundary.commit(async () => {
        await ensureContextGraph(pid);
        if (validWsQuads.length > 0) await storeInsert(validWsQuads);
        if (metaForBulkInsert.length > 0) await storeInsert(metaForBulkInsert);
        hydrateOwnership();
      });

      if (validWsQuads.length > 0) {
        summary.insertedTriples += validWsQuads.length;
        summary.insertedDataTriples += validWsQuads.length;
      }
      summary.insertedTriples += newlyCountedMeta;
      summary.insertedMetaTriples += newlyCountedMeta;
      recordPhaseOutcome(wsMetaResult);
      recordPhaseOutcome(wsDataResult);
      if (metadataFetcher) {
        recoveryBoundary.commit(() => metadataFetcher.release(pid));
      }
      if ((wsMetaResult.timedOut || wsDataResult.timedOut) && shouldStopAfterBackoffWorthyFailure(pid, 'phase timeout')) {
        break;
      }
      const storeDurationMs = Date.now() - storeStartedAt;

      logInfo(ctx, `SWM sync for "${pid}": ${validWsQuads.length} data + ${verifiedMetaForInsert.length} meta triples`);
      if (fetchDurationMs + verifyDurationMs + snapshotDurationMs + storeDurationMs > 100) {
        logDebug(
          ctx,
          `Requester SWM timing for "${pid}": fetch=${fetchDurationMs}ms verify=${verifyDurationMs}ms snapshots=${snapshotDurationMs}ms store+ownership=${storeDurationMs}ms`,
        );
      }
    } catch (err) {
      // A snapshot-phase failure unwinds past the coverage record built on the
      // success path, so a round that materialized 120 Knowledge Assets and then
      // threw would report NOTHING — and the continuation loop reads
      // `snapshotsResolved`, so it would see a converging peer as stalled and
      // drop it. Recover the walk's own counts and record them here.
      const thrownProgress = readPublicSnapshotWalkProgress(err);
      if (thrownProgress) {
        // Same builder as the success path — the counts arrive as one coherent
        // group attached by the walk, never reassembled here.
        recordSnapshotCoverage(
          thrownProgress,
          manifestComplete,
          descriptorsAuthoritativeForCg,
          materializedFailuresForCg,
          materializedRefsForCg,
          unresolvedRefSampleForCg,
          pid,
        );
      }
      logWarn(ctx, `SWM sync for context graph "${pid}" from ${remotePeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (isSyncPermanentRejection(err)) {
        // Missed-seam alarm (OT-RFC-56) — see durable-sync.ts: the oversize
        // guard should have filtered this before the insert.
        logWarn(ctx, `PERMANENT ingest rejection for "${pid}" reached the SWM sync catch — an insert seam is missing the oversize guard (sync/oversize-filter.ts): ${err instanceof Error ? err.message : String(err)}`);
      }
      const backoffWorthy = isSyncBackoffWorthyError(err);
      if (backoffWorthy) {
        summary.backoffWorthyFailures += 1;
      }
      if ((err as Error & { syncDenied?: boolean }).syncDenied) {
        summary.deniedPhases += 1;
      } else if (
        peerRespondedForContextGraph ||
        didSyncPeerRespond(err) ||
        !isSyncTransportFailure(err)
      ) {
        summary.failedPhases += 1;
      } else {
        peerFailed = true;
      }
      if (backoffWorthy && shouldStopAfterBackoffWorthyFailure(pid, 'backoff-worthy failure')) {
        break;
      }
    }
  }
  if (peerFailed) {
    summary.failedPeers = 1;
  }
  if (summary.insertedTriples > 0) {
    logInfo(ctx, `SWM sync complete: ${summary.insertedTriples} triples from ${remotePeerId}`);
  }

  return summary;
}

export function sharedMemoryOwnershipKeyFromGraph(contextGraphId: string, dataGraph: string): string | undefined {
  const rootGraph = contextGraphWorkspaceGraphUri(contextGraphId);
  if (dataGraph === rootGraph || isSharedMemoryBucketDescendantDataGraph(dataGraph, rootGraph)) return contextGraphId;

  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  const suffix = '/_shared_memory';
  if (!dataGraph.startsWith(prefix)) return undefined;

  const remainder = dataGraph.slice(prefix.length);
  const suffixAt = remainder.indexOf(suffix);
  if (suffixAt <= 0) return undefined;
  const bucketGraph = dataGraph.slice(0, prefix.length + suffixAt + suffix.length);
  const subGraphName = remainder.slice(0, suffixAt);
  const tail = remainder.slice(suffixAt + suffix.length);
  if (tail && (!tail.startsWith('/') || !isSharedMemoryBucketDescendantDataGraph(dataGraph, bucketGraph))) {
    return undefined;
  }
  if (!subGraphName || subGraphName.includes('/')) return undefined;
  if (!validateSubGraphName(subGraphName).valid) return undefined;

  return `${contextGraphId}\0${subGraphName}`;
}

export interface PublicSnapshotMetadata {
  ref: string;
  digest: string;
  count: number;
  /** Optional, non-authoritative scheduling hint parsed with the manifest. */
  publishedAtMs?: number;
  /** Optional UAL suffix used only as a deterministic recency fallback. */
  ualOrdinal?: bigint;
}

export async function syncPublicSnapshotsForMeta(params: {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphId: string;
  deadline: number;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  fetchSyncPages: SharedMemorySyncContext['fetchSyncPages'];
  deleteCheckpoint: (key: string) => void;
  setCheckpoint: (key: string, offset: number) => void;
  /** Shared with the owning requester invocation so every effect uses one guard. */
  executionBoundary?: RecoveryExecutionBoundary;
  /**
   * Optional recovery hook invoked only after the complete immutable snapshot
   * has passed its signed digest/count check. Callers may make that one KA
   * visible immediately; an unverified prefix never reaches this hook.
   */
  onSnapshotReady?: (
    snapshot: PublicSnapshotMetadata,
    source: 'cache' | 'network',
  ) => Promise<void>;
} & PublicSnapshotWalkSource): Promise<{
  bytesReceived: number;
  resumedPhases: number;
  timedOutPhases: number;
  completedPhases: number;
  checkpointAdvances: number;
  /** Immutable snapshot refs already valid locally or fetched in this round. */
  readySnapshots: number;
  /** Total immutable snapshot refs declared by the verified SWM metadata. */
  totalSnapshots: number;
  completed: boolean;
  /** Exact count of declared refs this round did not resolve. */
  missingCount: number;
  /**
   * Bounded identifiers for the shortfall. A public peer controls manifest
   * size, so this is capped; `missingCount` carries the true figure.
   */
  missingSample: string[];
  /**
   * The round stopped on OUR OWN clock with refs still unfetched — a voluntary
   * yield, not a peer fault. Callers must surface this as
   * `snapshotPlaneIncomplete` and must NOT fold it into `timedOutPhases`, which
   * marks the peer backoff-worthy (`durable-progress.ts` `backoffWorthyFailure`).
   */
  yieldedAtDeadline: boolean;
}> {
  const executionBoundary = params.executionBoundary
    ?? createRecoveryExecutionBoundary();
  executionBoundary.assertCurrent();
  const manifestSnapshots = params.snapshotWalk
    ? []
    : collectPublicSnapshotMetadata(params.metaQuads);
  const snapshots = params.snapshotWalk
    ? params.snapshotWalk.orderedManifestSnapshot()
    : params.recoveryOrder === 'recent-balanced'
      ? orderPublicSnapshotsForBalancedRecency(manifestSnapshots)
      : manifestSnapshots;
  if (snapshots.length === 0) {
    return {
      bytesReceived: 0,
      resumedPhases: 0,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      readySnapshots: 0,
      totalSnapshots: 0,
      completed: true,
      missingCount: 0,
      missingSample: [],
      yieldedAtDeadline: false,
    };
  }
  if (!params.publicSnapshotStore) {
    throw new Error(
      `Cannot sync shared-memory public snapshot refs for "${params.contextGraphId}" without a public snapshot store`,
    );
  }

  let bytesReceived = 0;
  let resumedPhases = 0;
  let timedOutPhases = 0;
  let completedPhases = 0;
  let checkpointAdvances = 0;
  let readySnapshots = 0;
  let missingCount = 0;
  let yieldedAtDeadline = false;
  const missingSample: string[] = [];
  const noteMissing = (ref: string): void => {
    missingCount += 1;
    if (missingSample.length < PUBLIC_SNAPSHOT_MISSING_SAMPLE_LIMIT) {
      missingSample.push(boundSampledRef(ref));
    }
  };
  /** Every ref from `index` onward is unresolved; record them and stop. */
  const abandonFrom = (index: number): void => {
    for (let i = index; i < snapshots.length; i += 1) noteMissing(snapshots[i]!.ref);
  };

  /**
   * Carry what the walk achieved out through a throw.
   *
   * Everything from `index` on is unresolved — the ref that threw included —
   * so the counts obey the same `resolved + missing === total` invariant the
   * returned value does. Without this the caller's `catch` sees only an error,
   * builds no coverage record, and the continuation loop reads a pass that
   * materialized real Knowledge Assets as non-advancing.
   */
  const rethrowWithProgress = (err: unknown, index: number): never => {
    abandonFrom(index);
    attachPublicSnapshotWalkProgress(err, {
      readySnapshots,
      totalSnapshots: snapshots.length,
      missingCount,
      missingSample,
    });
    throw err;
  };

  for (const [index, snapshot] of snapshots.entries()) {
    executionBoundary.assertCurrent();
    // A selected transfer owner may carry exact, manifest-bound evidence from
    // an earlier bounded slice. Skipping these refs is intentionally cheaper
    // than re-reading and re-hashing every snapshot blob and assertion graph:
    // that O(prefix) replay eventually consumed the whole slice and fixed the
    // continuation at N/N+K forever. The owner is in-memory and resets on any
    // manifest change, expiry, release or process restart.
    if (params.snapshotWalk?.isResolved(snapshot.ref)) {
      readySnapshots += 1;
      continue;
    }
    // Yield BETWEEN Knowledge Assets, and check the clock BEFORE doing any work
    // for this one. Both halves matter:
    //
    // - Before, not after: a cache "hit" is O(KA size) — a full `.nq` read plus
    //   a SHA-256 — and a miss is a network round trip. Checking afterwards
    //   would let one KA overrun the budget it was supposed to respect.
    // - Before the fetch specifically: no `SyncPageResult` exists yet, so
    //   `timedOutPhases` structurally CANNOT move on this path. That is what
    //   keeps a local budget decision from being reported as a peer timeout and
    //   putting a healthy responder into backoff.
    //
    // Never mid-KA: a snapshot is applied whole or not at all, so stopping here
    // can never leave a partially materialized asset.
    if (Date.now() >= params.deadline) {
      yieldedAtDeadline = true;
      abandonFrom(index);
      break;
    }
    try {
      if (await executionBoundary.read(
        () => hasValidSnapshot(params.publicSnapshotStore!, snapshot),
      )) {
        if (params.onSnapshotReady) {
          executionBoundary.assertCurrent();
          await params.onSnapshotReady(snapshot, 'cache');
          executionBoundary.assertCurrent();
        }
        readySnapshots += 1;
        continue;
      }

      const snapshotOptions: SyncPageFetchOptions = executionBoundary.signal === undefined
        ? { snapshotRef: snapshot.ref }
        : { snapshotRef: snapshot.ref, signal: executionBoundary.signal };
      const result = await executionBoundary.read(() => params.fetchSyncPages(
        params.ctx,
        params.remotePeerId,
        params.contextGraphId,
        true,
        'snapshot',
        '',
        params.deadline,
        snapshotOptions,
      ));
      bytesReceived += result.bytesReceived;
      resumedPhases += result.resumedFromOffset > 0 ? 1 : 0;
      timedOutPhases += result.timedOut ? 1 : 0;
      if (result.completed) {
        executionBoundary.commit(() => params.deleteCheckpoint(result.checkpointKey));
      }
      else {
        // `fetchSyncPages` returns only the quads fetched during THIS call. We do
        // not persist an unverified prefix, so resuming a snapshot at nextOffset
        // would validate only the tail against the full digest/count and can never
        // succeed. Restart this one immutable KA at offset zero on the next round;
        // already completed snapshots remain cached and are skipped, preserving
        // monotonic recovery progress across the CG without accepting a partial
        // asset.
        executionBoundary.commit(() => params.deleteCheckpoint(result.checkpointKey));
        abandonFrom(index);
        break;
      }

      const snapshotQuads = result.quads.map((quad) => ({ ...quad, graph: '' }));
      if (snapshotQuads.length < snapshot.count) {
        // A relayed stream can terminate cleanly after returning a prefix. The
        // requester then sees `completed=true`, but the signed metadata gives us
        // an authoritative expected count and proves that this is incomplete,
        // not corrupt. Never cache or apply the prefix; retry it from offset zero
        // in a later bounded recovery round. Equal-count digest mismatches remain
        // fatal below so a complete but tampered snapshot is never softened into
        // a transport retry.
        //
        // SKIP this ref and keep walking, rather than returning. Ref order is
        // byte-identical on every pass (`Map` insertion order), so returning here
        // would pin every future pass at this same index: one permanently
        // unserveable ref would stall the whole manifest forever and drive a
        // repeat-pass design to a fixed point at zero progress. Skipping costs
        // this KA and nothing else — it stays uncached and unapplied, and is
        // retried from offset zero next pass.
        executionBoundary.commit(() => params.deleteCheckpoint(result.checkpointKey));
        noteMissing(snapshot.ref);
        continue;
      }
      const actualDigest = workspacePublicQuadsDigest(snapshotQuads);
      if (actualDigest !== snapshot.digest || snapshotQuads.length !== snapshot.count) {
        throw new Error(
          `Shared-memory public snapshot ${snapshot.ref} failed digest/count validation ` +
          `(expected ${snapshot.digest}/${snapshot.count}, got ${actualDigest}/${snapshotQuads.length})`,
        );
      }
      await executionBoundary.commit(() => params.publicSnapshotStore!.putSnapshot({
        digest: snapshot.digest,
        quads: snapshotQuads,
      }));
      if (params.onSnapshotReady) {
        executionBoundary.assertCurrent();
        await params.onSnapshotReady(snapshot, 'network');
        executionBoundary.assertCurrent();
      }
      completedPhases += 1;
      readySnapshots += 1;
    } catch (err) {
      executionBoundary.assertCurrent();
      // Any failure in this KA's work — the blob read, the fetch, the
      // digest check, the store write, or materialization — leaves the walk
      // here. Carry what earlier iterations achieved out with it.
      rethrowWithProgress(err, index);
    }
  }

  return {
    bytesReceived,
    resumedPhases,
    timedOutPhases,
    completedPhases,
    checkpointAdvances,
    readySnapshots,
    totalSnapshots: snapshots.length,
    // The ONLY completion expression, and it is derived rather than asserted.
    // Every path that gives up on a ref — the deadline yield, a fetch that did
    // not complete, and the skipped short prefix — routes through
    // `noteMissing`, so a round can no longer fall out of the loop claiming
    // success while having abandoned work. A hardcoded `true` here is exactly
    // how skip-and-continue would have silently reported a complete manifest.
    completed: missingCount === 0,
    missingCount,
    missingSample,
    yieldedAtDeadline,
  };
}

export function collectPublicSnapshotMetadata(metaQuads: readonly Quad[]): PublicSnapshotMetadata[] {
  const bySubject = new Map<string, {
    ref?: string;
    digest?: string;
    count?: number;
    hasSnapshotGraph?: boolean;
    publishedAtMs?: number;
    ualOrdinal?: bigint;
  }>();
  for (const quad of metaQuads) {
    if (
      quad.predicate !== `${DKG}publicSnapshotRef` &&
      quad.predicate !== `${DKG}publicSnapshotGraph` &&
      quad.predicate !== `${DKG}publicQuadsDigest` &&
      quad.predicate !== `${DKG}publicQuadsCount` &&
      quad.predicate !== `${DKG}publishedAt` &&
      quad.predicate !== `${DKG}kaUal`
    ) {
      continue;
    }
    const entry = bySubject.get(quad.subject) ?? {};
    const value = stripLiteral(quad.object)?.trim();
    if (quad.predicate === `${DKG}publicSnapshotRef`) entry.ref = value;
    if (quad.predicate === `${DKG}publicSnapshotGraph`) entry.hasSnapshotGraph = true;
    if (quad.predicate === `${DKG}publicQuadsDigest`) entry.digest = value;
    if (quad.predicate === `${DKG}publicQuadsCount`) entry.count = parseIntegerLiteral(quad.object);
    if (quad.predicate === `${DKG}publishedAt` && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) entry.publishedAtMs = parsed;
    }
    if (quad.predicate === `${DKG}kaUal` && value) {
      const match = value.match(/\/(\d+)$/);
      if (match) {
        try { entry.ualOrdinal = BigInt(match[1]!); } catch { /* scheduling hint only */ }
      }
    }
    bySubject.set(quad.subject, entry);
  }

  const byRef = new Map<string, PublicSnapshotMetadata>();
  for (const [subject, entry] of bySubject) {
    // Read-both (RFC ka-metadata-trim Phase 2): old-store rows carry an
    // explicit `dkg:publicSnapshotRef` (byte-identical to the digest); new
    // store-backed rows carry only the digest — their ref IS the digest
    // (`putSnapshot` returns `ref === digest`). Rows with a
    // `dkg:publicSnapshotGraph` are graph-backed, not snapshot-store-backed:
    // their quads travel through ordinary graph sync, so they are NOT
    // snapshot-fetch targets.
    let ref = entry.ref;
    if (!ref) {
      // Derived (new-shape) rows must be complete to qualify — an incomplete
      // digest-only row is ignored exactly as ref-less rows always were,
      // rather than promoted into the hard integrity throw below (which
      // stays reserved for explicit-ref rows written by older nodes).
      if (entry.hasSnapshotGraph || !entry.digest || !Number.isInteger(entry.count)) continue;
      ref = entry.digest;
    }
    if (!entry.digest || !Number.isInteger(entry.count)) {
      throw new Error(`Shared-memory public snapshot metadata for ${subject} is missing digest/count`);
    }
    const existing = byRef.get(ref);
    const metadata: PublicSnapshotMetadata = {
      ref,
      digest: entry.digest,
      count: entry.count!,
      ...(entry.publishedAtMs !== undefined ? { publishedAtMs: entry.publishedAtMs } : {}),
      ...(entry.ualOrdinal !== undefined ? { ualOrdinal: entry.ualOrdinal } : {}),
    };
    if (existing && (existing.digest !== metadata.digest || existing.count !== metadata.count)) {
      throw new Error(`Conflicting shared-memory public snapshot metadata for ${ref}`);
    }
    if (!existing) {
      byRef.set(ref, metadata);
      continue;
    }
    const newerHints = newerPublicSnapshotRecency(existing, metadata);
    byRef.set(ref, {
      ...existing,
      ...(newerHints.publishedAtMs !== undefined ? { publishedAtMs: newerHints.publishedAtMs } : {}),
      ...(newerHints.ualOrdinal !== undefined ? { ualOrdinal: newerHints.ualOrdinal } : {}),
    });
  }
  return [...byRef.values()];
}

function newerPublicSnapshotRecency(
  left: Pick<PublicSnapshotMetadata, 'publishedAtMs' | 'ualOrdinal'>,
  right: Pick<PublicSnapshotMetadata, 'publishedAtMs' | 'ualOrdinal'>,
): Pick<PublicSnapshotMetadata, 'publishedAtMs' | 'ualOrdinal'> {
  if ((right.publishedAtMs ?? -1) !== (left.publishedAtMs ?? -1)) {
    return (right.publishedAtMs ?? -1) > (left.publishedAtMs ?? -1) ? right : left;
  }
  return (right.ualOrdinal ?? -1n) > (left.ualOrdinal ?? -1n) ? right : left;
}

/**
 * Build a deterministic 3:1 recent/history walk from verified metadata.
 *
 * `publishedAt` and the UAL suffix affect scheduling only; digest/count remain
 * the integrity boundary. Missing or malformed recency hints fall back to the
 * manifest index, and a manifest with no usable hints keeps its original order.
 */
export function orderPublicSnapshotsForBalancedRecency(
  snapshots: readonly PublicSnapshotMetadata[],
): PublicSnapshotMetadata[] {
  if (
    snapshots.length < 2
    || !snapshots.some((snapshot) => (
      snapshot.publishedAtMs !== undefined || snapshot.ualOrdinal !== undefined
    ))
  ) return [...snapshots];

  const manifestIndex = new Map(snapshots.map((snapshot, index) => [snapshot.ref, index]));
  const ranked = [...snapshots].sort((a, b) => {
    const aTime = a.publishedAtMs;
    const bTime = b.publishedAtMs;
    if (aTime !== undefined || bTime !== undefined) {
      if (aTime === undefined) return -1;
      if (bTime === undefined) return 1;
      if (aTime !== bTime) return aTime - bTime;
    }
    const aOrdinal = a.ualOrdinal;
    const bOrdinal = b.ualOrdinal;
    if (aOrdinal !== undefined || bOrdinal !== undefined) {
      if (aOrdinal === undefined) return -1;
      if (bOrdinal === undefined) return 1;
      if (aOrdinal !== bOrdinal) return aOrdinal < bOrdinal ? -1 : 1;
    }
    return (manifestIndex.get(a.ref) ?? 0) - (manifestIndex.get(b.ref) ?? 0);
  });

  const ordered: PublicSnapshotMetadata[] = [];
  let oldest = 0;
  let newest = ranked.length - 1;
  while (oldest <= newest) {
    for (let recent = 0; recent < 3 && oldest <= newest; recent += 1) {
      ordered.push(ranked[newest]!);
      newest -= 1;
    }
    if (oldest <= newest) {
      ordered.push(ranked[oldest]!);
      oldest += 1;
    }
  }
  return ordered;
}

/**
 * Count graph-backed share operations whose content is outside the immutable
 * snapshot-store walk. The selected SWM lane must fail closed while this
 * aggregate requester cannot prove those transport graphs by count and digest.
 */
function countGraphBackedSnapshotOperations(metaQuads: readonly Quad[]): number {
  return new Set(
    metaQuads
      .filter((quad) => quad.predicate === `${DKG}publicSnapshotGraph`)
      .map((quad) => quad.subject),
  ).size;
}

async function hasValidSnapshot(
  publicSnapshotStore: WorkspacePublicSnapshotStore,
  snapshot: PublicSnapshotMetadata,
): Promise<boolean> {
  let quads: Quad[] | null;
  try {
    quads = await publicSnapshotStore.getSnapshot(snapshot.ref);
  } catch {
    return false;
  }
  if (!quads) return false;
  return quads.length === snapshot.count && workspacePublicQuadsDigest(quads) === snapshot.digest;
}

function stripLiteral(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = value.match(/^"((?:[^"\\]|\\.)*)"(?:@[-A-Za-z0-9]+|\^\^<[^>]+>)?$/);
  if (!match) return value;
  return match[1]
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parseIntegerLiteral(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(stripLiteral(value) ?? '', 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
