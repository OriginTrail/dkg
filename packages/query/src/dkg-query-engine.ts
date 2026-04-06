import type { TripleStore, Quad, QueryResult as StoreQueryResult } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import type { QueryResult, QueryOptions, QueryEngine } from './query-engine.js';
import {
  contextGraphDataUri, contextGraphSharedMemoryUri, contextGraphVerifiedMemoryUri, contextGraphDraftUri,
  assertSafeIri, escapeSparqlLiteral,
  type GetView,
} from '@origintrail-official/dkg-core';
import { validateReadOnlySparql } from './sparql-guard.js';

/**
 * Result of resolving a V10 GET view to concrete graph targets.
 */
export interface ViewResolution {
  /** Exact named-graph URIs to query directly. */
  graphs: string[];
  /**
   * Graph URI prefixes — the engine discovers all named graphs matching
   * each prefix and unions the results. Used for working-memory (multiple
   * drafts) and verified-memory (multiple quorum graphs).
   */
  graphPrefixes: string[];
  /** When true the engine merges results with VM-wins-on-conflict semantics. */
  vmWinsOnConflict: boolean;
}

/**
 * Resolves a V10 GetView + context graph ID to the named-graph URIs (or
 * prefixes) that the query engine should target.
 *
 * Spec reference: §12 GET — Declared State Views.
 */
export function resolveViewGraphs(
  view: GetView,
  contextGraphId: string,
  opts?: { agentAddress?: string; verifiedGraph?: string; draftName?: string },
): ViewResolution {
  switch (view) {
    case 'working-memory': {
      if (!opts?.agentAddress) {
        throw new Error('agentAddress is required for the working-memory view');
      }
      if (opts.draftName) {
        return {
          graphs: [contextGraphDraftUri(contextGraphId, opts.agentAddress, opts.draftName)],
          graphPrefixes: [],
          vmWinsOnConflict: false,
        };
      }
      return {
        graphs: [],
        graphPrefixes: [`did:dkg:context-graph:${contextGraphId}/draft/${opts.agentAddress}/`],
        vmWinsOnConflict: false,
      };
    }
    case 'shared-working-memory':
      return {
        graphs: [contextGraphSharedMemoryUri(contextGraphId)],
        graphPrefixes: [],
        vmWinsOnConflict: false,
      };
    case 'long-term-memory':
      return {
        graphs: [contextGraphDataUri(contextGraphId)],
        graphPrefixes: [],
        vmWinsOnConflict: false,
      };
    case 'verified-memory': {
      if (opts?.verifiedGraph) {
        return {
          graphs: [contextGraphVerifiedMemoryUri(contextGraphId, opts.verifiedGraph)],
          graphPrefixes: [],
          vmWinsOnConflict: false,
        };
      }
      return {
        graphs: [],
        graphPrefixes: [`did:dkg:context-graph:${contextGraphId}/_verified_memory/`],
        vmWinsOnConflict: false,
      };
    }
    case 'authoritative':
      return {
        graphs: [contextGraphDataUri(contextGraphId)],
        graphPrefixes: [`did:dkg:context-graph:${contextGraphId}/_verified_memory/`],
        vmWinsOnConflict: true,
      };
  }
}

/**
 * Local-only query engine that executes SPARQL against this node's own
 * triple store. No remote query capability — by design (Spec §1.6 Store
 * Isolation). All data must arrive via protocol messages (publish, access,
 * sync) before it can be queried here.
 */
export class DKGQueryEngine implements QueryEngine {
  private readonly store: TripleStore;
  private readonly graphManager: GraphManager;

  constructor(store: TripleStore) {
    this.store = store;
    this.graphManager = new GraphManager(store);
  }

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    const guard = validateReadOnlySparql(sparql);
    if (!guard.safe) {
      throw new Error(`SPARQL rejected: ${guard.reason}`);
    }

    // ── V10 view-based routing ────────────────────────────────────────
    const effectiveContextGraphId = options?.contextGraphId ?? options?.paranetId;
    if (options?.view) {
      if (!effectiveContextGraphId) {
        throw new Error(
          `view '${options.view}' requires a contextGraphId or paranetId to scope the query`,
        );
      }
      return this.queryWithView(sparql, options.view, effectiveContextGraphId, options);
    }

    // ── Legacy routing (V9 compat) ────────────────────────────────────
    let effectiveSparql = sparql;

