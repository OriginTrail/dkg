import {
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  ENTITY_PRED_ALT,
  contextGraphWorkspaceMetaGraphUri,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  deleteByPatternWithoutCount,
  invalidateSwmMaterializationWitness,
  tryReplaceGraphAtomically,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  canonicalizeGraphScopedSwmHeadRows,
  type GraphScopedSwmRecoveryDescriptor,
} from '../graph-scoped-swm-recovery.js';
import { insertWithOversizeGuard, type OversizeGuardHooks } from
  '../oversize-filter.js';
import { sharedMemoryOwnershipKeyFromGraph } from '../shared-memory-graphs.js';
import type { RecoveryExecutionAdmission } from './recovery-execution-guard.js';
import { canonicalQuadKey } from './quad-key.js';
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

/** Store policy and root-metadata cleanup owned by recovery apply. */
export interface SwmRecoveryMutationRuntimeV1 {
  readonly store: SwmRecoveryStore;
  readonly ensureContextGraph: (contextGraphId: string) => Promise<void>;
  readonly replaceMetaForRoots: (
    contextGraphId: string,
    roots: readonly { readonly entity: string }[],
    metaGraphs: readonly string[],
  ) => Promise<void>;
}

/**
 * Bind the production storage policy used by recovery plans. Target
 * orchestration receives this cohesive apply runtime instead of owning query,
 * cleanup, oversize, cache-invalidation, and atomic-replace mechanics itself.
 */
