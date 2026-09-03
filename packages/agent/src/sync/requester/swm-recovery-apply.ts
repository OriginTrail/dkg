import {
  deleteByPatternWithoutCount,
  invalidateSwmMaterializationWitness,
  type Quad,
} from '@origintrail-official/dkg-storage';
import {
  canonicalizeGraphScopedSwmHeadRows,
  type GraphScopedSwmRecoveryDescriptor,
} from '../graph-scoped-swm-recovery.js';
import type { RecoveryExecutionBoundary } from './recovery-execution-guard.js';
import type { SharedMemorySnapshotMaterializer } from './swm-snapshot-materializer.js';

/**
 * WS-0.0: per-root REPLACE apply for SWM recovery.
 *
 * The shared incremental sync path applies pulled rows via a blind additive
 * `storeInsert` ([shared-memory-sync.ts]) — a set-UNION of triples. That is
 * correct for cold-start (empty target) but **corrupts** recovery into a
 * non-empty store: recovering `status=v2` into a store that already holds
 * `status=v1` leaves BOTH on the subject (`{v1, v2}`), permanently, for any
 * single-valued property.
 *
 * Recovery instead must REPLACE per root: for each root the authoritative
 * source provides, drop the local root + its skolemized children in that graph,
 * then insert the source's rows. This mirrors the gossip apply path's per-root
 * delete-then-insert (workspace-handler.ts:1054-1063). Roots the source does
 * NOT provide are left untouched — recovery refreshes what the source has and
 * never deletes data the source merely lacks (no collateral loss).
 *
 * **Apply over the COMPLETE fetched current-state**, not per page: a root must
 * be cleared exactly once. Clearing per page would re-clear a root that spans a
 * page boundary and drop the rows inserted for it on the earlier page — turning
 * the fix back into corruption. Callers accumulate all pages, then apply once.
 */

/** The subset of the triple store this apply needs. */
export interface SwmRecoveryStore {
  insert(quads: Quad[]): Promise<unknown>;
  /** Atomic complete-graph replacement required by graph-scoped recovery. */
  replaceGraph(graph: string, quads: Quad[]): Promise<unknown>;
  deleteByPattern(pattern: { graph: string; subject: string }): Promise<unknown>;
  deleteBySubjectPrefix(graph: string, prefix: string): Promise<unknown>;
}

export interface SwmRecoveryRoot {
  /** The graph the root's rows live in (base SWM bucket or a per-KA bucket). */
  readonly dataGraph: string;
  /** The root entity (subject). Its skolemized children share the same graph. */
  readonly entity: string;
}

export interface SwmRecoveryApplyResult {
  readonly replacedRoots: number;
  readonly insertedQuads: number;
}

export type VerifiedSwmRecoveryGraphApply = Readonly<
  | {
    /** Content has not been written and must be replaced by this apply. */
    readonly kind: 'replace';
    readonly descriptor: GraphScopedSwmRecoveryDescriptor;
    readonly replacementQuads: readonly Quad[];
  }
  | {
    /** This invocation already committed the exact graph and its metadata. */
    readonly kind: 'already-replaced';
    readonly descriptor: GraphScopedSwmRecoveryDescriptor;
  }
  | {
    /** Exact content predates this invocation; retain an equivalent local id. */
    readonly kind: 'preserve-equivalent';
    readonly descriptor: GraphScopedSwmRecoveryDescriptor;
  }
>;

export interface VerifiedSwmRecoveryOwnershipUpdate {
  readonly ownershipKey: string;
  readonly entity: string;
  readonly creator: string;
}

/** Immutable, fully verified inputs for one complete recovery durability unit. */
export interface VerifiedSwmRecoveryApplyPlan {
  readonly contextGraphId: string;
  readonly rootData: readonly Quad[];
  readonly roots: readonly (SwmRecoveryRoot & { readonly creator: string })[];
  readonly graphAssets: readonly VerifiedSwmRecoveryGraphApply[];
  readonly verifiedMeta: readonly Quad[];
  readonly rootMetaGraphs: readonly string[];
  readonly ownershipUpdates: readonly VerifiedSwmRecoveryOwnershipUpdate[];
}

