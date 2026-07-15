import type { Quad } from '@origintrail-official/dkg-storage';

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
}): Promise<SwmRecoveryApplyResult> {
  // Clear each (graph, root) exactly once — root rows + its skolemized children.
  const cleared = new Set<string>();
  for (const { dataGraph, entity } of params.roots) {
    const key = `${dataGraph}\u0000${entity}`;
    if (cleared.has(key)) continue;
    cleared.add(key);
    await params.store.deleteByPattern({ graph: dataGraph, subject: entity });
    await params.store.deleteBySubjectPrefix(dataGraph, `${entity}${SKOLEM_CHILD_INFIX}`);
  }

  if (params.verifiedData.length > 0) {
    await params.store.insert([...params.verifiedData]);
  }

  return { replacedRoots: cleared.size, insertedQuads: params.verifiedData.length };
}