    if (effectiveContextGraphId && !sparql.toLowerCase().includes('from ')) {
      const dataGraph = contextGraphDataUri(effectiveContextGraphId);
      const sharedMemoryGraph = contextGraphSharedMemoryUri(effectiveContextGraphId);
      if (options?.includeSharedMemory ?? options?.includeWorkspace) {
        const dataSparql = wrapWithGraph(sparql, dataGraph);
        const sharedMemorySparql = wrapWithGraph(sparql, sharedMemoryGraph);
        const dataResult = await this.store.query(dataSparql);
        const smResult = await this.store.query(sharedMemorySparql);
        return mergeSharedMemoryAndDataResults(dataResult, smResult);
      }
      if (options?.graphSuffix === '_shared_memory') {
        effectiveSparql = wrapWithGraph(sparql, sharedMemoryGraph);
      } else {
        effectiveSparql = wrapWithGraph(sparql, dataGraph);
      }
    }

    return this.execAndNormalize(effectiveSparql);
  }

  /**
   * Execute a SPARQL query scoped to a declared V10 state view.
   */
  private async queryWithView(
    sparql: string,
    view: GetView,
    contextGraphId: string,
    options: QueryOptions,
  ): Promise<QueryResult> {
    const resolution = resolveViewGraphs(view, contextGraphId, {
      agentAddress: options.agentAddress,
      verifiedGraph: options.verifiedGraph,
    });

    const allGraphs = [...resolution.graphs];

    for (const prefix of resolution.graphPrefixes) {
      const discovered = await this.discoverGraphsByPrefix(prefix);
      allGraphs.push(...discovered);
    }

    if (allGraphs.length === 0) {
      return { bindings: [] };
    }

    if (allGraphs.length === 1) {
      return this.execAndNormalize(wrapWithGraph(sparql, allGraphs[0]));
    }

    if (resolution.vmWinsOnConflict) {
      const ltmGraphs = resolution.graphs;
      const vmGraphs = allGraphs.filter((g) => !ltmGraphs.includes(g));
      const ltmResults = await this.queryMultipleGraphs(sparql, ltmGraphs);
      const vmResults = await this.queryMultipleGraphs(sparql, vmGraphs);
      return mergeAuthoritativeResults(ltmResults, vmResults);
    }

    return this.queryMultipleGraphs(sparql, allGraphs);
  }

  private async queryMultipleGraphs(sparql: string, graphs: string[]): Promise<QueryResult> {
    const allBindings: Array<Record<string, string>> = [];
    const allQuads: Quad[] = [];
    for (const graph of graphs) {
      const r = await this.execAndNormalize(wrapWithGraph(sparql, graph));
      allBindings.push(...r.bindings);
      if (r.quads) allQuads.push(...r.quads);
    }
    return {
      bindings: dedupeBindings(allBindings),
      ...(allQuads.length > 0 ? { quads: dedupeQuads(allQuads) } : {}),
    };
  }

  private async discoverGraphsByPrefix(prefix: string): Promise<string[]> {
    const allGraphs = await this.store.listGraphs();
    return allGraphs.filter(
      (g) => g.startsWith(prefix) && !g.includes('/_meta') && !g.includes('/staging/'),
    );
  }

  private async execAndNormalize(sparql: string): Promise<QueryResult> {
    const result = await this.store.query(sparql);

    if (result.type === 'bindings') {
      return { bindings: result.bindings };
    }
    if (result.type === 'quads') {
      return { bindings: [], quads: result.quads };
    }
    if (result.type === 'boolean') {
      return { bindings: [{ result: String(result.value) }] };
    }
    return { bindings: [] };
  }

  async resolveKA(ual: string): Promise<{
    rootEntity: string;
    contextGraphId: string;
    quads: Quad[];
  }> {
    // Look up KA metadata across all meta graphs
    const metaResult = await this.store.query(
      `SELECT ?rootEntity ?ctxGraph WHERE {
        GRAPH ?g {
          ?ka <http://dkg.io/ontology/rootEntity> ?rootEntity .
          ?ka <http://dkg.io/ontology/partOf> <${assertSafeIri(ual)}> .
          <${assertSafeIri(ual)}> <http://dkg.io/ontology/paranet> ?ctxGraph .
        }
      }`,
    );

    if (metaResult.type !== 'bindings' || metaResult.bindings.length === 0) {
      throw new Error(`KA not found for UAL: ${ual}`);
    }

    const rootEntity = metaResult.bindings[0]['rootEntity'];
    const contextGraphUri = metaResult.bindings[0]['ctxGraph'];
    const contextGraphId = contextGraphUri.replace('did:dkg:context-graph:', '');
    const dataGraph = contextGraphDataUri(contextGraphId);

    // Fetch all triples for this entity
    const dataResult = await this.store.query(
      `SELECT ?s ?p ?o WHERE {
        GRAPH <${assertSafeIri(dataGraph)}> {
          ?s ?p ?o .
          FILTER(
            ?s = <${assertSafeIri(rootEntity)}>
            || STRSTARTS(STR(?s), "${escapeSparqlLiteral(rootEntity)}/.well-known/genid/")
          )
        }
      }`,
    );

    const quads: Quad[] =
      dataResult.type === 'bindings'
        ? dataResult.bindings.map((row) => ({
            subject: row['s'],
            predicate: row['p'],
            object: row['o'],
            graph: dataGraph,
          }))
        : [];

    return { rootEntity, contextGraphId, quads };
  }

  /**
   * Execute a query across all locally-stored context graphs.
   */
  async queryAllContextGraphs(sparql: string): Promise<QueryResult> {
    const contextGraphIds = await this.graphManager.listContextGraphs();
    const allBindings: Array<Record<string, string>> = [];

    for (const contextGraphId of contextGraphIds) {
      const result = await this.query(sparql, { contextGraphId });
      allBindings.push(...result.bindings);
    }

    return { bindings: allBindings };
  }

  /** @deprecated Use queryAllContextGraphs */
  async queryAllParanets(sparql: string): Promise<QueryResult> {
    return this.queryAllContextGraphs(sparql);
  }
}

