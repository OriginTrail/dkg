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
   * assertions) and verified-memory (multiple quorum graphs).
   */
  graphPrefixes: string[];
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
  opts?: {
    agentAddress?: string;
    verifiedGraph?: string;
    assertionName?: string;
    /**
     * Spec §12/§14 trust-gradient filter. When set, the verified-memory
     * resolution narrows to anchored quorum sub-graphs
     * (`.../_verified_memory/…`) only — the root data graph is removed
     * because it can contain mixed-trust finalized data.
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
      if (opts?.verifiedGraph) {
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
      // Spec §12/§14 (P-13): when `minTrust` is set, drop the root data
      // graph — it may carry mixed-trust content — and return ONLY the
      // quorum-anchored `_verified_memory/` prefix. Downstream trust
      // enforcement (per-triple trustLevel filter) is handled when the
      // query is rewritten by the engine.
      if (opts?.minTrust !== undefined) {
        return {
          graphs: [],
          graphPrefixes: [`did:dkg:context-graph:${contextGraphId}/_verified_memory/`],
        };
      }
      return {
        graphs: [contextGraphDataUri(contextGraphId)],
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
      minTrust: options._minTrust,
    });

    const allGraphs = [...resolution.graphs];

    for (const prefix of resolution.graphPrefixes) {
      const discovered = await this.discoverGraphsByPrefix(prefix);
      allGraphs.push(...discovered);
    }

    if (allGraphs.length === 0) {
      return { bindings: [] };
    }

    // Spec §14 trust-gradient filter — only enforced on verified-memory
    // where on-chain-anchored trust metadata is expected to live.
    // When _minTrust is set, rewrite the query so every subject matched
    // by the user's pattern MUST carry an explicit
    // `http://dkg.io/ontology/trustLevel` literal whose integer value is
    // ≥ minTrust. Subjects with no trust metadata are rejected.
    //
    // Bot review L1: previously, when `injectMinTrustFilter()` could not
    // safely rewrite the query (e.g. explicit GRAPH, non-BGP first
    // clause, multi-subject WHERE), we silently ran the ORIGINAL
    // unfiltered SPARQL. That turned `_minTrust` into a no-op in exactly
    // the shapes most likely to span sensitive data, and a caller had
    // no signal that their trust threshold was being ignored. Now the
    // rewriter MUST succeed or we fail closed — returning an empty
    // bindings set is the correct behaviour for "no subject meets the
    // trust threshold" when we cannot prove the threshold was applied.
    let effectiveSparql = sparql;
    if (view === 'verified-memory' && options._minTrust !== undefined) {
      const rewritten = injectMinTrustFilter(sparql, options._minTrust);
      if (!rewritten) {
        console.warn(
          `[DKGQueryEngine] _minTrust=${options._minTrust} requested for a query shape ` +
            `injectMinTrustFilter cannot safely rewrite; returning empty result (fail-closed)`,
        );
        return { bindings: [] };
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

  // Refuse to rewrite shapes we cannot reason about without a real
  // SPARQL parser. Any of these tokens means there's a nested scope
  // whose subjects the flat scan below cannot see.
  if (/\{|\}/.test(inner)) return null;
  if (/\b(GRAPH|OPTIONAL|UNION|MINUS|SERVICE|VALUES|FILTER\s+EXISTS|FILTER\s+NOT\s+EXISTS|SELECT)\b/i.test(inner)) {
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
  const innerCodeOnly = stripSparqlLineComments(inner);
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
  for (const stmt of statements) {
    // First non-whitespace token is the subject.
    const m = stmt.match(/^\s*([?$]([A-Za-z_]\w*)|<[^>]+>|_:[A-Za-z_]\w*|"[^"]*"(?:\^\^<[^>]+>|@[A-Za-z-]+)?)/);
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
    // Blank-node / literal subject — cannot attach a trust filter.
    return null;
  }
  if (subjectVars.size === 0 && subjectIris.size === 0) return null;

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
  const rewrittenInner = `${trimmedInner}${separator}${extraClauses.join(' ')}`;

  const before = sparql.slice(0, braceStart + 1);
  const after = sparql.slice(braceEnd);
  return `${before} ${rewrittenInner} ${after}`;
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

