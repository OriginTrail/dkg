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
  emptyResultForSparql,
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
      //     silently rejected (fail-closed).
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
      return emptyResultForSparql(sparql);
    }

    // Spec §14 trust-gradient filter — only enforced on verified-memory
    // where on-chain-anchored trust metadata is expected to live.
    // When `minTrust` (or legacy `_minTrust`) is set, rewrite the query so
    // every subject matched by the user's pattern MUST carry an explicit
    // `http://dkg.io/ontology/trustLevel` literal whose integer value is
    // ≥ minTrust. Subjects with no trust metadata are rejected.
    //
    // previously, when `injectMinTrustFilter()` could not
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
    //
    // we ALSO skip the per-triple filter at `Endorsed`. The graph-
    // scope resolution above already drops the root data graph and
    // unions only over `<…>/_verified_memory/{quorum}` sub-graphs,
    // and any quad that landed in `_verified_memory` is by
    // definition at least `Endorsed` (the on-chain quorum that
    // promoted it IS the endorsement). Until the publisher / quorum
    // writers actually emit `dkg:trustLevel` literals (tracked
    // upstream), the per-triple join would silently turn every
    // legitimate `minTrust=Endorsed` query into an empty result.
    // Levels strictly above Endorsed (`PartiallyVerified`,
    // `ConsensusVerified`) still require the per-triple filter
    // because graph-scope alone cannot distinguish those tiers from
    // a basic Endorsed write — a fail-closed empty result there is
    // the correct behaviour until writers stamp the literal.
    if (
      view === 'verified-memory' &&
      effectiveMinTrust !== undefined &&
      effectiveMinTrust > TrustLevel.Endorsed
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
        return emptyResultForSparql(sparql);
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
 * Skip past a SPARQL string literal starting at `src[i]`, returning the
 * index immediately AFTER the closing quote.
 *
 * Recognises **all four** SPARQL 1.1 literal forms:
 *
 *   - `"…"`         single-line, double-quoted (escape: `\\`, `\"`, `\n`, …)
 *   - `'…'`         single-line, single-quoted (same escape grammar)
 *   - `"""…"""`     long-form, double-quoted (may span newlines, contains
 *                   raw `"`, `'`, `{`, `}`, `#`, `.` without escaping)
 *   - `'''…'''`     long-form, single-quoted (same as above)
 *
 * **Caller contract:** `src[i]` MUST be `"` or `'`; otherwise the function
 * returns `i` (no advance). The cursor returned points to the first byte
 * AFTER the literal, ready for the caller to resume its own scan.
 *
 * If a literal is unterminated (truncated input) the function consumes
 * the remainder of the string and returns `src.length`. Callers treat
 * unterminated literals as "the rest of the input is opaque payload",
 * which is the safe choice for structural scans (brace balancing,
 * keyword detection): we do NOT want a stray `{` near the end of a
 * truncated query body to confuse the surrounding scanner.
 *
 * dkg-query-engine.ts:848). The
 * previous helpers (`stripSparqlLineComments`, `scrubStringsAndComments`,
 * `findMatchingCloseBrace`, `findWhereBraceStart`, and
 * `splitTopLevelTripleStatements`) all had their own copy of the
 * single-line literal scanner and NONE recognised triple-quoted
 * literals, so a long-form payload like
 *
 *     SELECT ?t WHERE { ?s <p> """contains a {brace} and a #comment""" }
 *
 * leaked `{`, `}`, `#`, `.`, etc. through the structural scrubber and
 * the `minTrust` rewriter (and the SPARQL form classifier, and the
 * triple terminator splitter) misclassified payload as syntax. The
 * downstream effect was the same fail-closed empty result the
 * scrubbing was supposed to prevent. Centralising the lex here means
 * every helper that walks SPARQL source learns triple-quoted handling
 * in one place.
 */