/**
 * Wraps a SELECT query to scope it to a named graph.
 * If the query already uses GRAPH patterns, returns it unchanged.
 */
function wrapWithGraph(sparql: string, graphUri: string): string {
  if (sparql.toLowerCase().includes('graph ')) return sparql;

  const whereIdx = sparql.search(/WHERE\s*\{/i);
  if (whereIdx === -1) return sparql;

  const braceStart = sparql.indexOf('{', whereIdx);
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < sparql.length; i++) {
    if (sparql[i] === '{') depth++;
    else if (sparql[i] === '}') {
      depth--;
      if (depth === 0) { braceEnd = i; break; }
    }
  }
  if (braceEnd === -1) return sparql;

  const before = sparql.slice(0, braceStart + 1);
  const inner = sparql.slice(braceStart + 1, braceEnd);
  const after = sparql.slice(braceEnd);

  return `${before} GRAPH <${graphUri}> { ${inner} } ${after}`;
}

function mergeSharedMemoryAndDataResults(
  dataResult: StoreQueryResult,
  smResult: StoreQueryResult,
): QueryResult {
  if (dataResult.type === 'quads' || smResult.type === 'quads') {
    const mergedQuads = dedupeQuads([
      ...(dataResult.type === 'quads' ? dataResult.quads : []),
      ...(smResult.type === 'quads' ? smResult.quads : []),
    ]);
    return { bindings: [], quads: mergedQuads };
  }

  if (dataResult.type === 'boolean' || smResult.type === 'boolean') {
    const value = (dataResult.type === 'boolean' ? dataResult.value : false)
      || (smResult.type === 'boolean' ? smResult.value : false);
    return { bindings: [{ result: String(value) }] };
  }

  const mergedBindings = dedupeBindings([
    ...(dataResult.type === 'bindings' ? dataResult.bindings : []),
    ...(smResult.type === 'bindings' ? smResult.bindings : []),
  ]);
  return { bindings: mergedBindings };
}

function dedupeBindings(
  bindings: Array<Record<string, string>>,
): Array<Record<string, string>> {
  const seen = new Set<string>();
  const out: Array<Record<string, string>> = [];
  for (const row of bindings) {
    const key = bindingKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function bindingKey(row: Record<string, string>): string {
  const entries = Object.entries(row).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function dedupeQuads(quads: Quad[]): Quad[] {
  const seen = new Set<string>();
  const out: Quad[] = [];
  for (const q of quads) {
    const key = `${q.subject}\u0000${q.predicate}\u0000${q.object}\u0000${q.graph}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/**
 * Merge LTM and VM results for the 'authoritative' view.
 * VM wins on conflict: when the same subject+predicate appears in both
 * result sets, the VM binding is kept and the LTM one is dropped.
 */
function mergeAuthoritativeResults(
  ltmResult: QueryResult,
  vmResult: QueryResult,
): QueryResult {
  if (vmResult.bindings.length === 0 && !vmResult.quads?.length) {
    return ltmResult;
  }

  const vmSubjectPredicates = new Set<string>();
  for (const row of vmResult.bindings) {
    if (row['s'] && row['p']) {
      vmSubjectPredicates.add(`${row['s']}\u0000${row['p']}`);
    }
  }

  const filteredLtm = vmSubjectPredicates.size > 0
    ? ltmResult.bindings.filter((row) => {
        if (!row['s'] || !row['p']) return true;
        return !vmSubjectPredicates.has(`${row['s']}\u0000${row['p']}`);
      })
    : ltmResult.bindings;

  const mergedBindings = dedupeBindings([...filteredLtm, ...vmResult.bindings]);

  const mergedQuads = dedupeQuads([
    ...(ltmResult.quads ?? []),
    ...(vmResult.quads ?? []),
  ]);

  return {
    bindings: mergedBindings,
    ...(mergedQuads.length > 0 ? { quads: mergedQuads } : {}),
  };
}

