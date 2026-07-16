import type { Quad } from '@origintrail-official/dkg-storage';
import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { SyncPageResult } from './page-fetch.js';
import type { SyncPhase } from '../auth/request-build.js';
import { applySwmRecovery, type SwmRecoveryStore } from './swm-recovery-apply.js';
import {
  sharedMemoryOwnershipKeyFromGraph,
  syncPublicSnapshotsForMeta,
} from './shared-memory-sync.js';
import { appendInPlace } from '../append-in-place.js';
import {
  discoverSwmRecoverySubGraphNames,
  materializeGraphScopedSwmRecoveryAsset,
  parseGraphScopedSwmRecoveryDescriptors,
  type GraphScopedSwmRecoveryDescriptor,
} from '../graph-scoped-swm-recovery.js';

/**
 * recovery entry point. Recovers a CG's
 * `_shared_memory` current state from a single authoritative peer (a member or
 * a designated anchor), applying via REPLACE rather than the shared incremental
 * sync path's blind union (which corrupts a non-empty store — see
 * {@link applySwmRecovery}).
 *
 * It fetches the COMPLETE metadata state across pages, verifies it, then uses
 * the narrowest safe recovery path:
 *
 * - graph-scoped KAs backed by immutable public snapshots are fetched and
 *   verified one KA at a time, without scanning the aggregate SWM data graph;
 * - legacy root-scoped KAs and graph-backed legacy snapshots retain the full
 *   data-phase recovery below.
 *
 * A partial fetch (deadline) is NOT safe to apply, and is deliberately NOT
 * applied. Pagination is row-based, so a single root's rows (the root + its
 * skolemized children + every predicate) can straddle the last fetched page: a
 * deadline can cut a root mid-stream. REPLACE-ing such a root would clear it and
 * reinsert only the fetched prefix, truncating the entity until a later retry —
 * the same corruption the per-root REPLACE exists to prevent. So recovery is
 * all-or-nothing: we apply ONLY when BOTH phases fetched to completion; on a
 * partial fetch we mutate the store not at all, drop the mid-stream checkpoint
 * so the retry re-accumulates from offset 0, and return `completed: false` for
 * the caller to retry. (Per-root completeness is not cheaply recoverable here —
 * `entityCreators` is a set derived from possibly-truncated rows, so the
 * truncated tail root can't be singled out; all-or-nothing is the correct gate.)
 *
 * This is deliberately separate from `runSharedMemorySync` so the shared
 * incremental path (cold-start / public / top-up, where union is correct) is
 * untouched.
 */

type RecoverableSyncPhase = 'data' | 'meta';

interface ProcessedSwmBatch {
  readonly verifiedData: Quad[];
  readonly verifiedMeta: Quad[];
  readonly entityCreators: Array<{ dataGraph: string; entity: string; creator: string }>;
  readonly droppedDataTriples: number;
}