export function skipSparqlStringLiteral(src: string, i: number): number {
  const n = src.length;
  if (i >= n) return i;
  const ch = src[i];
  if (ch !== '"' && ch !== "'") return i;
  // Long-form (triple-quoted) literal? Lookahead must match `ch ch ch`.
  if (i + 2 < n && src[i + 1] === ch && src[i + 2] === ch) {
    let j = i + 3;
    while (j < n) {
      // SPARQL 1.1 long-string grammar (§19.8 STRING_LITERAL_LONG*) allows
      // `\<x>` style ECHAR escapes — skip the escaped byte so a `\\"` or
      // a `\\'` does not prematurely terminate. Between escapes, look for
      // the triple-quote terminator.
      if (src[j] === '\\' && j + 1 < n) { j += 2; continue; }
      if (
        src[j] === ch &&
        j + 2 < n &&
        src[j + 1] === ch &&
        src[j + 2] === ch
      ) {
        return j + 3;
      }
      j++;
    }
    return n;
  }
  // Short-form (single-line) literal. SPARQL 1.1 STRING_LITERAL1/2 forbid
  // unescaped newlines, but we still defensively bail on EOL just like
  // the previous helpers did.
  let j = i + 1;
  while (j < n) {
    if (src[j] === '\\' && j + 1 < n) { j += 2; continue; }
    if (src[j] === ch) { return j + 1; }
    j++;
  }
  return j;
}

/**
 * Token-aware locator for the explicit `WHERE` keyword at the
 * top-level of a SPARQL query. Mirrors the lex rules used by
 * {@link findMatchingCloseBrace} / the fallback path in
 * {@link findWhereBraceStart}: skips line comments (`# ... \n`),
 * single/double/triple-quoted string literals (via
 * {@link skipSparqlStringLiteral}), and IRIREFs (`<...>`) so the
 * `WHERE` substring can NOT be sourced from inside any of those
 * payload contexts. The `<` token is disambiguated as IRI-start
 * vs less-than via the same next-byte allow-list as
 * {@link findWhereBraceStart}'s fallback.
 *
 * Returns the index of the `W` of the `WHERE` keyword, or `-1` if
 * none is found at top level. Case-insensitive on the keyword
 * itself, but the surrounding word boundary is enforced (so
 * identifiers like `WHEREVER` / `aWHERE` do NOT match).
 */
