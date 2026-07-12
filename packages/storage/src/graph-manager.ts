import type { Quad, QueryOptions, TripleStore } from './triple-store.js';
import {
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  contextGraphSharedMemoryUri,
  contextGraphSharedMemoryMetaUri,
  contextGraphVerifiableMemoryUri,
  contextGraphVerifiableMemoryMetaUri,
  contextGraphAssertionUri,
  contextGraphSubGraphUri,
  contextGraphSubGraphMetaUri,
  contextGraphSubGraphPrivateUri,
  contextGraphCatalogUri,
  isSafeIri,
  assertSafeIri,
  sparqlString,
} from '@origintrail-official/dkg-core';

const CG_PREFIX = 'did:dkg:context-graph:';

export type NonEmptyGraphList = [string, ...string[]];
export type SharedMemoryReadSelection = 'all' | { rootEntities: readonly string[] };

/**
 * Per-KA identity window used to PRUNE the SWM under-graph read set to the
 * single author + kaNumber range a call site already knows it wants. The
 * `agentAddress`/`kaNumber` pair is the identifying half of a KA's UAL, so a
 * bound admits exactly the per-KA under-graphs
 * `…/_shared_memory/{addr}/{n}` (and the 5-segment sub-graph shape
 * `…/{sub}/_shared_memory/{addr}/{n}`) with `addr ≡ᵢ agentAddress` and
 * `startNumber ≤ n ≤ endNumber`.
 *
 * Both numbers are the LOW-96 per-author KA number, NOT a packed `kaId`
 * (`packKnowledgeAssetIdFromIdentity` shifts the address into the high bits) —
 * callers must unpack before deriving a bound, or every real graph is excluded.
 *
 * This is a PURE ACCELERATOR: it narrows a graph SET, never the CONSTRUCT body,
 * and non-parsing / bucket graphs are always kept (fail-open). Correctness of a
 * bounded read therefore reduces to "same graph set ⇒ same quads", and any call
 * site that narrows a merkle-gated read MUST widen to the unbounded read on an
 * empty-or-mismatch result before it defers.
 */
export interface SwmKaGraphBound {
  agentAddress: string;
  startNumber: bigint;
  endNumber: bigint;
}

const SWM_CHILD_AGENT_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SWM_CHILD_KA_NUMBER = /^\d+$/;

/**
 * Identify `graph` as a per-KA child of THIS shared-memory `bucketGraph`, or
 * return undefined so the caller keeps it (fail-open).
 *
 * Deliberately bucket-RELATIVE. The only shape a bound is allowed to prune is
 * exactly `${bucketGraph}/{0x…40hex}/{decimal}`, so we strip the bucket prefix and
 * require precisely those two segments. Every other suffix — `_meta`, blob and
 * snapshot graphs, and deeper descendants such as
 * `${bucketGraph}/_verifiable_memory/{addr}/{n}` — simply fails to match and stays
 * in the read set. Using the general `parseContextGraphLayerUri` here instead would
 * accept unrelated layer shapes and force reconstruction checks to rule them back
 * out; the relative parser makes the contract the code's shape rather than a
 * comment's claim. Works unchanged for a sub-graph bucket, since the prefix we
 * strip is whatever bucket the caller is reading.
 */
function parseBoundableSwmChildGraph(
  bucketGraph: string,
  graph: string,
): { agentAddress: string; kaNumber: bigint } | undefined {
  const prefix = `${bucketGraph}/`;
  if (!graph.startsWith(prefix)) return undefined;
  const segments = graph.slice(prefix.length).split('/');
  if (segments.length !== 2) return undefined;
  const [agentAddress, kaNumberRaw] = segments;
  if (!SWM_CHILD_AGENT_ADDRESS.test(agentAddress) || !SWM_CHILD_KA_NUMBER.test(kaNumberRaw)) {
    return undefined;
  }
  return { agentAddress, kaNumber: BigInt(kaNumberRaw) };
}

export interface LoadSelectedSharedMemoryQuadsOptions {
  querySource?: QueryOptions['source'];
  queryOptions?: QueryOptions;
  quadFilter?: (quad: Quad) => boolean;
  rootEntitiesErrorMessage?: (input: {
    inputCount: number;
    hadInput: boolean;
  }) => string;
}