export interface RecoverContextGraphSwmDeps {
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  /** Absolute wall-clock deadline (ms) for the whole recovery. */
  readonly deadline: number;
  readonly fetchSyncPages: (
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
    snapshotRef?: string,
  ) => Promise<SyncPageResult>;
  readonly processSharedMemoryBatch: (
    wsDataQuads: Quad[],
    wsMetaQuads: Quad[],
    contextGraphId: string,
    registeredSubGraphNames?: readonly string[],
    excludedSubGraphNames?: readonly string[],
  ) => Promise<ProcessedSwmBatch>;
  readonly store: SwmRecoveryStore;
  readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  /**
   * REPLACE (not append) the SWM meta for each recovered root, BEFORE the fresh
   * `verifiedMeta` is inserted. `applySwmRecovery` REPLACEs the root DATA, but
   * without also replacing the meta an older `WorkspaceOperation`/`rootEntity`
   * row for the same root lingers in `_shared_memory_meta`; the TTL sweep then
   * deletes data for that expired op and can wipe the freshly-recovered root
   * (Codex high). Mirrors the share/gossip apply path's per-root meta
   * replacement (`deleteMetaForRoot`). Production callers MUST pass it.
   */
  readonly replaceMetaForRoots?: (
    roots: readonly { readonly entity: string }[],
    metaGraphs: readonly string[],
  ) => Promise<void>;
  /** Replace the active head/operation rows for each exact graph asset. */
  readonly replaceMetaForGraphAssets?: (
    assets: readonly GraphScopedSwmRecoveryDescriptor[],
  ) => Promise<void>;
  readonly ensureContextGraph: (contextGraphId: string) => Promise<void>;
  readonly setCheckpoint: (key: string, offset: number) => void;
  readonly deleteCheckpoint: (key: string) => void;
  readonly getRegisteredSubGraphNames?: (contextGraphId: string) => Promise<readonly string[]>;
  readonly getExcludedSubGraphNames?: (contextGraphId: string) => Promise<readonly string[]>;
  /**
   * Rule-4 ownership cache hydrator (parity with `runSharedMemorySync`). Without
   * it, a recovered member holds correct triples but an empty ownership map and
   * mis-arbitrates its NEXT contended write — so production callers MUST pass it.
   */
  readonly ensureOwnedMap?: (ownershipKey: string) => Map<string, string>;
  readonly logInfo?: (ctx: OperationContext, message: string) => void;
  readonly logWarn?: (ctx: OperationContext, message: string) => void;
  /** Backstop against a misbehaving responder that never reports `completed`. */
  readonly maxPagesPerPhase?: number;
}

export interface RecoverContextGraphSwmResult {
  readonly replacedRoots: number;
  readonly replacedGraphs: number;
  readonly insertedDataQuads: number;
  readonly insertedMetaQuads: number;
  readonly droppedDataTriples: number;
  /** Verified immutable snapshot refs ready in the local cache after this round. */
  readonly readySnapshots: number;
  /** Total immutable snapshot refs declared by the recovered SWM metadata. */
  readonly totalSnapshots: number;
  /** false if a phase hit the deadline without completing — partial, safe to retry. */
  readonly completed: boolean;
}

export const DEFAULT_PRIVATE_SWM_RECOVERY_MAX_ROUNDS = 6;
export const ABSOLUTE_PRIVATE_SWM_RECOVERY_MAX_ROUNDS = 24;

/**
 * Repeat an authoritative private-SWM recovery while its immutable snapshot
 * cache is making monotonic progress. A single recovery round is deliberately
 * deadline-bounded; large rootless CGs can therefore finish several verified
 * KAs and time out before the final one. Treating that first timeout as a
 * terminal subscribe failure strands the safe cached progress until a later
 * reconnect/reconciler tick. This bounded driver consumes that progress in the
 * same catch-up job without weakening the all-or-nothing graph apply gate.
 *
 * One no-progress retry is allowed for a transient transport failure. Two
 * consecutive results with the same ready count stop the driver. For the
 * default policy, the first verified metadata response expands the six-round
 * floor to at most one round per declared immutable snapshot plus a two-round
 * transport cushion, bounded by an absolute ceiling. That lets a finite CG
 * finish when a lossy relay yields only one new verified snapshot per round,
 * without allowing an arbitrarily large CG to monopolise a worker. An explicit
 * `maxRounds` remains authoritative for callers and tests.
 */