function findExplicitWhereTokenIdx(sparql: string): number {
  const n = sparql.length;
  const isWordStart = (c: string): boolean =>
    (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
  const isWordCont = (c: string): boolean =>
    (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
    (c >= '0' && c <= '9') || c === '_';
  const isIriStartFirstByte = (c: string): boolean => {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return true;
    return c === '#' || c === '_' || c === '/' || c === '.';
  };
  const isIriStart = (idx: number): boolean => {
    const next = sparql[idx + 1];
    if (next === undefined) return false;
    if (!isIriStartFirstByte(next)) return false;
    for (let j = idx + 1; j < n; j++) {
      const c = sparql[j];
      if (c === '>') return true;
      if (
        c === '<' || c === '"' || c === '{' || c === '}' ||
        c === '|' || c === '\\' || c === '^' || c === '`' ||
        /\s/.test(c)
      ) return false;
    }
    return false;
  };

  let i = 0;
  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      if (isIriStart(i)) {
        const end = sparql.indexOf('>', i + 1);
        if (end === -1) return -1;
        i = end + 1;
        continue;
      }
      i++;
      continue;
    }
    if (isWordStart(ch)) {
      // Word boundary check: previous char (if any) must NOT be a
      // word-continuation byte. The outer lexer already skipped
      // comments/strings/IRIs, so a non-word predecessor means we're
      // at a real keyword start.
      const prev = i > 0 ? sparql[i - 1] : '';
      if (prev && isWordCont(prev)) {
        // Mid-identifier — skip the rest of the word.
        let j = i + 1;
        while (j < n && isWordCont(sparql[j])) j++;
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < n && isWordCont(sparql[j])) j++;
      const word = sparql.substring(i, j);
      if (word.length === 5 && word.toUpperCase() === 'WHERE') {
        return i;
      }
      i = j;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Find the next significant `{` after a given index, skipping
 * whitespace AND line comments (`# … \n`) but NOT string literals
 * — SPARQL grammar does not allow a string literal between the
 * `WHERE` keyword and its opening `{`, so encountering one means
 * the input is malformed and we should bail (return `-1`).
 */
function nextSignificantBraceAfter(sparql: string, startIdx: number): number {
  const n = sparql.length;
  let i = startIdx;
  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '{') return i;
    return -1;
  }
  return -1;
}

/**
 * Locate the opening `{` of the WHERE clause in a SPARQL query.
 *
 * SPARQL 1.1 (§16) allows the `WHERE` keyword to be omitted from
 * `SELECT`, `DESCRIBE`, and `ASK` queries, and from the second
 * `GroupGraphPattern` of a `CONSTRUCT`. The legacy callers (`wrapWithGraph`,
 * `wrapWithGraphUnion`, `injectMinTrustFilter`) all matched only
 * `WHERE\s*\{`, so any of those legitimate shorthand forms left the
 * query untouched (no GRAPH wrapping, no trust filter injection) and —
 * on a `verified-memory` view whose data lives in a named sub-graph —
 * silently returned `[]` instead of executing against the right graph.
 *
 * Strategy:
 *   1. Prefer the explicit `WHERE { ... }` form.
 *   2. Otherwise, walk top-level braces (skipping IRIs / quoted
 *      strings / comments) and use the LAST top-level `{...}`. This
 *      is correct for every form:
 *        - `SELECT ?x { ... }`           (1 top-level brace)
 *        - `ASK { ... }`                 (1)
 *        - `DESCRIBE ?x { ... }`         (1)
 *        - `CONSTRUCT { tmpl } { where }`(2 — last is the WHERE)
 *      `CONSTRUCT WHERE { ... }` already matches the primary path.
 *
 * Returns `null` when no top-level `{...}` block is balanced.
 */
function findWhereBraceStart(sparql: string): number {
  // The earlier fast path used a raw regex `/\bWHERE\s*\{/i` which
  // matches ANY `WHERE` followed by `{` — including ones embedded inside
  // string literals or comments. Adversarial / obfuscated input
  // like
  //   SELECT ("WHERE {" AS ?x) WHERE { ... }
  // would have the regex hit the literal substring inside the
  // SELECT projection, then `sparql.indexOf('{', whereIdx)` would
  // grab the brace just past the literal — and every later
  // injection (`wrapWithGraph` / `injectMinTrustFilter`) would
  // rewrite the wrong block, in some cases producing an invalid
  // query and in others silently filtering against a string-literal
  // expression rather than the actual WHERE clause.
  //
  // Fix: locate the explicit `WHERE` token using the SAME token-
  // aware scanner the fallback already uses (skips line comments,
  // single/double/triple-quoted string literals, and IRIREFs;
  // disambiguates `<` as IRI-start vs less-than via the next-byte
  // allow-list below). Then advance past inter-keyword whitespace
  // (and any line comments) before reading the `{`.
  const whereTokenIdx = findExplicitWhereTokenIdx(sparql);
  if (whereTokenIdx !== -1) {
    const idx = nextSignificantBraceAfter(sparql, whereTokenIdx + 'WHERE'.length);
    return idx;
  }

  // Fallback: scan for top-level `{` while honouring SPARQL token
  // boundaries — IRIs (`<...>`), quoted literals, and `#` comments
  // can all contain stray `{` chars that the regex would
  // misinterpret as block openers.
  //
  // dkg-query-engine.ts:559). The classifier rejects obvious
  // comparison shapes after `<` and falls back to a forward scan
  // that confirms a balanced IRIREF body. The r30 cut only rejected
  // `=`, `<`, and whitespace — a pure forward scan from `<` in
  // compact comparison syntax like
  //   `FILTER(?n<10&&?m>5)`
  // walks `1`, `0`, `&`, `&`, `?`, `m` (none of which are
  // IRIREF-forbidden per the SPARQL grammar
  // `[^<>"{}|^`\]-[#x00-#x20]`) and lands on `>`, mis-classifying
  // the entire `<10&&?m>` as an IRI. The forward scan therefore
  // CANNOT be trusted alone for compact `<` operators that operate
  // on numerics / variables / sub-expressions whose body bytes are
  // all IRIREF-legal.
  //
  // r30+ resolution: combine an EXPLICIT next-byte allow-list of
  // characters that can validly start a real-world SPARQL IRIREF
  // (ALPHA for absolute IRIs `http:` / `urn:` / `did:` / `file:` /
  // `_blank-node:`, `#` for fragment-only relatives, `_` for the
  // legacy blank-node-as-IRI shape, `/` for path-only relatives,
  // and `.` for path-relative IRIs) with the existing
  // forbidden-byte forward scan. Anything else after `<` is treated
  // as a comparison and we advance by ONE byte. This bails fast on
  // every `<digit`, `<?var`, `<$var`, `<(...)`, `<"lit"`, `<-1`,
  // `<+1`, `<&`, `<|`, `<!`, `<*`, `<=`, `<<` shape — i.e. the
  // full set of SPARQL operator contexts in which `<` is overloaded
  // as less-than.
  //
  // Note: this is INTENTIONALLY stricter than the SPARQL grammar
  // (which technically allows `<10>` as an IRIREF). Real-world
  // SPARQL queries don't write bare-digit IRIs; falling out of the
  // IRI branch here just means we treat `<` as a comparison and
  // advance one byte, which is the safe behaviour for the brace
  // scan we actually care about.
  const isIriStartFirstByte = (c: string): boolean => {
    // ASCII letter? (covers every absolute IRI scheme — `http:`,
    // `urn:`, `did:`, `file:`, `mailto:`, `tag:`, `data:`, …).
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return true;
    // `#fragment` (SPARQL allows fragment-only relative IRIREFs
    // when the base IRI is set by the query environment), `_blah`
    // (legacy blank-node-as-IRI), `/path` (path-only relative),
    // `.something` (path-relative). Everything else is a comparison
    // operator context.
    return c === '#' || c === '_' || c === '/' || c === '.';
  };
  const isIriStart = (idx: number): boolean => {
    const next = sparql[idx + 1];
    if (next === undefined) return false;
    if (!isIriStartFirstByte(next)) return false;
    for (let j = idx + 1; j < n; j++) {
      const c = sparql[j];
      if (c === '>') return true;
      // Any IRIREF-forbidden character before `>` proves this `<`
      // is a comparison, not the start of an IRI.
      if (
        c === '<' ||
        c === '"' ||
        c === '{' ||
        c === '}' ||
        c === '|' ||
        c === '\\' ||
        c === '^' ||
        c === '`' ||
        /\s/.test(c)
      ) {
        return false;
      }
    }
    return false;
  };

  const n = sparql.length;
  const opens: number[] = [];
  let depth = 0;
  let i = 0;
  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '<') {
      if (isIriStart(i)) {
        const end = sparql.indexOf('>', i + 1);
        if (end === -1) return -1;
        i = end + 1;
        continue;
      }
      // Comparison operator — advance one byte and keep scanning.
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // dkg-query-engine.ts:848).
      // Centralised triple-quoted-aware skip — see skipSparqlStringLiteral.
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '{') {
      if (depth === 0) opens.push(i);
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth < 0) return -1;
    }
    i++;
  }
  if (depth !== 0 || opens.length === 0) return -1;
  return opens[opens.length - 1];
}