export interface VerifiedSwmRecoveryApplyResult {
  readonly replacedRoots: number;
  readonly replacedGraphs: number;
  readonly insertedRootQuads: number;
  readonly insertedGraphQuads: number;
  readonly insertedMetaQuads: number;
}

/** Every production effect required by a complete verified recovery apply. */
export interface VerifiedSwmRecoveryApplyPorts {
  readonly store: SwmRecoveryStore;
  readonly ensureContextGraph: (contextGraphId: string) => Promise<void>;
  readonly replaceMetaForRoots: (
    roots: readonly { readonly entity: string }[],
    metaGraphs: readonly string[],
  ) => Promise<void>;
  readonly replaceMetaForGraphAssets: (
    assets: readonly GraphScopedSwmRecoveryDescriptor[],
  ) => Promise<void>;
  readonly snapshotMaterializer: SharedMemorySnapshotMaterializer;
  readonly ensureOwnedMap: (ownershipKey: string) => Map<string, string>;
}

export interface VerifiedSwmRecoveryGraphAssetApplyResult {
  readonly insertedGraphQuads: number;
  readonly withholdRows: readonly Quad[];
}

const SKOLEM_CHILD_INFIX = '/.well-known/genid/';

/**
 * Replace-apply the verified current state of a CG's `_shared_memory` from an
 * authoritative source. `verifiedData` is the FULL fetched state (all pages,
 * already verified + subject-validated upstream, so every subject is a listed
 * root or a skolemized child of one). `roots` is the set of root entities the
 * source provided (the sync verifier's `entityCreators`).
 */
export async function applySwmRecovery(params: {
  readonly store: SwmRecoveryStore;
  readonly verifiedData: readonly Quad[];
  readonly roots: readonly SwmRecoveryRoot[];
  readonly executionBoundary?: RecoveryExecutionBoundary;
}): Promise<SwmRecoveryApplyResult> {
  const apply = async (): Promise<SwmRecoveryApplyResult> => {
    // Clear each (graph, root) exactly once — root rows + its skolemized children.
    const cleared = new Set<string>();
    for (const { dataGraph, entity } of params.roots) {
      const key = `${dataGraph}\u0000${entity}`;
      if (cleared.has(key)) continue;
      cleared.add(key);
      await deleteByPatternWithoutCount(
        params.store,
        { graph: dataGraph, subject: entity },
      );
      await params.store.deleteBySubjectPrefix(
        dataGraph,
        `${entity}${SKOLEM_CHILD_INFIX}`,
      );
    }

    if (params.verifiedData.length > 0) {
      await params.store.insert([...params.verifiedData]);
    }

    return { replacedRoots: cleared.size, insertedQuads: params.verifiedData.length };
  };

  // One per-recovery durability unit. If authority is revoked before this
  // point nothing mutates; if it is revoked after the first delete, the whole
  // root set still reaches its insert instead of being stranded half-applied.
  return params.executionBoundary?.commitAsync(apply) ?? apply();
}

function quadKey(quad: Quad): string {
  return `${quad.graph}\u0000${quad.subject}\u0000${quad.predicate}\u0000${quad.object}`;
}

/**
 * Canonical exact-asset mutation primitive shared by incremental snapshot
 * commits and the final recovery plan. It owns graph replacement, witness
 * invalidation, stored-identity preservation, and active-head cleanup.
 */