export function createSwmRecoveryMutationRuntimeV1(params: Readonly<{
  store: TripleStore;
  recordDrops: OversizeGuardHooks['recordDrops'];
  invalidateListContextGraphsCache: () => void;
  markMetaProjectionDirty: (quads: Quad[]) => void;
}>): SwmRecoveryMutationRuntimeV1 {
  const graphManager = new GraphManager(params.store);
  const store: SwmRecoveryStore = {
    insert: async (quads) => {
      const inserted = await insertWithOversizeGuard(
        (kept) => params.store.insert(kept, {
          priority: 'background',
          source: 'agent.swmRecovery.insert',
        }),
        quads,
        { recordDrops: params.recordDrops },
        'swm-recovery',
      );
      if (inserted.length > 0) {
        params.invalidateListContextGraphsCache();
        params.markMetaProjectionDirty(inserted);
      }
    },
    replaceGraph: async (graph, quads) => {
      const replaced = await tryReplaceGraphAtomically(
        params.store,
        graph,
        quads,
        {
          priority: 'background',
          source: 'agent.swmRecovery.graphScopedReplace',
        },
      );
      if (!replaced) {
        throw Object.assign(
          new Error('Graph-scoped SWM recovery requires atomic TripleStore.replaceGraph() support'),
          { code: 'SWM_ATOMIC_REPLACE_UNSUPPORTED' },
        );
      }
      params.invalidateListContextGraphsCache();
    },
    deleteByPattern: (pattern) => params.store.deleteByPattern(pattern, {
      priority: 'background',
      source: 'agent.swmRecovery.deleteByPattern',
    }),
    deleteBySubjectPrefix: (graph, prefix) => params.store.deleteBySubjectPrefix(
      graph,
      prefix,
      {
        priority: 'background',
        source: 'agent.swmRecovery.deleteBySubjectPrefix',
      },
    ),
  };

  return Object.freeze({
    store,
    ensureContextGraph: (contextGraphId: string) => (
      graphManager.ensureContextGraph(contextGraphId)
    ),
    replaceMetaForRoots: async (
      contextGraphId: string,
      roots: readonly { readonly entity: string }[],
      metaGraphs: readonly string[],
    ): Promise<void> => {
      const graphs = metaGraphs.length > 0
        ? metaGraphs
        : [contextGraphWorkspaceMetaGraphUri(contextGraphId)];
      const entities = [...new Set(roots.map(({ entity }) => entity))];
      for (const metaGraph of graphs) {
        for (const entity of entities) {
          const operations = await params.store.query(
            `SELECT DISTINCT ?op WHERE { GRAPH <${metaGraph}> { ?op ${ENTITY_PRED_ALT} <${entity}> } }`,
            {
              priority: 'background',
              source: 'agent.swmRecovery.replaceMetaForRoots.findOps',
            },
          );
          if (operations.type !== 'bindings') continue;
          for (const row of operations.bindings) {
            const operation = row['op'];
            if (!operation) continue;
            await params.store.delete(
              [
                {
                  subject: operation,
                  predicate: DKG_ROOT_ENTITY_LEGACY,
                  object: entity,
                  graph: metaGraph,
                },
                {
                  subject: operation,
                  predicate: DKG_ENTITY,
                  object: entity,
                  graph: metaGraph,
                },
              ],
              {
                priority: 'background',
                source: 'agent.swmRecovery.replaceMetaForRoots.deleteLinks',
              },
            );
            const remaining = await params.store.query(
              `SELECT (COUNT(DISTINCT ?r) AS ?c) WHERE { GRAPH <${metaGraph}> { <${operation}> ${ENTITY_PRED_ALT} ?r } }`,
              {
                priority: 'background',
                source: 'agent.swmRecovery.replaceMetaForRoots.countRoots',
              },
            );
            const raw = remaining.type === 'bindings'
              ? remaining.bindings[0]?.['c']
              : undefined;
            const count = raw
              ? Number.parseInt(String(raw).match(/\d+/u)?.[0] ?? '0', 10)
              : 0;
            if (count === 0) {
              await deleteByPatternWithoutCount(
                params.store,
                { graph: metaGraph, subject: operation },
                {
                  priority: 'background',
                  source: 'agent.swmRecovery.replaceMetaForRoots.deleteOp',
                },
              );
            }
          }
        }
      }
    },
  });
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

/** Primary verified inputs for one complete, retryable recovery apply. */
export interface VerifiedSwmRecoveryApplyPlanInput {
  readonly contextGraphId: string;
  readonly rootData: readonly Quad[];
  readonly roots: readonly (SwmRecoveryRoot & { readonly creator: string })[];
  readonly graphAssets: readonly VerifiedSwmRecoveryGraphApply[];
  readonly verifiedMeta: readonly Quad[];
}

const VERIFIED_SWM_RECOVERY_APPLY_PLAN = Symbol('verified-swm-recovery-apply-plan');

/** Canonical immutable plan; only the builder can mint its private brand. */
export type VerifiedSwmRecoveryApplyPlan = Readonly<
  VerifiedSwmRecoveryApplyPlanInput & {
    readonly [VERIFIED_SWM_RECOVERY_APPLY_PLAN]: true;
  }
>;

/**
 * Canonicalize verified recovery inputs without accepting duplicated derived
 * projections. Metadata graphs and ownership partitions are derived by apply.
 */
export function createVerifiedSwmRecoveryApplyPlan(
  input: VerifiedSwmRecoveryApplyPlanInput,
): VerifiedSwmRecoveryApplyPlan {
  return Object.freeze({
    contextGraphId: input.contextGraphId,
    rootData: Object.freeze([...input.rootData]),
    roots: Object.freeze(
      input.roots.map((root) => Object.freeze({ ...root })),
    ),
    graphAssets: Object.freeze([...input.graphAssets]),
    verifiedMeta: Object.freeze([...input.verifiedMeta]),
    [VERIFIED_SWM_RECOVERY_APPLY_PLAN]: true as const,
  });
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
 * authoritative source. The delete/delete/insert sequence is intentionally
 * convergent rather than transactional: a rejected store call may leave an
 * earlier effect durable, and retrying the same verified input completes the
 * replacement safely. `verifiedData` is the FULL fetched state (all pages,
 * already verified + subject-validated upstream, so every subject is a listed
 * root or a skolemized child of one). `roots` is the set of root entities the
 * source provided (the sync verifier's `entityCreators`).
 */
export async function applySwmRecovery(params: {
  readonly store: SwmRecoveryStore;
  readonly verifiedData: readonly Quad[];
  readonly roots: readonly SwmRecoveryRoot[];
  readonly executionBoundary?: RecoveryExecutionAdmission;
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

  // Authority is checked once before the sequence starts. Revocation after
  // admission does not interrupt it, but a store failure can leave a partial
  // replacement; the delete/delete/insert sequence above is safe to retry.
  return params.executionBoundary?.admitAsyncMutation(apply) ?? apply();
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
 * Apply one fully verified recovery plan as a sequence of independently
 * durable, convergent steps. This is not a storage transaction: if a backend
 * rejects after committing a mutation, earlier effects are not rolled back.
 * Replaying the exact immutable plan resumes safely because context creation,
 * root/graph/meta replacement, RDF insertion and ownership initialization are
 * idempotent for the same verified input.
 *
 * Authority is checked exactly once before the sequence begins. Once admitted,
 * it drains without further lease checks so revocation cannot deliberately
 * strand a root between delete and insert; backend failures are recovered by
 * retrying the same plan.
 */
export async function applyVerifiedSwmRecoveryPlan(params: Readonly<{
  plan: VerifiedSwmRecoveryApplyPlan;
  ports: VerifiedSwmRecoveryApplyPorts;
  executionBoundary: RecoveryExecutionAdmission;
}>): Promise<VerifiedSwmRecoveryApplyResult> {
  const { plan, ports } = params;
  return params.executionBoundary.admitAsyncMutation(async () => {
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
      const rootMetaGraphs = [
        ...new Set(plan.verifiedMeta.map((quad) => quad.graph)),
      ];
      await ports.replaceMetaForRoots(plan.roots, rootMetaGraphs);
    }

    let insertedMetaQuads = 0;
    if (plan.verifiedMeta.length > 0) {
      const preservedHeadIdRowKeys = new Set(
        preservedWithholdRows.map(canonicalQuadKey),
      );
      const canonicalMeta = canonicalizeGraphScopedSwmHeadRows({
        metaQuads: plan.verifiedMeta,
        descriptors: plan.graphAssets.map(({ descriptor }) => descriptor),
      });
      const insertableMeta = preservedHeadIdRowKeys.size === 0
        ? canonicalMeta
        : canonicalMeta.filter(
          (quad) => !preservedHeadIdRowKeys.has(canonicalQuadKey(quad)),
        );
      if (insertableMeta.length > 0) {
        await ports.store.insert([...insertableMeta]);
      }
      insertedMetaQuads = insertableMeta.length;
    }

    for (const { dataGraph, entity, creator } of plan.roots) {
      const ownershipKey = sharedMemoryOwnershipKeyFromGraph(
        plan.contextGraphId,
        dataGraph,
      );
      if (ownershipKey === undefined) continue;
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
