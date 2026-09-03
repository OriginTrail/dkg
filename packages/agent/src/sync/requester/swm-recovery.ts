import type { Quad } from '@origintrail-official/dkg-storage';
import {
  withKeyedLocks,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { SyncPageFetchOptions, SyncPageResult } from './page-fetch.js';
import type { SyncPhase } from '../auth/request-build.js';
import {
  applyVerifiedSwmRecoveryPlan,
  applyVerifiedSwmRecoveryGraphAsset,
  type SwmRecoveryStore,
  type VerifiedSwmRecoveryApplyPlan,
} from './swm-recovery-apply.js';
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
import type { SharedMemorySnapshotMaterializer } from './swm-snapshot-materializer.js';
import {
  createRecoveryExecutionBoundary,
  type RecoveryExecutionBoundary,
  type RecoveryExecutionGuard,
} from './recovery-execution-guard.js';

/**
 * recovery entry point. Recovers a CG's
 * `_shared_memory` current state from a single authoritative peer (a member or
 * a designated anchor), applying via REPLACE rather than the shared incremental
 * sync path's blind union (which corrupts a non-empty store — see
 * {@link applyVerifiedSwmRecoveryPlan}).
 *
 * It fetches the COMPLETE metadata state across pages, verifies it, then uses
 * the narrowest safe recovery path:
 *
 * - graph-scoped KAs backed by immutable public snapshots are fetched and
 *   verified one KA at a time, without scanning the aggregate SWM data graph;
 * - legacy root-scoped KAs and graph-backed legacy snapshots retain the full
 *   data-phase recovery below.
 *
 * A partial legacy-root fetch (deadline) is NOT safe to apply. Pagination is
 * row-based, so a root's rows can straddle the last fetched page; replacing it
 * with that prefix would truncate the entity. Legacy recovery therefore stays
 * all-or-nothing and restarts from offset zero after a partial response.
 *
 * Exact rootless KAs are different: each immutable snapshot carries its own
 * signed count and digest. A complete verified KA can be atomically
 * materialized immediately while the next KA is still downloading. An
 * incomplete snapshot remains invisible and is retried from zero.
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
    options?: SyncPageFetchOptions,
  ) => Promise<SyncPageResult>;
  /** Current-authority capability for selected recovery; ordinary recovery omits it. */
  readonly recoveryGuard?: RecoveryExecutionGuard;
  readonly processSharedMemoryBatch: (
    wsDataQuads: Quad[],
    wsMetaQuads: Quad[],
    contextGraphId: string,
    registeredSubGraphNames?: readonly string[],
    excludedSubGraphNames?: readonly string[],
  ) => Promise<ProcessedSwmBatch>;
  /**
   * Agent-owned lock domain shared by every authoritative recovery caller.
   * One complete provider transaction for a Context Graph must finish before
   * another provider can fetch/apply a competing head for that same graph.
   */
  readonly writeLocks: Map<string, Promise<void>>;
  readonly store: SwmRecoveryStore;
  readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  /**
   * REPLACE (not append) the SWM meta for each recovered root, BEFORE the fresh
   * `verifiedMeta` is inserted. Recovery REPLACEs the root DATA, but
   * without also replacing the meta an older `WorkspaceOperation`/`rootEntity`
   * row for the same root lingers in `_shared_memory_meta`; the TTL sweep then
   * deletes data for that expired op and can wipe the freshly-recovered root
   * (Codex high). Mirrors the share/gossip apply path's per-root meta
   * replacement (`deleteMetaForRoot`). This port is mandatory so recovery
   * cannot silently apply data without retiring stale root metadata.
   */
  readonly replaceMetaForRoots: (
    roots: readonly { readonly entity: string }[],
    metaGraphs: readonly string[],
  ) => Promise<void>;
  /** Replace the active head/operation rows for each exact graph asset. */
  readonly replaceMetaForGraphAssets: (
    assets: readonly GraphScopedSwmRecoveryDescriptor[],
  ) => Promise<void>;
  /**
   * GH#2273 — skipping an already-materialized KA and deciding whether its
   * stored operation identity may be preserved are ONE capability, and the
   * materializer OWNS both halves (`isGraphAssetMaterialized` +
   * `preserveStoredIdentityForSkippedAsset`) over one store and one lock
   * map — a config that could skip but not decide, or pair a predicate from
   * one store with a materializer over another, is unrepresentable.
   */
  readonly snapshotMaterializer: SharedMemorySnapshotMaterializer;
  readonly ensureContextGraph: (contextGraphId: string) => Promise<void>;
  readonly setCheckpoint: (key: string, offset: number) => void;
  readonly deleteCheckpoint: (key: string) => void;
  readonly getRegisteredSubGraphNames?: (contextGraphId: string) => Promise<readonly string[]>;
  readonly getExcludedSubGraphNames?: (contextGraphId: string) => Promise<readonly string[]>;
  /**
   * Rule-4 ownership cache hydrator (parity with `runSharedMemorySync`). Without
   * it, a recovered member holds correct triples but an empty ownership map and
   * mis-arbitrates its NEXT contended write. This port is therefore mandatory.
   */
  readonly ensureOwnedMap: (ownershipKey: string) => Map<string, string>;
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
  boundary: RecoveryExecutionBoundary,
  phase: RecoverableSyncPhase,
  graphUri: string,
): Promise<{ quads: Quad[]; completed: boolean }> {
  const maxPages = deps.maxPagesPerPhase ?? DEFAULT_MAX_PAGES_PER_PHASE;
  const all: Quad[] = [];
  let lastCheckpointKey: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await boundary.read(() => deps.fetchSyncPages(
      deps.ctx,
      deps.remotePeerId,
      deps.contextGraphId,
      true,
      phase,
      graphUri,
      deps.deadline,
      { signal: boundary.signal },
    ));
    appendInPlace(all, page.quads);
    lastCheckpointKey = page.checkpointKey;
    if (page.completed) {
      boundary.commitSync(() => deps.deleteCheckpoint(page.checkpointKey));
      return { quads: all, completed: true };
    }
    // Not completed (deadline or partial). Stop if no forward progress.
    if (page.nextOffset <= page.resumedFromOffset) break;
    boundary.commitSync(() => deps.setCheckpoint(page.checkpointKey, page.nextOffset));
  }
  // Incomplete: the accumulated `all` is a prefix that the caller MUST NOT
  // apply (a tail root may be truncated mid-stream). `all` is local to this
  // call and never reused, so drop any persisted mid-stream cursor — recovery
  // has no cross-invocation accumulator, so the retry must restart from
  // offset 0 (which makes the responder re-read from the start of its row
  // list) and rebuild the COMPLETE state before the apply gate can pass.
  if (lastCheckpointKey !== undefined) {
    boundary.commitSync(() => deps.deleteCheckpoint(lastCheckpointKey!));
  }
  return { quads: all, completed: false };
}