export async function recoverContextGraphSwmWithProgressRetries(params: {
  readonly recover: () => Promise<RecoverContextGraphSwmResult>;
  readonly maxRounds?: number;
  readonly onRetry?: (progress: {
    readonly completedRound: number;
    readonly readySnapshots: number;
    readonly totalSnapshots: number;
  }) => void;
}): Promise<RecoverContextGraphSwmResult> {
  const explicitMaxRounds = params.maxRounds === undefined
    ? undefined
    : Math.max(1, Math.floor(params.maxRounds));
  let maxRounds = explicitMaxRounds ?? DEFAULT_PRIVATE_SWM_RECOVERY_MAX_ROUNDS;
  let previousReadySnapshots = -1;
  let consecutiveNoProgressRounds = 0;
  let result: RecoverContextGraphSwmResult | undefined;

  for (let round = 1; round <= maxRounds; round += 1) {
    result = await params.recover();
    if (result.completed) return result;

    if (explicitMaxRounds === undefined && Number.isSafeInteger(result.totalSnapshots)) {
      maxRounds = Math.min(
        ABSOLUTE_PRIVATE_SWM_RECOVERY_MAX_ROUNDS,
        Math.max(maxRounds, result.totalSnapshots + 2),
      );
    }

    const madeProgress = result.readySnapshots > previousReadySnapshots;
    consecutiveNoProgressRounds = madeProgress ? 0 : consecutiveNoProgressRounds + 1;
    if (round >= maxRounds || consecutiveNoProgressRounds >= 2) return result;

    previousReadySnapshots = result.readySnapshots;
    params.onRetry?.({
      completedRound: round,
      readySnapshots: result.readySnapshots,
      totalSnapshots: result.totalSnapshots,
    });
  }

  // The loop always executes at least once because maxRounds is clamped to 1.
  return result!;
}

const DEFAULT_MAX_PAGES_PER_PHASE = 1000;

async function fetchPhaseFully(
  deps: RecoverContextGraphSwmDeps,
  phase: RecoverableSyncPhase,
  graphUri: string,
): Promise<{ quads: Quad[]; completed: boolean }> {
  const maxPages = deps.maxPagesPerPhase ?? DEFAULT_MAX_PAGES_PER_PHASE;
  const all: Quad[] = [];
  let lastCheckpointKey: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await deps.fetchSyncPages(
      deps.ctx, deps.remotePeerId, deps.contextGraphId, true, phase, graphUri, deps.deadline,
    );
    appendInPlace(all, page.quads);
    lastCheckpointKey = page.checkpointKey;
    if (page.completed) {
      deps.deleteCheckpoint(page.checkpointKey);
      return { quads: all, completed: true };
    }
    // Not completed (deadline or partial). Stop if no forward progress.
    if (page.nextOffset <= page.resumedFromOffset) break;
    deps.setCheckpoint(page.checkpointKey, page.nextOffset);
  }
  // Incomplete: the accumulated `all` is a prefix that the caller MUST NOT
  // apply (a tail root may be truncated mid-stream). `all` is local to this
  // call and never reused, so drop any persisted mid-stream cursor — recovery
  // has no cross-invocation accumulator, so the retry must restart from
  // offset 0 (which makes the responder re-read from the start of its row
  // list) and rebuild the COMPLETE state before the apply gate can pass.
  if (lastCheckpointKey !== undefined) deps.deleteCheckpoint(lastCheckpointKey);
  return { quads: all, completed: false };
}