/**
 * Locate the matching `}` for the `{` at `openIdx`, while skipping over
 * `{` / `}` chars that appear inside SPARQL string literals, line
 * comments, or IRIREFs.
 *
 * — dkg-query-engine.ts:939). The naive
 * brace-balance loop in `injectMinTrustFilter`, `wrapWithGraph`, and
 * `wrapWithGraphUnion` counted `{`/`}` blindly. A query like
 *
 *     SELECT ?t WHERE { ... FILTER(STR(?t) = "{") }
 *
 * has a literal `{` inside a string literal and a single closing `}`
 * for the WHERE block, so the naive counter ended at depth 1 and
 * returned `-1`. Every caller treated `-1` as "refuse to rewrite" and
 * (for `injectMinTrustFilter`) silently fail-closed `minTrust >
 * Endorsed` queries to an empty result — exactly the literal-heavy
 * shape the surrounding scrubbing was supposed to enable.
 *
 * Returns `-1` if `sparql[openIdx]` is not `{` or no matching close
 * exists at depth zero.
 */
function findMatchingCloseBrace(sparql: string, openIdx: number): number {
  if (sparql[openIdx] !== '{') return -1;
  const n = sparql.length;
  let depth = 0;
  let i = openIdx;
  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      // Line comment — skip to newline.
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Centralised triple-quoted-aware skip.
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      // Look ahead for a balanced `>` that delimits an IRIREF body.
      // IRIREFs cannot contain whitespace or any of `<{}|"^\``, so a
      // candidate range that contains those chars is treated as a
      // comparison operator and we fall through to a single-byte
      // advance. (Mirror of the IRI/comparison disambiguation in
      // `findWhereBraceStart`.)
      let foundIri = false;
      for (let j = i + 1; j < n; j++) {
        const c = sparql[j];
        if (c === '>') { foundIri = true; i = j + 1; break; }
        if (
          c === '<' || c === '"' || c === '{' || c === '}' ||
          c === '|' || c === '\\' || c === '^' || c === '`' ||
          /\s/.test(c)
        ) {
          break;
        }
      }
      if (foundIri) continue;
      // Comparison operator — advance one byte.
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
    i++;
  }
  return -1;
}