export interface LoadSelectedVerifiableMemoryQuadsOptions {
  querySource?: QueryOptions['source'];
  queryOptions?: QueryOptions;
}

function mergeQueryOptions(
  options?: QueryOptions,
  source?: QueryOptions['source'],
): QueryOptions | undefined {
  if (!options && !source) return undefined;
  return {
    ...options,
    ...(source ? { source } : {}),
  };
}

async function listGraphsByPrefix(
  store: TripleStore,
  prefix: string,
  options?: QueryOptions,
): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix, options)
    : (await store.listGraphs(options)).filter((graph) => graph.startsWith(prefix));
}

/**
 * Resolve the concrete set of shared-memory graphs to READ under `bucketGraph`,
 * enumerated via the fast named-graph index (`listGraphsByPrefix`) instead of an
 * unbounded `GRAPH ?g` scan. This is the BOUND equivalent of
 * `sharedMemoryReadBothFilter` (core `constants.ts`): the bucket graph itself
 * PLUS every graph under `${bucketGraph}/` EXCEPT the `${bucketGraph}/staging/`
 * subtree — the exact same graph set that filter selects.
 *
 * Callers emit a `VALUES ?g { … }` clause from the result so the query engine
 * reads only these graphs, turning an O(store) whole-database scan (the
 * `GRAPH ?g { … } FILTER(STRSTARTS(?g,…))` idiom) into an O(matched-graphs)
 * read. This is the hot-path relief for storage-ACK / finalization SWM reads.
 *
 * Non-indexed stores fall back to a `listGraphs()` prefix scan (still correct,
 * just not index-accelerated). `assertSafeIri(bucketGraph)` throws on an unsafe
 * bucket to preserve the old `sharedMemoryReadBothFilter` fail-closed behavior
 * (the replaced filter asserted the same); per-KA under-graphs are dropped if
 * unsafe (never produced by the DKG write path). The returned list is always
 * non-empty for a safe bucket because the bucket graph itself is part of the
 * read contract, even when the named-graph index currently has no child graphs.
 *
 * Freshness contract: the index must be at least as fresh as the SPARQL scan it
 * replaces. Same-process writes satisfy this (GraphSetIndexStore is
 * write-through; the sparql-http adapter invalidates its listGraphs cache on
 * every local insert/delete/update/drop). The only staleness window is a graph
 * written by a DIFFERENT process to a SHARED oxigraph-server within the
 * revalidate interval; there an under-read is still FAIL-SAFE on merkle-gated
 * paths (recompute mismatch → reject/retry, never accept-with-wrong-data).
 *
 * This resolver is COMPLETE and therefore safe everywhere, including the
 * merkle-defining publish reads and the StorageACK decline lanes. Pruning lives in
 * `resolveKaBoundedSharedMemoryReadGraphs`, which is not part of the package's
 * public surface — read its contract before reaching for it.
 */
export async function resolveSharedMemoryReadGraphs(
  store: TripleStore,
  bucketGraph: string,
  options?: QueryOptions,
): Promise<NonEmptyGraphList> {
  return resolveSwmReadGraphs(store, bucketGraph, options, undefined);
}

/**
 * Resolve the SWM read set pruned to one author's per-KA under-graphs.
 *
 * UNSAFE ON ITS OWN, and deliberately NOT re-exported from `src/index.ts`: the
 * result is a STRICT SUBSET of the complete read set, and INV-1 is refuted under
 * root recurrence, so a bounded resolution can omit graphs the on-chain merkle root
 * commits to. Only `loadKaBoundedSharedMemoryQuads` may call this, and only because
 * its own caller (`FinalizationHandler.loadSwmSliceWithFallback`) owns the widen.
 * Never build a `VALUES ?g` from this and hash or decline on the result.
 *
 * Pruning is FAIL-OPEN: an under-graph is dropped ONLY when it is positively a
 * per-KA child of THIS bucket (`parseBoundableSwmChildGraph`) AND its author or
 * kaNumber falls outside the bound. Any other shape — `_meta`, blob, snapshot,
 * deeper descendants, anything future — is KEPT, so a bound can never silently
 * under-read a graph it does not understand. The bucket is always in the set.
 */