export async function applyVerifiedSwmRecoveryGraphAsset(params: Readonly<{
  contextGraphId: string;
  asset: VerifiedSwmRecoveryGraphApply;
  ports: Pick<
    VerifiedSwmRecoveryApplyPorts,
    'store' | 'replaceMetaForGraphAssets' | 'snapshotMaterializer'
  >;
}>): Promise<VerifiedSwmRecoveryGraphAssetApplyResult> {
  const { asset, ports } = params;
  if (asset.kind === 'replace') {
    await ports.store.replaceGraph(
      asset.descriptor.assertionGraph,
      [...asset.replacementQuads],
    );
    await invalidateSwmMaterializationWitness(
      ports.store,
      asset.descriptor.assertionGraph,
      { source: 'agent.swmRecovery.witnessInvalidate' },
    ).catch(() => {});
  }

  if (asset.kind === 'preserve-equivalent') {
    const preservation = await ports.snapshotMaterializer
      .preserveStoredIdentityForSkippedAsset(
        params.contextGraphId,
        asset.descriptor,
      );
    if (preservation.outcome === 'preserved') {
      return {
        insertedGraphQuads: asset.descriptor.publicQuadsCount,
        withholdRows: preservation.withholdRows,
      };
    }
  }

  await ports.replaceMetaForGraphAssets([asset.descriptor]);
  return {
    insertedGraphQuads: asset.kind === 'replace'
      ? asset.replacementQuads.length
      : asset.descriptor.publicQuadsCount,
    withholdRows: [],
  };
}

/**
 * Own the complete verified recovery write transaction. Fetching,
 * verification and plan construction happen upstream; every related root,
 * graph, metadata and ownership mutation is admitted exactly once here.
 */
export async function applyVerifiedSwmRecoveryPlan(params: Readonly<{
  plan: VerifiedSwmRecoveryApplyPlan;
  ports: VerifiedSwmRecoveryApplyPorts;
  executionBoundary: RecoveryExecutionBoundary;
}>): Promise<VerifiedSwmRecoveryApplyResult> {
  const { plan, ports } = params;
  return params.executionBoundary.commitAsync(async () => {
    await ports.ensureContextGraph(plan.contextGraphId);

    const roots = await applySwmRecovery({
      store: ports.store,
      verifiedData: plan.rootData,
      roots: plan.roots,
    });

    let replacedGraphs = 0;
    let insertedGraphQuads = 0;
    const preservedWithholdRows: Quad[] = [];
    for (const asset of plan.graphAssets) {
      replacedGraphs += 1;
      const applied = await applyVerifiedSwmRecoveryGraphAsset({
        contextGraphId: plan.contextGraphId,
        asset,
        ports,
      });
      insertedGraphQuads += applied.insertedGraphQuads;
      preservedWithholdRows.push(...applied.withholdRows);
    }

    if (plan.roots.length > 0) {
      await ports.replaceMetaForRoots(plan.roots, plan.rootMetaGraphs);
    }

    let insertedMetaQuads = 0;
    if (plan.verifiedMeta.length > 0) {
      const preservedHeadIdRowKeys = new Set(preservedWithholdRows.map(quadKey));
      const canonicalMeta = canonicalizeGraphScopedSwmHeadRows({
        metaQuads: plan.verifiedMeta,
        descriptors: plan.graphAssets.map(({ descriptor }) => descriptor),
      });
      const insertableMeta = preservedHeadIdRowKeys.size === 0
        ? canonicalMeta
        : canonicalMeta.filter((quad) => !preservedHeadIdRowKeys.has(quadKey(quad)));
      if (insertableMeta.length > 0) {
        await ports.store.insert([...insertableMeta]);
      }
      insertedMetaQuads = insertableMeta.length;
    }

    for (const { ownershipKey, entity, creator } of plan.ownershipUpdates) {
      const ownedMap = ports.ensureOwnedMap(ownershipKey);
      if (!ownedMap.has(entity)) ownedMap.set(entity, creator);
    }

    return {
      replacedRoots: roots.replacedRoots,
      replacedGraphs,
      insertedRootQuads: roots.insertedQuads,
      insertedGraphQuads,
      insertedMetaQuads,
    };
  });
}
