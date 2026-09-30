import { mergeQueryOptions, listGraphsByPrefix } from './read-store-query-utils.js';
export {
  resolveSharedMemoryReadGraphs,
  resolveKaBoundedSharedMemoryReadGraphs,
  loadSelectedSharedMemoryQuads,
  loadKaBoundedSharedMemoryQuads,
  loadSharedMemoryQuadsForScope,
  resolveSharedMemoryScopeGraphs,
  canonicalSharedMemoryScopeWriteGraph,
  resolveSharedMemoryScopeWriteGraph,
  loadSharedMemorySliceWithKaBoundFallback,
  loadMerkleVerifiedSharedMemorySlice,
  SharedMemoryReadConsistencyError,
  SharedMemoryResultBudgetError,
  type SharedMemoryResultBudget,
  type NonEmptyGraphList,
  type SharedMemoryReadSelection,
  type SwmKaGraphBound,
  type NamedKnowledgeAssetGraphIdentity,
  type SharedMemoryGraphScope,
  type LoadSelectedSharedMemoryQuadsOptions,
  type SwmSliceSourceTags,
  type LoadSharedMemorySliceWithKaBoundFallbackOptions,
  type LoadMerkleVerifiedSharedMemorySliceOptions,
  type MerkleVerifiedSharedMemorySliceResult,
} from './swm-read-coordinator.js';
import type { NonEmptyGraphList } from './swm-read-coordinator.js';

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
  validateNewContextGraphId,
  validateContextGraphId,
  contextGraphStorageOwnerCandidates,
} from '@origintrail-official/dkg-core';

const CG_PREFIX = 'did:dkg:context-graph:';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ROOT_CONTEXT_GRAPH_TYPES = Object.freeze([
  'https://dkg.network/ontology#ContextGraph',
  'http://dkg.io/ontology/ContextGraph',
] as const);
const SYSTEM_ONTOLOGY_GRAPH = contextGraphDataUri('ontology');
const SYSTEM_AGENTS_GRAPH = contextGraphDataUri('agents');
const MAX_CONTEXT_GRAPH_DECLARATION_BATCH = 256;
export interface LoadSelectedVerifiableMemoryQuadsOptions {
  querySource?: QueryOptions['source'];
  queryOptions?: QueryOptions;
}

/**
 * Return the root id represented by one known storage partition. The graph
 * walk is retained for legacy/storage-only roots, but slash-bearing ids are
 * intentionally handled by the declaration query below: a URI such as
 * `owner/name` can also be a subgraph and cannot be classified by path alone.
 */
function contextGraphIdFromStorageGraph(graph: string): string | undefined {
  if (!graph.startsWith(CG_PREFIX)) return undefined;
  const rest = graph.slice(CG_PREFIX.length);
  if (rest.length === 0) return undefined;
  if (rest.endsWith('/_shared_memory_meta')) return rest.slice(0, -20);
  if (rest.endsWith('/_shared_memory')) return rest.slice(0, -15);
  if (rest.endsWith('/_private')) return rest.slice(0, -9);
  if (rest.endsWith('/_meta')) return rest.slice(0, -6);
  return rest;
}

function stripIriTerm(value: string): string {
  return value.startsWith('<') && value.endsWith('>')
    ? value.slice(1, -1)
    : value;
}

/**
 * Resolve ambiguous slash-bearing storage ids through authoritative root
 * declarations. This is deliberately a bounded VALUES query: it avoids a
 * store-wide semantic scan while ensuring subgraph metadata cannot be
 * mistaken for a context-graph root.
 */