export async function resolveKaBoundedSharedMemoryReadGraphs(
  store: TripleStore,
  bucketGraph: string,
  bound: SwmKaGraphBound,
  options?: QueryOptions,
): Promise<NonEmptyGraphList> {
  return resolveSwmReadGraphs(store, bucketGraph, options, bound);
}

async function resolveSwmReadGraphs(
  store: TripleStore,
  bucketGraph: string,
  options: QueryOptions | undefined,
  bound: SwmKaGraphBound | undefined,
): Promise<NonEmptyGraphList> {
  assertSafeIri(bucketGraph);
  const stagingPrefix = `${bucketGraph}/staging/`;
  const under = await listGraphsByPrefix(store, `${bucketGraph}/`, options);
  const out = new Set<string>([bucketGraph]);
  const boundAddress = bound?.agentAddress.toLowerCase();
  for (const graph of under) {
    if (graph.startsWith(stagingPrefix)) continue;
    if (!isSafeIri(graph)) continue;
    if (bound) {
      const child = parseBoundableSwmChildGraph(bucketGraph, graph);
      if (
        child &&
        (child.agentAddress.toLowerCase() !== boundAddress ||
          child.kaNumber < bound.startNumber ||
          child.kaNumber > bound.endNumber)
      ) {
        continue;
      }
    }
    out.add(graph);
  }
  return [...out] as NonEmptyGraphList;
}

/**
 * Load the selected SWM quad slice from the exact graph set resolved by
 * `resolveSharedMemoryReadGraphs`. This keeps merkle-sensitive SWM selection
 * policy in one place while allowing call sites to inject their small
 * differences, such as query source tags or post-query bookkeeping filters.
 *
 * This function reads the COMPLETE SWM graph set and is safe to use anywhere,
 * including the merkle-DEFINING publish reads and the StorageACK decline lanes.
 * There is deliberately no way to prune the graph set from here — see
 * `loadKaBoundedSharedMemoryQuads` for that, and read its contract first.
 */
export async function loadSelectedSharedMemoryQuads(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  options: LoadSelectedSharedMemoryQuadsOptions = {},
): Promise<Quad[]> {
  return loadSharedMemoryQuadsInternal(store, bucketGraph, selection, options, undefined);
}

/**
 * Load the SWM quad slice pruned to ONE author's per-KA under-graphs (#1549).
 *
 * UNSAFE as a generic merkle accelerator. It is publicly exported only for
 * callers that own an exact named-KA graph boundary; generic merkle callers
 * must use the widening wrapper below. The
 * pruned graph set is a strict subset of the set `loadSelectedSharedMemoryQuads`
 * reads, and INV-1 — "a root's quads live only under its own KA number" — is
 * REFUTED under root recurrence, so this read can legitimately miss quads the
 * on-chain merkle root commits to. The only safe caller is
 * `loadSharedMemorySliceWithKaBoundFallback`, which owns the widen; this is a
 * module-internal primitive it builds on, kept exported only so the graph-set
 * behaviour can be unit-tested directly.
 */
export async function loadKaBoundedSharedMemoryQuads(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  kaGraphBound: SwmKaGraphBound,
  options: LoadSelectedSharedMemoryQuadsOptions = {},
): Promise<Quad[]> {
  return loadSharedMemoryQuadsInternal(store, bucketGraph, selection, options, kaGraphBound);
}

/** Query-source tags for the three read lanes a bounded slice can take. */
export interface SwmSliceSourceTags {
  /** the initial narrowed read, when a bound is supplied */
  bounded: QueryOptions['source'];
  /** an unbounded re-read after an empty or mismatched bounded read */
  widened: QueryOptions['source'];
  /** the initial read when no bound is supplied */
  unbounded: QueryOptions['source'];
}

/**
 * The ONLY safe way to read a KA-bounded SWM slice: read bounded first, then WIDEN
 * to the complete read on an empty-or-mismatched result before returning (#1549).
 * This owns the two-step protocol that `loadKaBoundedSharedMemoryQuads` requires,
 * so callers cannot hold a pruned `Quad[]` without the widen.
 *
 * `accept` is the caller's completeness predicate — e.g. a merkle recompute — that
 * returns the accepted quads or `null` on mismatch. It decides both when a bounded
 * read is "good enough" and what the caller ultimately consumes; storage stays
 * agnostic to merkle. It is built lazily via `createAccept` and invoked at most
 * once (only when there are quads), so a genuine no-data read triggers no extra
 * caller-side work. The widen fires at most once.
 *
 * With no bound this is a single complete read (safe by construction). With a
 * bound the result is exactly what the unbounded read would have produced on any
 * input — never accept→defer, sometimes defer→accept under recurrence.
 */