export async function recoverContextGraphSwm(
  deps: RecoverContextGraphSwmDeps,
): Promise<RecoverContextGraphSwmResult> {
  const wsGraph = contextGraphWorkspaceGraphUri(deps.contextGraphId);
  const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(deps.contextGraphId);

  // Metadata is the recovery plan: it identifies both legacy roots and exact
  // graph-scoped assets. Fetch it before deciding whether an aggregate SWM data
  // scan is necessary.
  const meta = await fetchPhaseFully(deps, 'meta', wsMetaGraph);
  if (!meta.completed) {
    deps.logInfo?.(
      deps.ctx,
      `SWM recovery for "${deps.contextGraphId}" from ${deps.remotePeerId}: ` +
      'partial metadata fetch — skipped, will retry',
    );
    return {
      replacedRoots: 0,
      replacedGraphs: 0,
      insertedDataQuads: 0,
      insertedMetaQuads: 0,
      droppedDataTriples: 0,
      readySnapshots: 0,
      totalSnapshots: 0,
      completed: false,
    };
  }

  const registered = deps.getRegisteredSubGraphNames
    ? await deps.getRegisteredSubGraphNames(deps.contextGraphId)
    : undefined;
  const excluded = deps.getExcludedSubGraphNames
    ? await deps.getExcludedSubGraphNames(deps.contextGraphId)
    : undefined;
  const recoveryRegistered = [
    ...new Set([
      ...(registered ?? []),
      ...discoverSwmRecoverySubGraphNames({
        contextGraphId: deps.contextGraphId,
        metaQuads: meta.quads,
        excludedSubGraphNames: excluded,
      }),
    ]),
  ];

  const graphScopedDescriptors = parseGraphScopedSwmRecoveryDescriptors({
    contextGraphId: deps.contextGraphId,
    metaQuads: meta.quads,
    registeredSubGraphNames: recoveryRegistered,
    excludedSubGraphNames: excluded,
  });

  // Classify legacy roots from metadata alone. The verifier does not need data
  // rows to derive entityCreators, and this lets a rootless-only CG avoid the
  // expensive aggregate `_shared_memory` query entirely. That query is both
  // redundant (the immutable snapshot is the canonical source for an exact
  // graph asset) and scales with every KA in the CG.
  const metadataOnlyProcessed = await deps.processSharedMemoryBatch(
    [], meta.quads, deps.contextGraphId, recoveryRegistered, excluded,
  );
  const hasLegacyRoots = metadataOnlyProcessed.entityCreators.length > 0;
  const hasGraphBackedSnapshots = graphScopedDescriptors.some(
    (descriptor) => descriptor.publicSnapshotGraph !== undefined,
  );
  let snapshotProgress = { readySnapshots: 0, totalSnapshots: 0 };

  // Fetch store-backed snapshots before any aggregate data scan. Each completed
  // snapshot is persisted independently, so a deadline can make monotonic
  // progress across retries while memory remains bounded to one KA rather than
  // the complete context graph.
  if (graphScopedDescriptors.length > 0) {
    const activeGraphMeta = graphScopedDescriptors.flatMap((descriptor) => [
      ...descriptor.metadataQuads,
    ]);
    const snapshotSync = await syncPublicSnapshotsForMeta({
      ctx: deps.ctx,
      remotePeerId: deps.remotePeerId,
      contextGraphId: deps.contextGraphId,
      deadline: deps.deadline,
      metaQuads: activeGraphMeta,
      publicSnapshotStore: deps.publicSnapshotStore,
      fetchSyncPages: deps.fetchSyncPages,
      deleteCheckpoint: deps.deleteCheckpoint,
      setCheckpoint: deps.setCheckpoint,
    });
    snapshotProgress = {
      readySnapshots: snapshotSync.readySnapshots,
      totalSnapshots: snapshotSync.totalSnapshots,
    };
    if (!snapshotSync.completed) {
      deps.logInfo?.(
        deps.ctx,
        `SWM recovery for "${deps.contextGraphId}" from ${deps.remotePeerId}: ` +
        'graph-scoped public snapshot fetch incomplete — skipped, will retry',
      );
      return {
        replacedRoots: 0,
        replacedGraphs: 0,
        insertedDataQuads: 0,
        insertedMetaQuads: 0,
        droppedDataTriples: 0,
        ...snapshotProgress,
        completed: false,
      };
    }
  }

  // Only legacy roots and old graph-backed snapshot rows require the aggregate
  // data phase. New rootless KAs use immutable snapshot refs and never enter
  // this path.
  const needsAggregateData = hasLegacyRoots || hasGraphBackedSnapshots;
  const data = needsAggregateData
    ? await fetchPhaseFully(deps, 'data', wsGraph)
    : { quads: [] as Quad[], completed: true };

  // Legacy row pagination can cut a root (or a graph-backed snapshot) in the
  // middle. Preserve the existing all-or-nothing gate for that compatibility
  // path; store-backed exact assets above do not depend on it.
  if (!data.completed) {
    deps.logInfo?.(
      deps.ctx,
      `SWM recovery for "${deps.contextGraphId}" from ${deps.remotePeerId}: ` +
      'partial legacy data fetch — skipped, will retry',
    );
    return {
      replacedRoots: 0,
      replacedGraphs: 0,
      insertedDataQuads: 0,
      insertedMetaQuads: 0,
      droppedDataTriples: 0,
      ...snapshotProgress,
      completed: false,
    };
  }

  // Rootless exact graphs and graph-backed immutable snapshots are verified
  // per KA below. Keep them out of the legacy rootEntity worker path so they
  // are not counted as invalid root subjects or inserted by union.
  const graphScopedTransportGraphs = new Set<string>();
  for (const descriptor of graphScopedDescriptors) {
    graphScopedTransportGraphs.add(descriptor.assertionGraph);
    if (descriptor.publicSnapshotGraph) {
      graphScopedTransportGraphs.add(descriptor.publicSnapshotGraph);
    }
  }
  const legacyDataQuads = data.quads.filter(
    (quad) => !graphScopedTransportGraphs.has(quad.graph),
  );

  const processed = needsAggregateData
    ? await deps.processSharedMemoryBatch(
      legacyDataQuads, meta.quads, deps.contextGraphId, recoveryRegistered, excluded,
    )
    : metadataOnlyProcessed;

  await deps.ensureContextGraph(deps.contextGraphId);

  // REPLACE per root (the recovery fix), applied over the COMPLETE fetched state.
  const applied = await applySwmRecovery({
    store: deps.store,
    verifiedData: processed.verifiedData,
    roots: processed.entityCreators,
  });
  let replacedGraphs = 0;
  let insertedGraphQuads = 0;
  for (const descriptor of graphScopedDescriptors) {
    const asset = await materializeGraphScopedSwmRecoveryAsset({
      descriptor,
      fetchedDataQuads: data.quads,
      publicSnapshotStore: deps.publicSnapshotStore,
    });
    await deps.store.replaceGraph(asset.assertionGraph, [...asset.quads]);
    replacedGraphs += 1;
    insertedGraphQuads += asset.quads.length;
  }
  // Codex high: REPLACE the SWM meta for each recovered root (the data was
  // REPLACEd above; the meta must be too). Otherwise a stale WorkspaceOperation
  // pointing at the root survives and the TTL sweep later deletes the
  // freshly-recovered root. Scope to the meta graphs the curator's fresh meta
  // populates (+ the caller's base fallback when empty). Runs BEFORE the insert.
  if (processed.entityCreators.length > 0) {
    const metaGraphs = [...new Set(processed.verifiedMeta.map((q) => q.graph))];
    await deps.replaceMetaForRoots?.(processed.entityCreators, metaGraphs);
  }
  if (graphScopedDescriptors.length > 0) {
    await deps.replaceMetaForGraphAssets?.(graphScopedDescriptors);
  }
  if (processed.verifiedMeta.length > 0) {
    await deps.store.insert([...processed.verifiedMeta]);
  }

  // R2 — hydrate the Rule-4 ownership cache for the recovered roots (parity with
  // runSharedMemorySync); otherwise the member's next contended write to a
  // recovered root is mis-arbitrated against an empty ownership map.
  if (deps.ensureOwnedMap) {
    for (const { dataGraph, entity, creator } of processed.entityCreators) {
      const ownershipKey = sharedMemoryOwnershipKeyFromGraph(deps.contextGraphId, dataGraph);
      if (!ownershipKey) continue;
      const ownedMap = deps.ensureOwnedMap(ownershipKey);
      if (!ownedMap.has(entity)) ownedMap.set(entity, creator);
    }
  }

  if (processed.droppedDataTriples > 0) {
    deps.logWarn?.(deps.ctx, `SWM recovery for "${deps.contextGraphId}" dropped ${processed.droppedDataTriples} triples with invalid subjects`);
  }
  // Reaching here means both phases completed (the partial path returned above).
  deps.logInfo?.(
    deps.ctx,
    `SWM recovery for "${deps.contextGraphId}" from ${deps.remotePeerId}: replaced ${applied.replacedRoots} roots, ` +
    `${replacedGraphs} exact graphs, ${applied.insertedQuads + insertedGraphQuads} data + ` +
    `${processed.verifiedMeta.length} meta triples`,
  );

  return {
    replacedRoots: applied.replacedRoots,
    replacedGraphs,
    insertedDataQuads: applied.insertedQuads + insertedGraphQuads,
    insertedMetaQuads: processed.verifiedMeta.length,
    droppedDataTriples: processed.droppedDataTriples,
    ...snapshotProgress,
    completed: true,
  };
}
