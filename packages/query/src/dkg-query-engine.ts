import type { TripleStore, Quad, QueryResult as StoreQueryResult } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import type { QueryResult, QueryOptions, QueryEngine } from './query-engine.js';
import {
  contextGraphDataUri, contextGraphSharedMemoryUri, contextGraphVerifiedMemoryUri, contextGraphAssertionUri,
  contextGraphSubGraphUri,
  assertSafeIri, escapeSparqlLiteral, validateSubGraphName,
  type GetView,
  REMOVED_VIEWS,
  TrustLevel,
} from '@origintrail-official/dkg-core';
import { emptyQueryResultForKind, validateReadOnlySparql } from './sparql-guard.js';

/**
 * Result of resolving a V10 GET view to concrete graph targets.
 */
export interface ViewResolution {
  /** Exact named-graph URIs to query directly. */
  graphs: string[];
  /**
   * Graph URI prefixes — the engine discovers all named graphs matching
   * each prefix and unions the results. Used for working-memory (multiple
   * assertions) and verified-memory (multiple quorum graphs).
   */
  graphPrefixes: string[];
}

/**
 * Resolves a V10 GetView + context graph ID to the named-graph URIs (or
 * prefixes) that the query engine should target.
 *
 * Spec reference: §12 GET — Declared State Views.
 *
 * Trust-level semantics for `verified-memory` (P-13):
 *   The root content graph `did:dkg:context-graph:{id}` holds chain-confirmed
 *   data at only `TrustLevel.SelfAttested` (on-chain anchoring proves the
 *   publisher signed it, not that a quorum endorsed it). Higher-trust data
 *   lives in per-quorum sub-graphs under `/_verified_memory/{quorum}`.
 *   When `minTrust > SelfAttested`, the root data graph is excluded from
 *   the resolution so low-trust triples cannot leak into a high-trust query.
 */