export async function loadSharedMemorySliceWithKaBoundFallback(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  kaGraphBound: SwmKaGraphBound | undefined,
  sources: SwmSliceSourceTags,
  createAccept: () => Promise<(quads: Quad[]) => Quad[] | null>,
): Promise<{ quads: Quad[]; accepted: Quad[] | null }> {
  const readComplete = (source: QueryOptions['source']): Promise<Quad[]> =>
    loadSelectedSharedMemoryQuads(store, bucketGraph, selection, { querySource: source });

  let quads = kaGraphBound
    ? await loadKaBoundedSharedMemoryQuads(store, bucketGraph, selection, kaGraphBound, {
        querySource: sources.bounded,
      })
    : await readComplete(sources.unbounded);
  let widened = false;

  if (kaGraphBound && quads.length === 0) {
    quads = await readComplete(sources.widened);
    widened = true;
  }
  if (quads.length === 0) return { quads, accepted: null };

  const accept = await createAccept();
  let accepted = accept(quads);
  if (kaGraphBound && !widened && !accepted) {
    quads = await readComplete(sources.widened);
    accepted = accept(quads);
  }
  return { quads, accepted };
}

async function loadSharedMemoryQuadsInternal(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  options: LoadSelectedSharedMemoryQuadsOptions,
  kaGraphBound: SwmKaGraphBound | undefined,
): Promise<Quad[]> {
  let innerGraphPattern: string;
  if (selection === 'all') {
    innerGraphPattern = '?s ?p ?o';
  } else {
    const roots = [...new Set(
      selection.rootEntities
        .map((r) => String(r).trim())
        .filter((r) => isSafeIri(r)),
    )];
    if (roots.length === 0) {
      const hadInput = selection.rootEntities.length > 0;
      const message = options.rootEntitiesErrorMessage?.({
        inputCount: selection.rootEntities.length,
        hadInput,
      }) ?? (
        hadInput
          ? `No valid rootEntities provided (all ${selection.rootEntities.length} entries failed IRI validation)`
          : 'No rootEntities provided'
      );
      throw new Error(message);
    }
    const values = roots.map((r) => `<${r}>`).join(' ');
    innerGraphPattern = `VALUES ?root { ${values} }
          ?s ?p ?o .
          FILTER(
            ?s = ?root
            || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/"))
          )`;
  }

  const queryOptions = mergeQueryOptions(options.queryOptions, options.querySource);
  const swmGraphs = kaGraphBound
    ? await resolveKaBoundedSharedMemoryReadGraphs(store, bucketGraph, kaGraphBound, queryOptions)
    : await resolveSharedMemoryReadGraphs(store, bucketGraph, queryOptions);
  const graphValues = swmGraphs.map((g) => `<${g}>`).join(' ');
  const result = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE {
        VALUES ?g { ${graphValues} }
        GRAPH ?g { ${innerGraphPattern} }
      }`, queryOptions);
  if (result.type !== 'quads') return [];
  return options.quadFilter ? result.quads.filter(options.quadFilter) : result.quads;
}

/**
 * Resolve the concrete set of verifiable-memory graphs to READ under
 * `dataGraph`, enumerated via the fast named-graph index instead of an
 * unbounded `GRAPH ?g` scan. Bound equivalent of the recurring VM read filter
 * `FILTER(STRSTARTS(STR(?g), "${dataGraph}/_verifiable_memory/") || STR(?g) = "${dataGraph}")`:
 * the base graph itself + every per-KA VM graph under
 * `${dataGraph}/_verifiable_memory/` (data + `_meta`). Callers emit
 * `VALUES ?g { … }` so the engine reads only these graphs (O(matched-graphs))
 * rather than scanning the whole store. Same index-freshness / fail-safe
 * characteristics as `resolveSharedMemoryReadGraphs`.
 */
export async function resolveVerifiableMemoryReadGraphs(
  store: TripleStore,
  dataGraph: string,
  options?: QueryOptions,
): Promise<NonEmptyGraphList> {
  assertSafeIri(dataGraph);
  const under = await listGraphsByPrefix(store, `${dataGraph}/_verifiable_memory/`, options);
  const out = new Set<string>([dataGraph]);
  for (const graph of under) if (isSafeIri(graph)) out.add(graph);
  return [...out] as NonEmptyGraphList;
}

/**
 * Load the root-closure slice (`root` plus skolemized children) from the base
 * data graph and every indexed per-KA verifiable-memory graph. Callers can then
 * project the returned CONSTRUCT quads into their own output shape without
 * rebuilding the bound-graph/root-selection SPARQL.
 */
export async function loadSelectedVerifiableMemoryQuads(
  store: TripleStore,
  dataGraph: string,
  rootEntities: Iterable<string>,
  options: LoadSelectedVerifiableMemoryQuadsOptions = {},
): Promise<Quad[]> {
  const roots = [...new Set([...rootEntities].map((root) => String(root)).filter((root) => root.length > 0))];
  if (roots.length === 0) return [];

  const queryOptions = mergeQueryOptions(options.queryOptions, options.querySource);
  const vmGraphs = await resolveVerifiableMemoryReadGraphs(store, dataGraph, queryOptions);
  const graphValues = vmGraphs.map((g) => `<${g}>`).join(' ');
  const rootValues = roots.map((root) => sparqlString(root)).join(' ');
  const result = await store.query(
    `CONSTRUCT {
      ?s ?p ?o
    } WHERE {
      VALUES ?g { ${graphValues} }
      GRAPH ?g {
        VALUES ?rootValue { ${rootValues} }
        ?s ?p ?o .
        FILTER(
          STR(?s) = ?rootValue
          || STRSTARTS(STR(?s), CONCAT(?rootValue, "/.well-known/genid/"))
        )
      }
    }`,
    queryOptions,
  );

  return result.type === 'quads' ? result.quads : [];
}

export class ContextGraphManager {
  private readonly store: TripleStore;
  private readonly ensuredContextGraphs = new Set<string>();

  constructor(store: TripleStore) {
    this.store = store;
  }

  dataGraphUri(contextGraphId: string): string {
    return contextGraphDataUri(contextGraphId);
  }

  metaGraphUri(contextGraphId: string): string {
    return contextGraphMetaUri(contextGraphId);
  }

  privateGraphUri(contextGraphId: string): string {
    return contextGraphPrivateUri(contextGraphId);
  }

  catalogGraphUri(contextGraphId: string): string {
    return contextGraphCatalogUri(contextGraphId);
  }

  sharedMemoryUri(contextGraphId: string, subGraphName?: string): string {
    return contextGraphSharedMemoryUri(contextGraphId, subGraphName);
  }

  sharedMemoryMetaUri(contextGraphId: string, subGraphName?: string): string {
    return contextGraphSharedMemoryMetaUri(contextGraphId, subGraphName);
  }

  verifiableMemoryUri(contextGraphId: string, verifiableMemoryId: string): string {
    return contextGraphVerifiableMemoryUri(contextGraphId, verifiableMemoryId);
  }

  verifiableMemoryMetaUri(contextGraphId: string, verifiableMemoryId: string): string {
    return contextGraphVerifiableMemoryMetaUri(contextGraphId, verifiableMemoryId);
  }

  assertionUri(contextGraphId: string, agentAddress: string, name: string): string {
    return contextGraphAssertionUri(contextGraphId, agentAddress, name);
  }

  subGraphUri(contextGraphId: string, subGraphName: string): string {
    return contextGraphSubGraphUri(contextGraphId, subGraphName);
  }

  subGraphMetaUri(contextGraphId: string, subGraphName: string): string {
    return contextGraphSubGraphMetaUri(contextGraphId, subGraphName);
  }

  subGraphPrivateUri(contextGraphId: string, subGraphName: string): string {
    return contextGraphSubGraphPrivateUri(contextGraphId, subGraphName);
  }

  async ensureSubGraph(contextGraphId: string, subGraphName: string): Promise<void> {
    await this.ensureContextGraph(contextGraphId);
    await this.store.createGraph(this.subGraphUri(contextGraphId, subGraphName));
    await this.store.createGraph(this.subGraphMetaUri(contextGraphId, subGraphName));
    await this.store.createGraph(this.subGraphPrivateUri(contextGraphId, subGraphName));
    await this.store.createGraph(contextGraphSharedMemoryUri(contextGraphId, subGraphName));
    await this.store.createGraph(contextGraphSharedMemoryMetaUri(contextGraphId, subGraphName));
  }

  async ensureContextGraph(contextGraphId: string): Promise<void> {
    if (this.ensuredContextGraphs.has(contextGraphId)) return;
    await this.store.createGraph(this.dataGraphUri(contextGraphId));
    await this.store.createGraph(this.metaGraphUri(contextGraphId));
    await this.store.createGraph(this.privateGraphUri(contextGraphId));
    await this.store.createGraph(this.sharedMemoryUri(contextGraphId));
    await this.store.createGraph(this.sharedMemoryMetaUri(contextGraphId));
    this.ensuredContextGraphs.add(contextGraphId);
  }

  async listContextGraphs(): Promise<string[]> {
    const graphs = await listGraphsByPrefix(this.store, CG_PREFIX);
    const contextGraphs = new Set<string>();
    for (const g of graphs) {
      if (g.startsWith(CG_PREFIX)) {
        const rest = g.slice(CG_PREFIX.length);
        const id = rest.endsWith('/_meta')
          ? rest.slice(0, -6)
          : rest.endsWith('/_private')
            ? rest.slice(0, -9)
            : rest.endsWith('/_shared_memory_meta')
              ? rest.slice(0, -20)
              : rest.endsWith('/_shared_memory')
                ? rest.slice(0, -15)
                : rest;
        if (!id.includes('/')) {
          contextGraphs.add(id);
        }
      }
    }
    return [...contextGraphs];
  }

  /**
   * @deprecated Prefer DKGAgent.listSubGraphs(), which reads spec-compliant
   * registration metadata from the context graph `_meta` graph. This shim keeps
   * the legacy storage-level graph-walk behavior for downstream callers.
   */
  async listSubGraphs(contextGraphId: string): Promise<string[]> {
    const prefix = `${CG_PREFIX}${contextGraphId}/`;
    const allGraphs = await listGraphsByPrefix(this.store, prefix);
    const subGraphNames = new Set<string>();
    const reservedPrefixes = ['_', 'assertion/', 'draft/', 'context/'];
    for (const g of allGraphs) {
      if (!g.startsWith(prefix)) continue;
      const rest = g.slice(prefix.length);
      if (reservedPrefixes.some(r => rest.startsWith(r))) continue;
      const name = rest.endsWith('/_meta') ? rest.slice(0, -6) : rest;
      if (name.includes('/')) continue;
      if (name.length > 0) subGraphNames.add(name);
    }
    return [...subGraphNames];
  }

  async hasContextGraph(contextGraphId: string): Promise<boolean> {
    return this.store.hasGraph(this.dataGraphUri(contextGraphId));
  }

  async dropContextGraph(contextGraphId: string): Promise<void> {
    this.ensuredContextGraphs.delete(contextGraphId);
    await this.store.dropGraph(this.dataGraphUri(contextGraphId));
    await this.store.dropGraph(this.metaGraphUri(contextGraphId));
    await this.store.dropGraph(this.privateGraphUri(contextGraphId));
    await this.store.dropGraph(this.sharedMemoryUri(contextGraphId));
    await this.store.dropGraph(this.sharedMemoryMetaUri(contextGraphId));
    // OT-RFC-49 §5.9: a private CG's public face is its `_catalog` graph (the
    // bounded, plaintext DCAT entry served over open-serve / P2P without
    // membership). Drop it too, or deleting a CG leaves stale discovery
    // metadata that outsiders can still resolve.
    await this.store.dropGraph(this.catalogGraphUri(contextGraphId));
  }

  // ── Deprecated V9 aliases ────────────────────────────────────────────

  /** @deprecated Use dataGraphUri */
  workspaceGraphUri(contextGraphId: string): string {
    return this.sharedMemoryUri(contextGraphId);
  }

  /** @deprecated Use sharedMemoryMetaUri */
  workspaceMetaGraphUri(contextGraphId: string): string {
    return this.sharedMemoryMetaUri(contextGraphId);
  }

}

/** @deprecated Use ContextGraphManager */
export class GraphManager extends ContextGraphManager {}