async function listDeclaredSlashContextGraphs(
  store: TripleStore,
  candidates: ReadonlySet<string>,
  options?: QueryOptions,
): Promise<string[]> {
  const candidateUris = [...candidates]
    .map((id) => contextGraphDataUri(id))
    .filter((uri) => isSafeIri(uri));
  const rootTypes = ROOT_CONTEXT_GRAPH_TYPES.map((iri) => `<${iri}>`).join(' ');
  const declared = new Set<string>();

  for (let offset = 0; offset < candidateUris.length; offset += MAX_CONTEXT_GRAPH_DECLARATION_BATCH) {
    const values = candidateUris
      .slice(offset, offset + MAX_CONTEXT_GRAPH_DECLARATION_BATCH)
      .map((uri) => `<${uri}>`)
      .join(' ');
    const result = await store.query(
      `SELECT DISTINCT ?ctxGraph WHERE {
        VALUES ?ctxGraph { ${values} }
        VALUES ?rootType { ${rootTypes} }
        {
          GRAPH <${SYSTEM_ONTOLOGY_GRAPH}> {
            ?ctxGraph <${RDF_TYPE}> ?rootType .
          }
        }
        UNION
        {
          GRAPH <${SYSTEM_AGENTS_GRAPH}> {
            ?ctxGraph <${RDF_TYPE}> ?rootType .
          }
        }
        UNION
        {
          GRAPH ?metaGraph {
            ?ctxGraph <${RDF_TYPE}> ?rootType .
          }
          FILTER(STR(?metaGraph) = CONCAT(STR(?ctxGraph), "/_meta"))
        }
      }`,
      options,
    );
    if (result.type !== 'bindings') continue;
    for (const row of result.bindings) {
      const uri = stripIriTerm(row.ctxGraph ?? '');
      if (!uri.startsWith(CG_PREFIX)) continue;
      const id = uri.slice(CG_PREFIX.length);
      if (id.includes('/') && validateContextGraphId(id).valid) declared.add(id);
    }
  }
  return [...declared];
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

  /** Reject an ID that would alias one of the storage-owned partitions. */
  assertNewContextGraphId(contextGraphId: string): void {
    const validation = validateNewContextGraphId(contextGraphId);
    if (!validation.valid) {
      throw new Error(`Invalid context graph ID: ${validation.reason}`);
    }
  }

  /**
   * Create the storage partitions for a newly-authored context graph.
   * Existing read and sync paths intentionally keep using ensureContextGraph.
   */
  async ensureNewContextGraph(contextGraphId: string): Promise<void> {
    this.assertNewContextGraphId(contextGraphId);
    await this.ensureContextGraph(contextGraphId);
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

  async listContextGraphs(options?: QueryOptions): Promise<string[]> {
    const graphs = await listGraphsByPrefix(this.store, CG_PREFIX, options);
    const contextGraphs = new Set<string>();
    const slashCandidates = new Set<string>();

    // Context graphs ensured by this manager are already unambiguous. Keep
    // these entries even when a freshly-created root has not written its
    // registration marker yet.
    for (const id of this.ensuredContextGraphs) contextGraphs.add(id);

    for (const g of graphs) {
      const id = contextGraphIdFromStorageGraph(g);
      if (id === undefined) continue;
      if (!id.includes('/')) contextGraphs.add(id);

      // Build the complete set of possible owner interpretations for an
      // ambiguous URI, then admit only interpretations backed by a root
      // ContextGraph declaration. A plain path-prefix filter cannot make this
      // distinction: `owner/name` is also the storage URI of subgraph `name`
      // under root `owner`.
      const owners = contextGraphStorageOwnerCandidates(g);
      for (const owner of owners ?? []) {
        if (owner.includes('/')) slashCandidates.add(owner);
      }
    }

    for (const id of await listDeclaredSlashContextGraphs(this.store, slashCandidates, options)) {
      contextGraphs.add(id);
    }

    return [...contextGraphs];
  }

  /**
   * Enumerate every legal Context Graph owner interpretation represented by
   * persisted storage graphs. This is an inventory boundary only: callers
   * still resolve read authority for every returned candidate.
   */
  async listStoredContextGraphOwnerCandidates(options: QueryOptions = {}): Promise<string[]> {
    options.signal?.throwIfAborted();
    const graphUris = await listGraphsByPrefix(this.store, CG_PREFIX, {
      ...options,
      source: options.source ?? 'storage.contextGraphOwnerCandidates',
    });
    const candidates = new Set<string>();
    let visited = 0;
    for (const graph of graphUris) {
      // Preserve cancellation responsiveness without imposing a cardinality
      // limit: ordinary per-KA graph growth can legitimately be large.
      if (visited++ % 512 === 511) await new Promise<void>((resolve) => setImmediate(resolve));
      options.signal?.throwIfAborted();
      if (!graph.startsWith(CG_PREFIX)) continue;
      const owners = contextGraphStorageOwnerCandidates(graph);
      if (owners === undefined) {
        throw new Error('Cannot authorize unscoped query: unrecognized stored Context Graph owner');
      }
      for (const id of owners) candidates.add(id);
    }
    options.signal?.throwIfAborted();
    return [...candidates];
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
