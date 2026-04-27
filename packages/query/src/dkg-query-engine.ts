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
import {
  validateReadOnlySparql,
  emptyQueryResultForKind,
} from './sparql-guard.js';

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
    /**
     * Spec §12/§14 trust-gradient filter (P-13). When set above
     * `TrustLevel.SelfAttested`, the verified-memory resolution narrows
     * to anchored quorum sub-graphs (`.../_verified_memory/…`) only —
     * the root data graph is removed because it can carry mixed-trust
     * finalized data. Values above `Endorsed` are rejected until
     * per-graph trust tagging (Q-1) lands; see body for details.
     */
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
      // P-13 (graph-scope) + Q-1 (per-triple) working together:
      //   - Graph-scope (this function): when `minTrust > SelfAttested`
      //     the root content graph is dropped (via `requireHighTrust`)
      //     and only `/_verified_memory/<quorum>` sub-graphs survive.
      //     That sub-graph prefix is populated only by quorum-verified
      //     write paths, so the floor for those graphs is implicitly
      //     `Endorsed`.
      //   - Per-triple (DKGQueryEngine.queryWithView): when
      //     `minTrust` is set, `injectMinTrustFilter` rewrites the user
      //     SPARQL so every subject MUST carry an explicit
      //     `<http://dkg.io/ontology/trustLevel> "N"` literal with
      //     `N ≥ minTrust`. Subjects without such metadata are
      //     silently rejected (fail-closed — see bot review L1).
      //
      // Together this satisfies spec §14 for values above `Endorsed`:
      // even though the engine cannot yet distinguish a
      // `PartiallyVerified`-quorum sub-graph from a `ConsensusVerified`
      // one at the graph level, a caller asking for `ConsensusVerified`
      // data only ever sees quads whose triples carry the matching
      // per-triple trust literal, so sub-threshold data cannot leak.
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
      // PR #239 / r17-2: a zero-graph resolution (e.g. a `verified-memory`
      // query with `minTrust=Endorsed` on a context graph that has not
      // been populated with any `/_verified_memory/*` sub-graphs yet) must
      // still respect the requested query form. Returning `{ bindings: [] }`
      // for an ASK would look like a SELECT result and break clients that
      // rely on ASK's boolean binding; CONSTRUCT/DESCRIBE must carry
      // `quads: []`. Delegate to the shared kind-aware empty-result helper.
      return emptyQueryResultForKind(sparql);
    }

    // Spec §14 trust-gradient filter — only enforced on verified-memory
    // where on-chain-anchored trust metadata is expected to live.
    // When `minTrust` (or legacy `_minTrust`) is set, rewrite the query so
    // every subject matched by the user's pattern MUST carry an explicit
    // `http://dkg.io/ontology/trustLevel` literal whose integer value is
    // ≥ minTrust. Subjects with no trust metadata are rejected.
    //
    // Bot review L1: previously, when `injectMinTrustFilter()` could not
    // safely rewrite the query (e.g. explicit GRAPH, non-BGP first
    // clause, multi-subject WHERE), we silently ran the ORIGINAL
    // unfiltered SPARQL. That turned the trust threshold into a no-op in
    // exactly the shapes most likely to span sensitive data, and a caller
    // had no signal that their threshold was being ignored. Now the
    // rewriter MUST succeed or we fail closed — returning an empty result
    // is the correct behaviour for "no subject meets the trust threshold"
    // when we cannot prove the threshold was applied.
    let effectiveSparql = sparql;
    const effectiveMinTrust = options.minTrust ?? options._minTrust;
    // `SelfAttested` (0) is the floor and means "no per-triple filter
    // needed". Skip the rewrite at that level so SELECT queries that
    // predate trust tagging still see every triple — the graph-scope
    // resolution above keeps the root data graph in scope at
    // SelfAttested, so the per-triple filter would otherwise reject
    // every quad that lacks a `dkg:trustLevel` literal (i.e. every
    // pre-Q-1 quad).
    if (
      view === 'verified-memory' &&
      effectiveMinTrust !== undefined &&
      effectiveMinTrust > TrustLevel.SelfAttested
    ) {
      const rewritten = injectMinTrustFilter(sparql, effectiveMinTrust);
      if (!rewritten) {
        console.warn(
          `[DKGQueryEngine] minTrust=${effectiveMinTrust} requested for a query shape ` +
            `injectMinTrustFilter cannot safely rewrite; returning empty result (fail-closed)`,
        );
        // Preserve the query form so CONSTRUCT/DESCRIBE callers see
        // `{ bindings: [], quads: [] }` rather than a shapeless deny, and
        // ASK callers see `{ bindings: [{ result: 'false' }] }`.
        return emptyQueryResultForKind(sparql);
      }
      effectiveSparql = rewritten;
    }

    if (allGraphs.length === 1) {
      return this.execAndNormalize(wrapWithGraph(effectiveSparql, allGraphs[0]));
    }

    return this.queryMultipleGraphs(effectiveSparql, allGraphs);
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
 *
 * Bot review (PR #229 L-follow-up): the previous revision injected
 * `VALUES ?_viewGraph { <g1> <g2> … } GRAPH ?_viewGraph { inner }` directly
 * into the caller's WHERE block. Two failure modes:
 *
 *   1. Scope leak — `SELECT *` (or any projection that includes the graph
 *      variable) over a multi-graph view emitted an extra `_viewGraph`
 *      column, so downstream consumers saw a mystery binding they didn't
 *      ask for.
 *   2. Name collision — a user query that legitimately binds
 *      `?_viewGraph` (rare but valid) would silently intersect with the
 *      helper's VALUES list and clamp to the helper's graph URIs.
 *
 * The fix is to use an explicit UNION over each graph instead of a
 * single GRAPH ?var binding. That keeps the inner block's variables
 * (and only those) in scope — no helper var is introduced at all, so
 * neither SELECT * leakage nor variable-name collisions can happen.
 * Single-graph views skip the UNION wrapper entirely and use a plain
 * `GRAPH <uri>` block.
 */
function wrapWithGraphUnion(sparql: string, graphUris: string[]): string {
  if (sparql.toLowerCase().includes('graph ')) return sparql;
  if (graphUris.length === 0) return sparql;

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

  if (graphUris.length === 1) {
    return `${before} GRAPH <${graphUris[0]}> { ${inner} } ${after}`;
  }

  const unionBranches = graphUris
    .map((g) => `{ GRAPH <${g}> { ${inner} } }`)
    .join(' UNION ');
  return `${before} ${unionBranches} ${after}`;
}

/**
 * Rewrites a SPARQL query so EVERY subject variable used in its WHERE
 * block also matches `<http://dkg.io/ontology/trustLevel> ?__trustN`
 * with an integer value ≥ `minTrust`. Subjects with no trust metadata
 * are filtered out (the required triple is absent).
 *
 * The rewriter scans the WHERE block for top-level triple patterns and
 * collects every distinct subject variable (bot review L3 — previously
 * only the first subject var was captured, so multi-subject queries
 * like `?a <p> ?o . ?b <q> ?r` had `?b` pass through unfiltered).
 *
 * Returns `null` when:
 *   - no `WHERE { ... }` block can be located;
 *   - braces are unbalanced;
 *   - the WHERE contains nested structure (`{`, `GRAPH`, `OPTIONAL`,
 *     `UNION`, `MINUS`, `SERVICE`, subselect) we cannot safely rewrite;
 *   - the block contains a constant (IRI/literal/blank) subject — we
 *     cannot attach a filter to a constant, and silently ignoring the
 *     constant row would leak sub-threshold data (L1 fail-closed);
 *   - no subject var is found at all.
 * Callers treat `null` as "refuse to run" (see bot review L1).
 */
/**
 * Strip SPARQL line comments (`# … EOL`) from a fragment of SPARQL
 * WHERE body while preserving `#` that appears inside an IRI
 * (`<http://…/rdf-ns#type>`) or inside a string literal (`"…#…"`,
 * `'…#…'`). Used by `injectMinTrustFilter` where a full parser would
 * be overkill but a naive line-comment regex mangles `rdf:type` etc.
 *
 * This is intentionally small: we handle the three grammar contexts
 * that can legally contain a bare `#` in SPARQL 1.1 (IRI, quoted
 * literal, line comment) and treat everything else as ordinary code.
 * Triple-quoted `"""…"""` / `'''…'''` are NOT recognised because
 * `injectMinTrustFilter` already bails on any WHERE containing tokens
 * from the multi-line literal grammar (FILTER EXISTS, SELECT, …).
 */
function stripSparqlLineComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '<') {
      const end = src.indexOf('>', i + 1);
      if (end === -1) { out += src.slice(i); break; }
      out += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\' && j + 1 < n) { j += 2; continue; }
        if (src[j] === quote) { j++; break; }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '#') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) { break; }
      i = nl; // leave the newline so dot-accounting still sees line breaks
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Split a SPARQL WHERE body on **top-level** triple terminators, i.e.
 * dots that live outside quoted literals and outside IRI angle
 * brackets. PR #229 bot review round 8 (dkg-query-engine.ts:576): the
 * previous `/\.(?=\s|$)/` regex broke on literal dots in messages like
 * `?s <p> "hello. world"`, silently fragmenting the statement so the
 * subject scanner returned garbage and `_minTrust` fail-closed to `[]`
 * for every text/chat query. This tokenizer walks the body character
 * by character, tracks `<…>` and `"…"` / `'…'` scopes (with `\`-escape
 * handling), and only treats `.` as a separator when it sits at depth
 * zero and is followed by whitespace or end-of-input. Comments have
 * already been stripped by {@link stripSparqlLineComments} before we
 * get here, so `#` is treated as an ordinary character.
 *
 * Parentheses and braces would also open top-level scopes in general
 * SPARQL, but `injectMinTrustFilter` refuses to rewrite any WHERE that
 * contains `{`, `}`, `FILTER EXISTS`, subselects, or property paths
 * with grouping (the `/\{|\}/.test(inner)` + token guard above), so
 * this helper only has to handle the three grammar contexts that can
 * legally carry a bare `.` in the shapes we rewrite: IRI, string
 * literal, and top-level statement terminator.
 */
function splitTopLevelTripleStatements(body: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    if (ch === '<') {
      const end = body.indexOf('>', i + 1);
      if (end === -1) { i = n; break; }
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (body[j] === '\\' && j + 1 < n) { j += 2; continue; }
        if (body[j] === quote) { j++; break; }
        j++;
      }
      i = j;
      continue;
    }
    if (ch === '.') {
      // Terminator only when followed by whitespace OR end-of-input.
      // This keeps decimals and prefixed-name dots (rdf:type.foo —
      // rejected upstream anyway) from accidentally splitting, and
      // matches the original regex semantics on the top-level cases.
      const next = i + 1 < n ? body[i + 1] : '';
      if (next === '' || /\s/.test(next)) {
        const piece = body.slice(start, i).trim();
        if (piece) out.push(piece);
        start = i + 1;
        i += 1;
        continue;
      }
    }
    i++;
  }
  const tail = body.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function injectMinTrustFilter(sparql: string, minTrust: number): string | null {
  const whereIdx = sparql.search(/WHERE\s*\{/i);
  if (whereIdx === -1) return null;
  const braceStart = sparql.indexOf('{', whereIdx);
  if (braceStart === -1) return null;

  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < sparql.length; i++) {
    if (sparql[i] === '{') depth++;
    else if (sparql[i] === '}') {
      depth--;
      if (depth === 0) { braceEnd = i; break; }
    }
  }
  if (braceEnd === -1) return null;

  const inner = sparql.slice(braceStart + 1, braceEnd);

  // PR #229 bot review round 23 (r23-2, dkg-query-engine.ts). A
  // leading top-level `VALUES` clause is the canonical SPARQL shape
  // for batched exact-subject lookups:
  //
  //     SELECT ?o WHERE {
  //       VALUES ?s { <a> <b> <c> }
  //       ?s <p> ?o .
  //     }
  //
  // Pre-r23 the forbidden-tokens regex treated any VALUES as
  // "unsupported" and `_minTrust` fell through to
  // `emptyResultForForm(...)`, which turns into a silent `[]` / `false`
  // even when the bound subjects satisfy the threshold. The contract
  // we need is:
  //   (a) bail loudly on complex VALUES we can't reason about
  //       (multi-var tuples, multi-line, no closing `}`);
  //   (b) for the common single-var VALUES case, peel it off, run
  //       the existing subject analysis on the body, and re-emit
  //       the VALUES binding at the top of the rewritten WHERE so
  //       the trust filter still applies to each bound IRI.
  //
  // Any other location (non-leading, multi-var, parenthesised row
  // syntax `VALUES (?x ?y) { (<a> "b") }`) still bails because the
  // flat scanner cannot safely rewrite them.
  const { valuesClause, bodyAfterValues } = peelLeadingValues(inner);
  const scanTarget = bodyAfterValues ?? inner;

  // Refuse to rewrite shapes we cannot reason about without a real
  // SPARQL parser. Any of these tokens means there's a nested scope
  // whose subjects the flat scan below cannot see.
  //
  // `VALUES` is still in the list so we catch any non-leading /
  // multi-line / tuple VALUES clause the peeler declined to handle.
  if (/\{|\}/.test(scanTarget)) return null;
  if (/\b(GRAPH|OPTIONAL|UNION|MINUS|SERVICE|VALUES|FILTER\s+EXISTS|FILTER\s+NOT\s+EXISTS|SELECT)\b/i.test(scanTarget)) {
    return null;
  }

  // Strip SPARQL line comments (`# … \n`) so the dot accounting below
  // doesn't misclassify "# foo ." as a terminating triple — BUT leave
  // `#` fragments inside IRIs (`<…#…>`) and literals (`"…#…"`) alone.
  // The naive `/#[^\n]*/g` regex used here previously mangled the
  // extremely common `rdf:type` shape
  // `<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>` whenever
  // `_minTrust` was set, which fail-closes the entire query to `[]`
  // (PR #229 bot review round 7 — dkg-query-engine.ts:513).
  const innerCodeOnly = stripSparqlLineComments(scanTarget);
  const trimmedInner = innerCodeOnly.trim();
  if (trimmedInner.length === 0) return null;

  // Split on the top-level `.` separator to walk each triple pattern.
  // PR #229 bot review round 8 (dkg-query-engine.ts:576): use a
  // quote/IRI-aware tokenizer instead of a naive regex so `?s <p>
  // "hello. world"` isn't fragmented into broken statements that the
  // subject scanner then refuses, fail-closing `_minTrust` to `[]`
  // for every text/chat query. Rejoined dots are preserved for the
  // emitted query by the clause builder below.
  const statements = splitTopLevelTripleStatements(trimmedInner);

  const subjectVars = new Set<string>();
  const subjectIris = new Set<string>();
  const subjectPrefixed = new Set<string>();
  for (const stmt of statements) {
    // PR #229 bot review r3131942426 (dkg-query-engine.ts:754):
    // top-level `FILTER(...)` / `BIND(... AS ?x)` clauses share the
    // statement-list with triple patterns and have no subject token.
    // Pre-fix the subject regex below didn't match either keyword,
    // returned `null`, and `injectMinTrustFilter()` propagated `null`
    // — collapsing every query like
    //   SELECT ?s WHERE { ?s <p> ?o . FILTER(?o > 10) }
    // into an empty result whenever `minTrust > SelfAttested`.
    //
    // Skip these clauses in the subject scan: they don't introduce
    // new subjects and they survive verbatim because the rewritten
    // WHERE is built by appending trust-filter triples to the
    // *original* trimmed inner (see `rewrittenBody` below) — the
    // FILTER/BIND text stays exactly where the caller put it.
    //
    // Anti-recursion: only skip TOP-LEVEL FILTER/BIND. Nested ones
    // (e.g. `FILTER EXISTS { ... }`) are already rejected by the
    // `\{|\}` and `FILTER\s+EXISTS` checks at line 753 / 754, so
    // by the time we reach this loop we're guaranteed to be looking
    // at a flat FILTER(<expr>) or BIND(<expr> AS ?x).
    const stmtTrimmed = stmt.trim();
    if (/^FILTER\s*\(/i.test(stmtTrimmed) || /^BIND\s*\(/i.test(stmtTrimmed)) {
      continue;
    }
    // First non-whitespace token is the subject. Accept:
    //   - variable (`?x`, `$x`)
    //   - absolute IRI (`<urn:x>`)
    //   - blank node (`_:b`)
    //   - RDF literal (`"…"` with optional type/lang tag)
    //   - prefixed name (`ex:item`) — SPARQL `PNAME_LN` / `PNAME_NS`
    //     (PR #229 bot review round 11 / dkg-query-engine.ts:654;
    //     previous revisions fail-closed `_minTrust` to `[]` for
    //     every query that used standard `PREFIX ex: <urn:> …`
    //     syntax, which is the recommended SPARQL shape for exact
    //     entity lookups.)
    const m = stmt.match(
      /^\s*([?$]([A-Za-z_]\w*)|<[^>]+>|_:[A-Za-z_]\w*|"[^"]*"(?:\^\^<[^>]+>|@[A-Za-z-]+)?|[A-Za-z][\w-]*:[A-Za-z_][\w-]*|[A-Za-z][\w-]*:)/,
    );
    if (!m) return null;
    const subj = m[1];
    if (subj.startsWith('?') || subj.startsWith('$')) {
      subjectVars.add(subj);
      continue;
    }
    // Bot review (PR #229 follow-up, dkg-query-engine.ts:534):
    // exact-entity lookups like `SELECT ?o WHERE { <e> <p> ?o }` are
    // the most common SPARQL shape in DKG and must NOT fail closed on
    // `_minTrust`. The threshold is perfectly enforceable against a
    // concrete IRI: attach `<iri> <trustLevel> ?t . FILTER(?t >= N)`
    // to the rewritten WHERE. Blank-node and literal subjects remain
    // refused — neither can carry trust metadata in our ontology.
    if (subj.startsWith('<') && subj.endsWith('>')) {
      subjectIris.add(subj);
      continue;
    }
    // Prefixed name — treat like an IRI at the clause-emission stage.
    // The original query still carries the `PREFIX` declarations, so
    // emitting `ex:item <trustLevel> ?t . FILTER(...)` is valid SPARQL
    // at the same scope. Rejects `_:bn` (starts with `_:`) and
    // string literals (start with `"`) naturally because this branch
    // only runs when subj starts with a letter.
    if (/^[A-Za-z]/.test(subj) && subj.includes(':')) {
      subjectPrefixed.add(subj);
      continue;
    }
    // Blank-node / literal subject — cannot attach a trust filter.
    return null;
  }
  if (subjectVars.size === 0 && subjectIris.size === 0 && subjectPrefixed.size === 0) return null;

  const extraClauses: string[] = [];
  let i = 0;
  for (const subjectVar of subjectVars) {
    const trustVar = `?__dkgTrust${i++}`;
    extraClauses.push(
      `${subjectVar} <http://dkg.io/ontology/trustLevel> ${trustVar} . ` +
        `FILTER(<http://www.w3.org/2001/XMLSchema#integer>(STR(${trustVar})) >= ${minTrust})`,
    );
  }
  for (const subjectIri of subjectIris) {
    const trustVar = `?__dkgTrust${i++}`;
    extraClauses.push(
      `${subjectIri} <http://dkg.io/ontology/trustLevel> ${trustVar} . ` +
        `FILTER(<http://www.w3.org/2001/XMLSchema#integer>(STR(${trustVar})) >= ${minTrust})`,
    );
  }
  for (const subjectPfx of subjectPrefixed) {
    const trustVar = `?__dkgTrust${i++}`;
    extraClauses.push(
      `${subjectPfx} <http://dkg.io/ontology/trustLevel> ${trustVar} . ` +
        `FILTER(<http://www.w3.org/2001/XMLSchema#integer>(STR(${trustVar})) >= ${minTrust})`,
    );
  }

  // Bot review L2: the previous implementation unconditionally inserted
  // `" . "` between `inner.trim()` and the injected clauses, which
  // produced `... . . ?s <trustLevel> ...` when the original WHERE
  // already ended with a dot (the common case) — a SPARQL syntax error
  // that every rewritten query hit. Here we emit each rewritten triple
  // with its OWN dot and join them after the original inner block,
  // always with exactly one separating dot regardless of whether the
  // caller terminated their final triple pattern.
  const endsWithDot = /\.\s*$/.test(trimmedInner);
  const separator = endsWithDot ? ' ' : ' . ';
  const rewrittenBody = `${trimmedInner}${separator}${extraClauses.join(' ')}`;

  // r23-2: if the WHERE started with a `VALUES ?s { … }` clause the
  // peeler set aside, re-emit it at the top of the rewritten body so
  // the bindings it introduces still drive the trust-filtered BGP.
  const rewrittenInner = valuesClause
    ? `${valuesClause} ${rewrittenBody}`
    : rewrittenBody;

  const before = sparql.slice(0, braceStart + 1);
  const after = sparql.slice(braceEnd);
  return `${before} ${rewrittenInner} ${after}`;
}

/**
 * r23-2: peel a single leading top-level `VALUES ?var { … }` clause
 * off the WHERE body. Returns the clause text (verbatim, including the
 * trailing `}`) and the remainder so the caller can reason about
 * triples alone. If the WHERE does NOT start with a VALUES clause, or
 * the VALUES clause is multi-var (`VALUES (?x ?y) { (<a> "b") }`), has
 * unbalanced braces, or uses nested parentheses for row syntax, returns
 * `{ valuesClause: null, bodyAfterValues: null }` so the caller falls
 * back to refusing the query (the forbidden-tokens regex still trips
 * on `VALUES`).
 */
function peelLeadingValues(inner: string): {
  valuesClause: string | null;
  bodyAfterValues: string | null;
} {
  const withoutComments = stripSparqlLineComments(inner);
  const m = withoutComments.match(/^\s*VALUES\s+([?$][A-Za-z_]\w*)\s*\{/i);
  if (!m) return { valuesClause: null, bodyAfterValues: null };

  const openBraceRel = m[0].length - 1;
  let depth = 1;
  let i = openBraceRel + 1;
  let inString = false;
  let inIri = false;
  for (; i < withoutComments.length; i++) {
    const ch = withoutComments[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (inIri) {
      if (ch === '>') inIri = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '<') { inIri = true; continue; }
    if (ch === '(' || ch === ')') {
      // Row-tuple syntax — we can't reason about multi-var rows safely.
      return { valuesClause: null, bodyAfterValues: null };
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return { valuesClause: null, bodyAfterValues: null };

  const closeAbs = i;
  const valuesClause = withoutComments.slice(0, closeAbs + 1).trim();
  const bodyAfterValues = withoutComments.slice(closeAbs + 1);
  return { valuesClause, bodyAfterValues };
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