export async function recoverContextGraphSwm(
  deps: RecoverContextGraphSwmDeps,
): Promise<RecoverContextGraphSwmResult> {
  const boundary = createRecoveryExecutionBoundary(deps.recoveryGuard);
  boundary.assertCurrent();
  return withKeyedLocks(
    deps.writeLocks,
    [contextGraphSwmRecoveryWriteLockKey(deps.contextGraphId)],
    () => recoverContextGraphSwmUnlocked(deps, boundary),
  );
}

/**
 * Recovery-level lock key. Per-KA materialization keeps using the canonical
 * publisher lock, while this coarser key elects exactly one authoritative
 * provider transaction for a Context Graph at a time.
 */
export function contextGraphSwmRecoveryWriteLockKey(contextGraphId: string): string {
  return `${contextGraphId}\u0000swm-recovery`;
}

async function recoverContextGraphSwmUnlocked(
  deps: RecoverContextGraphSwmDeps,
  boundary: RecoveryExecutionBoundary,
): Promise<RecoverContextGraphSwmResult> {
  boundary.assertCurrent();
  const wsGraph = contextGraphWorkspaceGraphUri(deps.contextGraphId);
  const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(deps.contextGraphId);

  // Metadata is the recovery plan: it identifies both legacy roots and exact
  // graph-scoped assets. Fetch it before deciding whether an aggregate SWM data
  // scan is necessary.
  const meta = await fetchPhaseFully(deps, boundary, 'meta', wsMetaGraph);
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
    ? await boundary.read(() => deps.getRegisteredSubGraphNames!(deps.contextGraphId))
    : undefined;
  const excluded = deps.getExcludedSubGraphNames
    ? await boundary.read(() => deps.getExcludedSubGraphNames!(deps.contextGraphId))
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
  const metadataOnlyProcessed = await boundary.read(() => deps.processSharedMemoryBatch(
    [], meta.quads, deps.contextGraphId, recoveryRegistered, excluded,
  ));
  const hasLegacyRoots = metadataOnlyProcessed.entityCreators.length > 0;
  const hasGraphBackedSnapshots = graphScopedDescriptors.some(
    (descriptor) => descriptor.publicSnapshotGraph !== undefined,
  );
  let snapshotProgress = { readySnapshots: 0, totalSnapshots: 0 };
  const incrementallyReadyGraphs = new Set<string>();
  /** Graph keys whose ASSERTION GRAPH was actually (re)written this run. */
  const rewrittenGraphKeys = new Set<string>();
  let incrementallyReplacedGraphs = 0;
  let incrementallyInsertedDataQuads = 0;
  let incrementallyInsertedMetaQuads = 0;

  const snapshotDescriptorsByRef = new Map<string, GraphScopedSwmRecoveryDescriptor[]>();
  for (const descriptor of graphScopedDescriptors) {
    if (!descriptor.publicSnapshotRef) continue;
    const descriptors = snapshotDescriptorsByRef.get(descriptor.publicSnapshotRef) ?? [];
    descriptors.push(descriptor);
    snapshotDescriptorsByRef.set(descriptor.publicSnapshotRef, descriptors);
  }
  const quadKey = (quad: Quad): string =>
    `${quad.graph}\u0000${quad.subject}\u0000${quad.predicate}\u0000${quad.object}`;
  const verifiedMetaKeys = new Set(metadataOnlyProcessed.verifiedMeta.map(quadKey));
  let contextGraphEnsured = false;

  const materializeReadySnapshot = async (snapshotRef: string): Promise<void> => {
    for (const descriptor of snapshotDescriptorsByRef.get(snapshotRef) ?? []) {
      const graphKey = `${descriptor.metaGraph}\u0000${descriptor.assertionGraph}`;
      if (incrementallyReadyGraphs.has(graphKey)) continue;
      if (await boundary.read(() => (
        deps.snapshotMaterializer.isGraphAssetMaterialized(descriptor)
      ))) {
        incrementallyReadyGraphs.add(graphKey);
        continue;
      }

      const verifiedAssetMeta = descriptor.metadataQuads.filter((quad) => verifiedMetaKeys.has(quadKey(quad)));
      if (verifiedAssetMeta.length !== descriptor.metadataQuads.length) {
        throw new Error(`Verified SWM metadata is incomplete for ${descriptor.kaUal}`);
      }
      const asset = await boundary.read(() => materializeGraphScopedSwmRecoveryAsset({
        descriptor,
        fetchedDataQuads: [],
        publicSnapshotStore: deps.publicSnapshotStore,
      }));
      // One graph+metadata durability unit. A lease revoked before admission
      // prevents every mutation; one revoked after replacement starts cannot
      // interrupt the related witness/meta writes and strand a torn asset.
      await boundary.commitAsync(async () => {
        if (!contextGraphEnsured) {
          await deps.ensureContextGraph(deps.contextGraphId);
          contextGraphEnsured = true;
        }
        await applyVerifiedSwmRecoveryGraphAsset({
          contextGraphId: deps.contextGraphId,
          asset: {
            kind: 'replace',
            descriptor,
            replacementQuads: asset.quads,
          },
          ports: {
            store: deps.store,
            replaceMetaForGraphAssets: deps.replaceMetaForGraphAssets,
            snapshotMaterializer: deps.snapshotMaterializer,
          },
        });
        if (verifiedAssetMeta.length > 0) {
          await deps.store.insert([...verifiedAssetMeta]);
        }
      });
      incrementallyReadyGraphs.add(graphKey);
      rewrittenGraphKeys.add(graphKey);
      incrementallyReplacedGraphs += 1;
      incrementallyInsertedDataQuads += asset.quads.length;
      incrementallyInsertedMetaQuads += verifiedAssetMeta.length;
      deps.logInfo?.(
        deps.ctx,
        `SWM recovery for "${deps.contextGraphId}": committed verified snapshot ${snapshotRef} ` +
        `as ${descriptor.assertionGraph} (${asset.quads.length} triples)`,
      );
    }
  };

  // Fetch store-backed snapshots before any aggregate data scan. Each completed
  // snapshot is persisted independently, so a deadline can make monotonic
  // progress across retries while memory remains bounded to one KA rather than
  // the complete context graph.
  if (graphScopedDescriptors.length > 0) {
    const activeGraphMeta = graphScopedDescriptors.flatMap((descriptor) => [
      ...descriptor.metadataQuads,
    ]);
    boundary.assertCurrent();
    const snapshotSync = await syncPublicSnapshotsForMeta({
      ctx: deps.ctx,
      remotePeerId: deps.remotePeerId,
      contextGraphId: deps.contextGraphId,
      deadline: deps.deadline,
      metaQuads: activeGraphMeta,
      publicSnapshotStore: deps.publicSnapshotStore,
      fetchSyncPages: (
        ctx,
        remotePeerId,
        contextGraphId,
        includeSharedMemory,
        phase,
        graphUri,
        deadline,
        options,
      ) => deps.fetchSyncPages(
        ctx,
        remotePeerId,
        contextGraphId,
        includeSharedMemory,
        phase,
        graphUri,
        deadline,
        {
          ...options,
          signal: boundary.signal,
        },
      ),
      deleteCheckpoint: (key) => boundary.commitSync(() => deps.deleteCheckpoint(key)),
      setCheckpoint: (key, offset) => boundary.commitSync(() => deps.setCheckpoint(key, offset)),
      executionBoundary: boundary,
      onSnapshotReady: (snapshot) => materializeReadySnapshot(snapshot.ref),
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
        replacedGraphs: incrementallyReplacedGraphs,
        insertedDataQuads: incrementallyInsertedDataQuads,
        insertedMetaQuads: incrementallyInsertedMetaQuads,
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
    ? await fetchPhaseFully(deps, boundary, 'data', wsGraph)
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
      replacedGraphs: incrementallyReplacedGraphs,
      insertedDataQuads: incrementallyInsertedDataQuads,
      insertedMetaQuads: incrementallyInsertedMetaQuads,
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
    ? await boundary.read(() => deps.processSharedMemoryBatch(
      legacyDataQuads, meta.quads, deps.contextGraphId, recoveryRegistered, excluded,
    ))
    : metadataOnlyProcessed;

  const graphAssets: VerifiedSwmRecoveryApplyPlan['graphAssets'][number][] = [];
  for (const descriptor of graphScopedDescriptors) {
    const graphKey = `${descriptor.metaGraph}\u0000${descriptor.assertionGraph}`;
    if (incrementallyReadyGraphs.has(graphKey)) {
      graphAssets.push(Object.freeze({
        descriptor,
        kind: rewrittenGraphKeys.has(graphKey)
          ? 'already-replaced'
          : 'preserve-equivalent',
      }));
      continue;
    }
    const asset = await boundary.read(() => materializeGraphScopedSwmRecoveryAsset({
      descriptor,
      fetchedDataQuads: data.quads,
      publicSnapshotStore: deps.publicSnapshotStore,
    }));
    graphAssets.push(Object.freeze({
      kind: 'replace',
      descriptor,
      replacementQuads: Object.freeze([...asset.quads]),
    }));
  }

  const ownershipUpdates = processed.entityCreators.flatMap(
    ({ dataGraph, entity, creator }) => {
      const ownershipKey = sharedMemoryOwnershipKeyFromGraph(
        deps.contextGraphId,
        dataGraph,
      );
      return ownershipKey
        ? [Object.freeze({ ownershipKey, entity, creator })]
        : [];
    },
  );
  const applyPlan: VerifiedSwmRecoveryApplyPlan = Object.freeze({
    contextGraphId: deps.contextGraphId,
    rootData: Object.freeze(processed.verifiedData),
    roots: Object.freeze(
      processed.entityCreators.map((root) => Object.freeze({ ...root })),
    ),
    graphAssets: Object.freeze(graphAssets),
    verifiedMeta: Object.freeze(processed.verifiedMeta),
    rootMetaGraphs: Object.freeze([
      ...new Set(processed.verifiedMeta.map((quad) => quad.graph)),
    ]),
    ownershipUpdates: Object.freeze(ownershipUpdates),
  });
  const applied = await applyVerifiedSwmRecoveryPlan({
    plan: applyPlan,
    executionBoundary: boundary,
    ports: {
      store: deps.store,
      ensureContextGraph: deps.ensureContextGraph,
      replaceMetaForRoots: deps.replaceMetaForRoots,
      replaceMetaForGraphAssets: deps.replaceMetaForGraphAssets,
      snapshotMaterializer: deps.snapshotMaterializer,
      ensureOwnedMap: deps.ensureOwnedMap,
    },
  });
  // The admitted durability unit must drain after revocation, but a stale
  // invocation must never be accounted as a completed recovery target.
  boundary.assertCurrent();

  if (processed.droppedDataTriples > 0) {
    deps.logWarn?.(deps.ctx, `SWM recovery for "${deps.contextGraphId}" dropped ${processed.droppedDataTriples} triples with invalid subjects`);
  }
  // Reaching here means both phases completed (the partial path returned above).
  deps.logInfo?.(
    deps.ctx,
    `SWM recovery for "${deps.contextGraphId}" from ${deps.remotePeerId}: replaced ${applied.replacedRoots} roots, ` +
    `${applied.replacedGraphs} exact graphs, ` +
    `${applied.insertedRootQuads + applied.insertedGraphQuads} data + ` +
    `${applied.insertedMetaQuads} meta triples`,
  );

  return {
    replacedRoots: applied.replacedRoots,
    replacedGraphs: applied.replacedGraphs,
    insertedDataQuads: applied.insertedRootQuads + applied.insertedGraphQuads,
    insertedMetaQuads: applied.insertedMetaQuads,
    droppedDataTriples: processed.droppedDataTriples,
    ...snapshotProgress,
    completed: true,
  };
}