export function resolveViewGraphs(
  view: GetView,
  contextGraphId: string,
  opts?: {
    agentAddress?: string;
    verifiedGraph?: string;
    assertionName?: string;
    minTrust?: TrustLevel;
  },
): ViewResolution {
  if (REMOVED_VIEWS.includes(view as string)) {
    throw new Error(
      `View '${view}' was removed in V10. Use 'verified-memory' for on-chain anchored data. ` +
      `See migration guide for details.`,
    );
  }
  switch (view) {
    case 'working-memory': {
      if (!opts?.agentAddress) {
        throw new Error('agentAddress is required for the working-memory view');
      }
      if (opts.assertionName) {
        return {
          graphs: [contextGraphAssertionUri(contextGraphId, opts.agentAddress, opts.assertionName)],
          graphPrefixes: [],
        };
      }
      return {
        graphs: [],
        graphPrefixes: [`did:dkg:context-graph:${contextGraphId}/assertion/${opts.agentAddress}/`],
      };
    }
    case 'shared-working-memory':
      return {
        graphs: [contextGraphSharedMemoryUri(contextGraphId)],
        graphPrefixes: [],
      };
    case 'verified-memory': {
      // P-13 review (iter-6): `minTrust` is a verified-memory concept
      // — it is the only view whose graph resolution is actually
      // gated by per-graph trust. The earlier iterations ran the
      // numeric/enum validation at the top of `resolveViewGraphs`,
      // but that meant a caller who passes a generic options object
      // (e.g. `{ agentAddress, minTrust }`) across views would get
      // a 400 on `working-memory`/`shared-working-memory` too,
      // where the option is documented as ignored. Keep the
      // validation here so only verified-memory consumers see it.
      if (opts?.minTrust !== undefined) {
        const mt: unknown = opts.minTrust;
        const validLevels = [
          TrustLevel.SelfAttested,
          TrustLevel.Endorsed,
          TrustLevel.PartiallyVerified,
          TrustLevel.ConsensusVerified,
        ];
        if (typeof mt !== 'number' || !Number.isInteger(mt) || !validLevels.includes(mt as TrustLevel)) {
          // "minTrust" + "must be one of" mirrors the daemon's 400
          // classifier wording so the HTTP path maps to a client error.
          throw new Error(
            `Invalid minTrust ${JSON.stringify(mt)}: must be one of TrustLevel.SelfAttested (0), ` +
            `Endorsed (1), PartiallyVerified (2), ConsensusVerified (3). The HTTP /api/query route ` +
            `accepts the string forms "SelfAttested" | "Endorsed" | "PartiallyVerified" | ` +
            `"ConsensusVerified" and normalises them; in-process callers must pass the numeric enum.`,
          );
        }
      }

      const requireHighTrust =
        opts?.minTrust !== undefined && opts.minTrust > TrustLevel.SelfAttested;
      if (opts?.verifiedGraph) {
        // P-13 review (iter-6): every `/_verified_memory/<id>` graph
        // is populated only by quorum-verified write paths, so the
        // floor for those sub-graphs is implicitly `Endorsed`. A
        // caller pinning an exact `verifiedGraph` + `minTrust=Endorsed`
        // therefore asks for the same data the engine would union
        // from the prefix and must succeed. Only values ABOVE
        // `Endorsed` need to be rejected — the engine still cannot
        // prove a single named sub-graph satisfies
        // `PartiallyVerified` / `ConsensusVerified` until per-graph
        // trust metadata (Q-1) lands.
        if (opts.minTrust !== undefined && opts.minTrust > TrustLevel.Endorsed) {
          // Use the exact phrase "cannot be combined with" so the
          // daemon's `/api/query` error classifier maps this to HTTP
          // 400 (see packages/cli/src/daemon.ts). Without that
          // wording the error escapes as a 500.
          throw new Error(
            `verified-memory: verifiedGraph cannot be combined with minTrust above Endorsed ` +
            `(got minTrust=${opts.minTrust}). The engine cannot yet prove a named sub-graph satisfies ` +
            `PartiallyVerified or ConsensusVerified; drop verifiedGraph to union across all ` +
            `quorum-verified sub-graphs, or use minTrust=Endorsed to read the specific sub-graph.`,
          );
        }
        return {
          graphs: [contextGraphVerifiedMemoryUri(contextGraphId, opts.verifiedGraph)],
          graphPrefixes: [],
        };
      }
      // §16.1: the root content graph `did:dkg:context-graph:{id}` IS the
      // Verified Memory content layer (chain-confirmed data lands here after
      // finalization).  Any quorum-specific verified-memory sub-graphs live
      // under `_verified_memory/` and are unioned in as well.
      //
      // P-13: when the caller demands more than SelfAttested, the root data
      // graph is dropped — only quorum-verified sub-graphs survive.
      //
      // P-13 review follow-up: today the /_verified_memory/* sub-graphs
      // carry no per-graph trust metadata — any graph in that prefix was
      // populated by *some* quorum-verified write path, which we treat as
      // at least `Endorsed`. We cannot yet distinguish `PartiallyVerified`
      // vs `ConsensusVerified` without knowing the quorum size, so a caller
      // asking for those higher tiers would silently receive merely
      // Endorsed data. Reject such requests until Q-1 lands per-graph
      // trust tagging; Endorsed itself remains honoured.
      if (
        opts?.minTrust !== undefined &&
        opts.minTrust > TrustLevel.Endorsed
      ) {
        // Use the "Invalid minTrust" prefix so the daemon's /api/query
        // classifier maps this rejection to HTTP 400 instead of 500.
        throw new Error(
          `Invalid minTrust=${opts.minTrust} for verified-memory: values above Endorsed are not yet ` +
          `supported — the engine cannot currently prove a ` +
          `\`/_verified_memory/<quorum>\` sub-graph satisfies PartiallyVerified or ConsensusVerified. ` +
          `Use minTrust=Endorsed (1) to restrict to quorum-verified sub-graphs, or track Q-1 for ` +
          `per-graph trust tagging. See packages/query/src/query-engine.ts QueryOptions.minTrust.`,
        );
      }
      return {
        graphs: requireHighTrust ? [] : [contextGraphDataUri(contextGraphId)],
        graphPrefixes: [`did:dkg:context-graph:${contextGraphId}/_verified_memory/`],
      };
    }
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

    if (options?.subGraphName) {
      const v = validateSubGraphName(options.subGraphName);
      if (!v.valid) throw new Error(`Invalid sub-graph name for query: ${v.reason}`);
    }

    if (options?.view) {
      if (!effectiveContextGraphId) {
        throw new Error(
          `view '${options.view}' requires a contextGraphId or paranetId to scope the query`,
        );
      }
      if (options.subGraphName) {
        throw new Error(
          `subGraphName cannot be combined with view-based routing (view='${options.view}'). ` +
          'Sub-graph scoping within views is deferred to V10.x.',
        );
      }
      return this.queryWithView(sparql, options.view, effectiveContextGraphId, options);
    }

    // ── Legacy routing (V9 compat) ────────────────────────────────────
    let effectiveSparql = sparql;

    if (effectiveContextGraphId && !sparql.toLowerCase().includes('from ')) {
      const dataGraph = options?.subGraphName
        ? contextGraphSubGraphUri(effectiveContextGraphId, options.subGraphName)
        : contextGraphDataUri(effectiveContextGraphId);
      const sharedMemoryGraph = contextGraphSharedMemoryUri(effectiveContextGraphId, options?.subGraphName);
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

    const result = await this.execAndNormalize(effectiveSparql);

    // Strip results originating from excluded graphs (e.g. private CGs).
    if (options?.excludeGraphPrefixes?.length && result.bindings.length > 0) {
      return this.filterExcludedGraphs(result, options.excludeGraphPrefixes);
    }

    return result;
  }

  /**
   * Remove bindings that contain values matching excluded graph URI prefixes.
   * This prevents private CG data from leaking into unscoped queries.
   */
  private filterExcludedGraphs(result: QueryResult, prefixes: string[]): QueryResult {
    const filtered = result.bindings.filter((binding) => {
      for (const value of Object.values(binding)) {
        if (typeof value !== 'string') continue;
        // Strip surrounding angle brackets or quotes from URIs
        const clean = value.replace(/^[<"]|[>"]$/g, '');
        for (const prefix of prefixes) {
          if (clean.startsWith(prefix)) return false;
        }
      }
      return true;
    });
    return { ...result, bindings: filtered };
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
      assertionName: options.assertionName,
      // Back-compat: accept the legacy `_minTrust` underscore form for a
      // deprecation window. See QueryOptions._minTrust.
      minTrust: options.minTrust ?? options._minTrust,
    });

    const allGraphs = [...resolution.graphs];

    for (const prefix of resolution.graphPrefixes) {
      const discovered = await this.discoverGraphsByPrefix(prefix);
      allGraphs.push(...discovered);
    }

    if (allGraphs.length === 0) {
      // PR #239 Codex iter-5: a zero-graph resolution (e.g. a
      // `verified-memory` query with `minTrust=Endorsed` on a context graph
      // that has not been populated with any `/_verified_memory/*`
      // sub-graphs yet) must still respect the requested query form.
      // Returning `{ bindings: [] }` for an ASK would look like a SELECT
      // result and break clients that rely on ASK's boolean binding;
      // CONSTRUCT/DESCRIBE must carry `quads: []`. Delegate to the shared
      // kind-aware empty-result helper.
      return emptyQueryResultForKind(sparql);
    }

    if (allGraphs.length === 1) {
      return this.execAndNormalize(wrapWithGraph(sparql, allGraphs[0]));
    }

    return this.queryMultipleGraphs(sparql, allGraphs);
  }

  private async queryMultipleGraphs(sparql: string, graphs: string[]): Promise<QueryResult> {
    if (graphs.length === 0) return { bindings: [] };
    if (graphs.length === 1) {
      return this.execAndNormalize(wrapWithGraph(sparql, graphs[0]));
    }
    // Build a single union query so LIMIT/ORDER BY/DISTINCT/aggregates
    // apply over the full dataset rather than per-graph.
    const unionSparql = wrapWithGraphUnion(sparql, graphs);
    return this.execAndNormalize(unionSparql);
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
    // Look up KA metadata across all meta graphs, including subGraphName if recorded
    const metaResult = await this.store.query(
      `SELECT ?rootEntity ?ctxGraph ?sgName WHERE {
        GRAPH ?g {
          ?ka <http://dkg.io/ontology/rootEntity> ?rootEntity .
          ?ka <http://dkg.io/ontology/partOf> <${assertSafeIri(ual)}> .
          <${assertSafeIri(ual)}> <http://dkg.io/ontology/paranet> ?ctxGraph .
          OPTIONAL { <${assertSafeIri(ual)}> <http://dkg.io/ontology/subGraphName> ?sgName }
        }
      }`,
    );

    if (metaResult.type !== 'bindings' || metaResult.bindings.length === 0) {
      throw new Error(`KA not found for UAL: ${ual}`);
    }

    const rootEntity = metaResult.bindings[0]['rootEntity'];
    const contextGraphUri = metaResult.bindings[0]['ctxGraph'];
    const contextGraphId = contextGraphUri.replace('did:dkg:context-graph:', '');
    const sgNameRaw = metaResult.bindings[0]['sgName'];
    const subGraphName = sgNameRaw ? sgNameRaw.replace(/^"(.*)".*$/, '$1') : undefined;

    const dataGraph = subGraphName
      ? contextGraphSubGraphUri(contextGraphId, subGraphName)
      : contextGraphDataUri(contextGraphId);

    // Fetch all triples for this entity from the correct data graph
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

/**
 * Wrap a query so it runs over a union of named graphs in a single execution,
 * preserving LIMIT/ORDER BY/DISTINCT/aggregate semantics.
 */
function wrapWithGraphUnion(sparql: string, graphUris: string[]): string {
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

  const valuesClause = graphUris.map((g) => `<${g}>`).join(' ');
  return `${before} VALUES ?_viewGraph { ${valuesClause} } GRAPH ?_viewGraph { ${inner} } ${after}`;
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