/**
 * Wraps a SELECT query to scope it to a named graph.
 * If the query already uses GRAPH patterns, returns it unchanged.
 */
function wrapWithGraph(sparql: string, graphUri: string): string {
  if (sparql.toLowerCase().includes('graph ')) return sparql;

  const braceStart = findWhereBraceStart(sparql);
  if (braceStart === -1) return sparql;

  // — dkg-query-engine.ts:939). Use the
  // literal/comment/IRI-aware helper so a `{` or `}` inside a SPARQL
  // string literal, line comment, or IRI does NOT confuse the depth
  // counter and we stop wrapping queries with literal-heavy bodies.
  const braceEnd = findMatchingCloseBrace(sparql, braceStart);
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
 * the previous revision injected
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

  const braceStart = findWhereBraceStart(sparql);
  if (braceStart === -1) return sparql;

  // — dkg-query-engine.ts:939). See
  // `findMatchingCloseBrace` and the `wrapWithGraph` cousin above.
  const braceEnd = findMatchingCloseBrace(sparql, braceStart);
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
 * The rewriter scans the WHERE block for top-level triple patterns
 * and collects every distinct subject variable so multi-subject
 * queries like `?a <p> ?o . ?b <q> ?r` have BOTH `?a` and `?b`
 * trust-filtered.
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
 * Callers treat `null` as "refuse to run".
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
      // Centralised triple-quoted-aware skip.
      const j = skipSparqlStringLiteral(src, i);
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
 * Replace every SPARQL string literal and `# …` comment in `src`
 * with neutral whitespace, preserving overall byte length. IRIs and
 * code tokens are passed through verbatim. The returned string is
 * suitable for STRUCTURAL CHECKS (brace balancing, keyword scans)
 * that must not be confused by user payloads such as
 * `"{json: 1}"` or `# OPTIONAL: ...`.
 *
 * Triple-quoted
 * (`"""…"""` / `'''…'''`) literals are NOT recognised because
 * `injectMinTrustFilter`'s outer pipeline already refuses any WHERE
 * carrying tokens from the multi-line literal grammar (FILTER EXISTS,
 * SELECT inside, etc.).
 */
function scrubStringsAndComments(src: string): string {
  const n = src.length;
  const buf: string[] = new Array(n);
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '<') {
      const end = src.indexOf('>', i + 1);
      if (end === -1) {
        for (let k = i; k < n; k++) buf[k] = src[k];
        return buf.join('');
      }
      for (let k = i; k <= end; k++) buf[k] = src[k];
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Centralised triple-quoted-aware skip.
      const j = skipSparqlStringLiteral(src, i);
      for (let k = i; k < j; k++) buf[k] = src[k] === '\n' ? '\n' : ' ';
      i = j;
      continue;
    }
    if (ch === '#') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      for (let k = i; k < end; k++) buf[k] = ' ';
      i = end;
      continue;
    }
    buf[i] = ch;
    i++;
  }
  return buf.join('');
}

/**
 * Split a SPARQL WHERE body on **top-level** triple terminators, i.e.
 * dots that live outside quoted literals and outside IRI angle
 * brackets. The earlier `/\.(?=\s|$)/` regex broke on literal dots
 * in messages like `?s <p> "hello. world"`, silently fragmenting
 * the statement so the subject scanner returned garbage and
 * `_minTrust` fail-closed to `[]` for every text/chat query. This
 * tokenizer walks the body character
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
      // Centralised triple-quoted-aware skip.
      i = skipSparqlStringLiteral(body, i);
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
  // The
  // pre-fix rewriter only recognised `WHERE\s*\{`, so SPARQL 1.1
  // shorthand forms (`SELECT ?x { … }`, `ASK { … }`,
  // `DESCRIBE ?x { … }`, `CONSTRUCT { tmpl } { where }`) returned
  // `null` and the `minTrust > Endorsed` caller silently fell
  // through to an empty result. `findWhereBraceStart` normalises
  // every shape to the WHERE-clause brace position before we apply
  // the existing depth-counting pass below.
  const braceStart = findWhereBraceStart(sparql);
  if (braceStart === -1) return null;

  // — dkg-query-engine.ts:939). The
  // earlier brace-balance loop counted `{`/`}` inside SPARQL string
  // literals (e.g. `FILTER(STR(?t) = "{")`), so a literal-heavy WHERE
  // ended at depth 1 and `injectMinTrustFilter` returned `null` —
  // which the `_minTrust > Endorsed` caller treats as "refuse to run"
  // and silently fails closed. Use the literal/comment/IRI-aware
  // helper so the brace boundaries match what SPARQL actually
  // parses.
  const braceEnd = findMatchingCloseBrace(sparql, braceStart);
  if (braceEnd === -1) return null;

  const inner = sparql.slice(braceStart + 1, braceEnd);

  // A
  // leading top-level `VALUES` clause is the canonical SPARQL shape
  // for batched exact-subject lookups:
  //
  //     SELECT ?o WHERE {
  //       VALUES ?s { <a> <b> <c> }
  //       ?s <p> ?o .
  //     }
  //
  // the forbidden-tokens regex treated any VALUES as
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

  // — dkg-query-engine.ts:851).
  // Pre-fix the unsupported-nesting guard `/\{|\}/.test(scanTarget)`
  // and the keyword guard below ran on the RAW WHERE body. Any
  // `{`, `}`, or sensitive keyword that happened to appear inside a
  // SPARQL string literal (`"{json: 1}"`, `"OPTIONAL field"`,
  // `"SELECT * FROM x"`) or inside a `# …` line comment caused the
  // rewriter to bail out and the caller fell through to
  // `emptyResultForSparql(...)`. That silently fail-closed every
  // legitimate high-trust query whose payload happened to mention
  // those tokens — text/JSON/log content is the most common case.
  //
  // Scrub literals and comments to neutral spaces BEFORE the
  // structural / keyword checks so they only see real code tokens.
  // IRIs are preserved verbatim because IRIREF grammar already
  // forbids `{`, `}`, `"`, and the keyword tokens we care about.
  const codeView = scrubStringsAndComments(scanTarget);
  if (/[{}]/.test(codeView)) return null;
  if (
    /\b(GRAPH|OPTIONAL|UNION|MINUS|SERVICE|VALUES|FILTER\s+EXISTS|FILTER\s+NOT\s+EXISTS|SELECT)\b/i.test(codeView)
  ) {
    return null;
  }

  // Strip SPARQL line comments (`# … \n`) so the dot accounting below
  // doesn't misclassify "# foo ." as a terminating triple — BUT leave
  // `#` fragments inside IRIs (`<…#…>`) and literals (`"…#…"`) alone.
  // The naive `/#[^\n]*/g` regex used here previously mangled the
  // extremely common `rdf:type` shape
  // `<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>` whenever
  // `_minTrust` was set, which fail-closes the entire query to `[]`
  // .
  const innerCodeOnly = stripSparqlLineComments(scanTarget);
  const trimmedInner = innerCodeOnly.trim();
  if (trimmedInner.length === 0) return null;

  // Split on the top-level `.` separator to walk each triple pattern.
  // use a
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
    //   - prefixed name (`ex:item`) — SPARQL `PNAME_LN` / `PNAME_NS`.
    //     Earlier revisions fail-closed `_minTrust` to `[]` for
    //     every query that used standard `PREFIX ex: <urn:> …`
    //     syntax, which is the recommended SPARQL shape for exact
    //     entity lookups.
    const m = stmt.match(
      /^\s*([?$]([A-Za-z_]\w*)|<[^>]+>|_:[A-Za-z_]\w*|"[^"]*"(?:\^\^<[^>]+>|@[A-Za-z-]+)?|[A-Za-z][\w-]*:[A-Za-z_][\w-]*|[A-Za-z][\w-]*:)/,
    );
    if (!m) return null;
    const subj = m[1];
    if (subj.startsWith('?') || subj.startsWith('$')) {
      subjectVars.add(subj);
      continue;
    }
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

  // the previous implementation unconditionally inserted
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

  // if the WHERE started with a `VALUES ?s { … }` clause the
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
 * peel a single leading top-level `VALUES ?var { … }` clause
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

