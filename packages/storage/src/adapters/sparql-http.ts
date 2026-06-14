/**
 * SparqlHttpStore — TripleStore adapter for any SPARQL 1.1 Protocol endpoint.
 *
 * Uses standard W3C SPARQL 1.1 Protocol "direct POST":
 * - Query: POST to queryEndpoint (Content-Type: application/sparql-query, raw body)
 * - Update: POST to updateEndpoint (Content-Type: application/sparql-update, raw body)
 *
 * Direct POST (not URL-encoded form data) avoids server-side form-size caps
 * such as Jetty's maxFormContentSize (~200 KB on stock Blazegraph), which
 * otherwise rejects large queries/updates with HTTP 400.
 *
 * Works with Oxigraph server, Apache Jena Fuseki, GraphDB, Blazegraph,
 * Amazon Neptune, Stardog, and any SPARQL 1.1–compliant server.
 *
 * Example (Oxigraph server):
 *   queryEndpoint: 'http://127.0.0.1:7878/query'
 *   updateEndpoint: 'http://127.0.0.1:7878/update'
 *
 * Example (single URL for both, e.g. Blazegraph):
 *   queryEndpoint: 'http://127.0.0.1:9999/blazegraph/namespace/kb/sparql'
 *   updateEndpoint: same URL
 */

import type {
  TripleStore,
  Quad as DKGQuad,
  QueryOptions,
  QueryResult,
  SelectResult,
  ConstructResult,
  AskResult,
} from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';
import { performance } from 'node:perf_hooks';

/**
 * Monotonic clock for the listGraphs cache TTL. Unlike `Date.now()`,
 * `performance.now()` never moves backwards on an NTP step / VM resume / manual
 * clock change, so the TTL can't be silently extended past its window (which
 * would defeat the outage re-validation guarantee).
 */
const monotonicNow = (): number => performance.now();

function composeAbortSignals(
  primary: AbortSignal | undefined,
  secondary: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const AnyImpl = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (AnyImpl) return AnyImpl([primary, secondary]);
  const combined = new AbortController();
  let settled = false;
  const cleanup = () => {
    primary.removeEventListener('abort', forwardPrimary);
    secondary.removeEventListener('abort', forwardSecondary);
  };
  const forwardPrimary = () => {
    if (settled) return;
    settled = true;
    cleanup();
    combined.abort(primary.reason);
  };
  const forwardSecondary = () => {
    if (settled) return;
    settled = true;
    cleanup();
    combined.abort(secondary.reason);
  };
  if (primary.aborted) combined.abort(primary.reason);
  else if (secondary.aborted) combined.abort(secondary.reason);
  else {
    primary.addEventListener('abort', forwardPrimary, { once: true });
    secondary.addEventListener('abort', forwardSecondary, { once: true });
  }
  return combined.signal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

function raceAgainstAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * R6-A: how long a managed-endpoint `listGraphs()` result may be served from
 * cache before it is re-validated against the store. The cache is also cleared
 * eagerly on every local write, so this TTL only bounds *non-write* staleness:
 * it collapses the peer-churn-driven burst of reconcile enumerations to at most
 * one scan per window (the actual CPU win) while guaranteeing the graph set is
 * re-read at least this often — so a managed-store outage/restart surfaces
 * within the window instead of being masked indefinitely (review round 1).
 */
export const LIST_GRAPHS_CACHE_TTL_MS = 30_000;

export interface SparqlHttpStoreOptions {
  /** SPARQL query endpoint URL (required). */
  queryEndpoint: string;
  /** SPARQL update endpoint URL. Defaults to queryEndpoint if omitted (for stores that use one URL). */
  updateEndpoint?: string;
  /** Request timeout in ms. Default 30_000. */
  timeout?: number;
  /** Optional Authorization header value (e.g. "Bearer <token>" or "Basic <base64>"). */
  auth?: string;
  /**
   * True when the daemon owns this endpoint end-to-end (a CLI-managed local
   * `oxigraph-server`, signalled by `oxigraph-managed.ts`). When set, no
   * external writer can mutate the store behind our back, so `listGraphs()`
   * is served from an in-memory cache that is invalidated on every local
   * write AND expires after {@link LIST_GRAPHS_CACHE_TTL_MS}. This kills the
   * data-proportional `SELECT DISTINCT ?g` full scan that the 30 s host-mode
   * reconcile (and on-demand CG enumeration) would otherwise re-run every
   * cycle on an idle, data-rich node (R6-A).
   *
   * Leave false/undefined for operator-provided endpoints: a shared/external
   * SPARQL server can gain graphs we did not write, which the cache would
   * miss — so caching is unsafe there and `listGraphs()` always queries.
   */
  managedByDkg?: boolean;
  /**
   * Clock for the `listGraphs()` cache TTL. Test seam only; defaults to the
   * monotonic {@link monotonicNow} (`performance.now`), never `Date.now`, so a
   * backwards wall-clock jump can't extend the cache past its TTL.
   */
  now?: () => number;
}

export class SparqlHttpStore implements TripleStore {
  readonly queryCancellation = 'interruptible' as const;

  private readonly queryEndpoint: string;
  private readonly updateEndpoint: string;
  private readonly timeout: number;
  private readonly headers: Record<string, string>;

  /** R6-A: cache `listGraphs()` only for daemon-owned (managed) endpoints. */
  private readonly cacheGraphList: boolean;
  /** Monotonic clock for the cache TTL (defaults to performance.now). */
  private readonly now: () => number;
  /** Cached graph-name list; null = not built / invalidated by a write. */
  private graphListCache: string[] | null = null;
  /** Wall-clock (via {@link now}) when {@link graphListCache} was last built. */
  private graphListCacheAt = 0;
  /**
   * Bumped on every local write. `listGraphs()` captures it before its
   * async query and only stores the result if it is unchanged on return —
   * so a write that lands while a rebuild is in flight discards the
   * possibly-stale result instead of caching it.
   */
  private graphListCacheGen = 0;
  /**
   * In-flight rebuild promise (managed endpoints). Concurrent callers on a
   * cold/expired cache share this single scan instead of each issuing their
   * own `SELECT DISTINCT ?g` — without it, a burst of overlapping enumerations
   * (reconcile + metrics CG-count + status) at startup or each TTL boundary
   * would still run duplicate full scans, the exact load this fix targets.
   */
  private graphListInflight: Promise<string[]> | null = null;
  /**
   * The generation {@link graphListInflight} was started at. A caller may only
   * join the in-flight scan when this still equals {@link graphListCacheGen};
   * a write that bumps the generation mid-scan means the in-flight result is
   * pre-write, so a later caller must start a fresh scan rather than observe a
   * stale graph set (read-your-writes).
   */
  private graphListInflightGen = -1;

  constructor(options: SparqlHttpStoreOptions) {
    if (!options.queryEndpoint?.trim()) {
      throw new Error('sparql-http adapter requires options.queryEndpoint');
    }
    this.queryEndpoint = options.queryEndpoint.replace(/\/$/, '');
    this.updateEndpoint = (options.updateEndpoint ?? options.queryEndpoint).replace(/\/$/, '');
    this.timeout = options.timeout ?? 30_000;
    this.cacheGraphList = options.managedByDkg === true;
    this.now = options.now ?? monotonicNow;
    // Content-Type is set per-request in postQuery/postUpdate (direct POST:
    // application/sparql-query | application/sparql-update). Only shared
    // headers (e.g. Authorization) belong here.
    this.headers = {};
    if (options.auth) {
      this.headers['Authorization'] = options.auth;
    }
  }

  /**
   * Invalidate the cached graph list after a local write. A no-op when
   * caching is disabled (external endpoints). Bumping the generation also
   * causes any concurrently in-flight `listGraphs()` rebuild to drop its
   * result rather than cache a pre-write snapshot.
   */
  private invalidateGraphListCache(): void {
    if (!this.cacheGraphList) return;
    this.graphListCache = null;
    this.graphListCacheGen++;
  }

  private async postQuery(sparql: string, accept: string, options?: QueryOptions): Promise<Response> {
    // Direct POST (W3C SPARQL 1.1 Protocol §2.1.3): the query is the raw
    // request body with `application/sparql-query`, not URL-encoded form
    // data. Form-encoded bodies (`query=...`) are parsed by the server's
    // form handler, which on Jetty-backed stores (Blazegraph) caps at
    // `maxFormContentSize` (~200 KB) and rejects larger payloads with
    // HTTP 400 "Unable to parse form content". The direct-POST body is not
    // form parsed, so large queries are not capped.
    const timeoutSignal = AbortSignal.timeout(this.timeout);
    const signal = composeAbortSignals(options?.signal, timeoutSignal) ?? timeoutSignal;
    const res = await fetch(this.queryEndpoint, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/sparql-query', Accept: accept },
      body: sparql,
      signal,
    });
    return res;
  }

  private async postUpdate(update: string): Promise<Response> {
    // Direct POST (W3C SPARQL 1.1 Protocol §2.2.2): the update is the raw
    // request body with `application/sparql-update`, not URL-encoded form
    // data. See postQuery for why form encoding breaks large payloads.
    const res = await fetch(this.updateEndpoint, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/sparql-update' },
      body: update,
      signal: AbortSignal.timeout(this.timeout),
    });
    return res;
  }

  async insert(quads: DKGQuad[]): Promise<void> {
    if (quads.length === 0) return;
    const byGraph = new Map<string, DKGQuad[]>();
    for (const q of quads) {
      const g = q.graph || '';
      if (!byGraph.has(g)) byGraph.set(g, []);
      byGraph.get(g)!.push(q);
    }
    const parts: string[] = [];
    for (const [graph, list] of byGraph) {
      const triples = list.map((q) => `${formatTerm(q.subject)} <${escapeUri(q.predicate)}> ${formatTerm(q.object)} .`).join('\n    ');
      if (graph) {
        parts.push(`GRAPH <${escapeUri(graph)}> {\n    ${triples}\n  }`);
      } else {
        parts.push(triples);
      }
    }
    const update = `INSERT DATA {\n  ${parts.join('\n  ')}\n}`;
    const res = await this.postUpdate(update);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP insert failed (${res.status}): ${text.slice(0, 300)}`);
    }
    this.invalidateGraphListCache(); // a new graph may have appeared
  }

  async delete(quads: DKGQuad[]): Promise<void> {
    if (quads.length === 0) return;
    // SPARQL forbids blank nodes in `DELETE DATA` — a spec-compliant endpoint
    // (Oxigraph, Fuseki, …) rejects the whole statement with HTTP 400 if any
    // quad's subject or object is a blank node. `buildBlankNodeSafeDelete`
    // keeps ground quads on the fast `DELETE DATA` path and removes
    // blank-node quads with `DELETE { … } WHERE { … }` (blank nodes rewritten
    // to variables) — the only spec-legal way to target existing blank-node
    // structure over the SPARQL protocol. See the helper for details.
    const update = buildBlankNodeSafeDelete(quads);
    if (!update) return;
    const res = await this.postUpdate(update);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP delete failed (${res.status}): ${text.slice(0, 300)}`);
    }
    this.invalidateGraphListCache(); // a graph may now be empty (gone from listGraphs)
  }

  async deleteByPattern(pattern: Partial<DKGQuad>): Promise<number> {
    const graphUri = pattern.graph;
    const before = await this.countQuads(graphUri);
    const s = pattern.subject ? `<${escapeUri(pattern.subject)}>` : '?s';
    const p = pattern.predicate ? `<${escapeUri(pattern.predicate)}>` : '?p';
    const o = pattern.object ? formatTerm(pattern.object) : '?o';
    const triple = `${s} ${p} ${o}`;
    let update: string;
    if (graphUri) {
      update = `DELETE { GRAPH <${escapeUri(graphUri)}> { ${triple} } } WHERE { GRAPH <${escapeUri(graphUri)}> { ${triple} } }`;
    } else {
      // The DELETE template must use the `GRAPH` keyword — `{ ?g_ctx { … } }`
      // is a syntax error that a spec-compliant endpoint rejects with HTTP 400.
      update = `DELETE { GRAPH ?g_ctx { ${triple} } } WHERE { GRAPH ?g_ctx { ${triple} } }`;
    }
    const res = await this.postUpdate(update);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP deleteByPattern failed (${res.status}): ${text.slice(0, 300)}`);
    }
    this.invalidateGraphListCache(); // a graph may now be empty (gone from listGraphs)
    const after = await this.countQuads(graphUri);
    return Math.max(0, before - after);
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string): Promise<number> {
    const before = await this.countQuads(graphUri);
    const escapedPrefix = escapeString(prefix);
    const update = `DELETE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } } WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${escapedPrefix}")) } }`;
    const res = await this.postUpdate(update);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP deleteBySubjectPrefix failed (${res.status}): ${text.slice(0, 300)}`);
    }
    this.invalidateGraphListCache(); // the graph may now be empty (gone from listGraphs)
    const after = await this.countQuads(graphUri);
    return Math.max(0, before - after);
  }

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    throwIfAborted(options?.signal);
    const trimmed = sparql.trim();
    const upper = trimmed.toUpperCase();
    const isAsk = upper.startsWith('ASK');
    const isConstruct = upper.startsWith('CONSTRUCT') || upper.startsWith('DESCRIBE');

    if (isConstruct) {
      return this.queryConstruct(trimmed, options);
    }

    const res = await this.postQuery(trimmed, 'application/sparql-results+json', options);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP query failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as W3CSelectResponse | W3CAskResponse;

    if (isAsk || 'boolean' in json) {
      return { type: 'boolean', value: (json as W3CAskResponse).boolean } satisfies AskResult;
    }

    const sr = json as W3CSelectResponse;
    const vars = sr.head?.vars ?? [];
    const bindings: Array<Record<string, string>> = (sr.results?.bindings ?? []).map((row) => {
      const obj: Record<string, string> = {};
      for (const v of vars) {
        const cell = row[v];
        if (cell) obj[v] = w3cTermToString(cell);
      }
      return obj;
    });
    return { type: 'bindings', bindings } satisfies SelectResult;
  }

  private async queryConstruct(sparql: string, options?: QueryOptions): Promise<ConstructResult> {
    const res = await this.postQuery(sparql, 'application/n-quads, text/n-quads', options);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP construct failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const text = await res.text();
    const quads = parseNQuadsText(text);
    return { type: 'quads', quads };
  }

  async hasGraph(graphUri: string): Promise<boolean> {
    const r = await this.query(`ASK { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`);
    return r.type === 'boolean' && r.value;
  }

  async createGraph(_graphUri: string): Promise<void> {
    // Graphs are created implicitly on first insert in SPARQL 1.1.
  }

  async dropGraph(graphUri: string): Promise<void> {
    const update = `DROP SILENT GRAPH <${escapeUri(graphUri)}>`;
    const res = await this.postUpdate(update);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP dropGraph failed (${res.status}): ${text.slice(0, 300)}`);
    }
    this.invalidateGraphListCache(); // the graph is gone from listGraphs
  }

  async listGraphs(options?: QueryOptions): Promise<string[]> {
    throwIfAborted(options?.signal);
    // R6-A: on a managed (daemon-owned) endpoint the graph set only changes
    // when *we* write, so serve a warm cache and skip the full
    // `SELECT DISTINCT ?g` quad-store scan — the dominant idle-node CPU cost
    // on a data-rich node (re-run by the 30 s host-mode reconcile and every
    // on-demand CG enumeration). The cache is cleared on every write and also
    // expires after LIST_GRAPHS_CACHE_TTL_MS, so the burst of churn-driven
    // re-enumerations collapses to one scan per window while a store
    // outage/restart still surfaces within the TTL. Returns a copy so callers
    // can't mutate it.
    if (
      this.cacheGraphList &&
      this.graphListCache !== null &&
      this.now() - this.graphListCacheAt < LIST_GRAPHS_CACHE_TTL_MS
    ) {
      return [...this.graphListCache];
    }
    // External (non-managed) endpoint: never cache (an outside writer could
    // add a graph we'd miss), so just scan.
    if (!this.cacheGraphList) {
      return [...(await this.scanGraphs(this.graphListCacheGen, options))];
    }
    // Managed, cold/expired cache: coalesce concurrent callers onto one
    // in-flight scan so a startup or TTL-boundary burst doesn't fan out into
    // duplicate full scans (the very load this fix removes) — but only while no
    // write has invalidated the cache since that scan started. A caller
    // arriving after a write must not join the pre-write scan (it would observe
    // a stale graph set); it starts a fresh one instead.
    if (this.graphListInflight && this.graphListInflightGen === this.graphListCacheGen) {
      return [...(await raceAgainstAbort(this.graphListInflight, options?.signal))];
    }
    const startGen = this.graphListCacheGen;
    let scan!: Promise<string[]>;
    scan = this.scanGraphs(startGen).finally(() => {
      // Clear only if a newer scan hasn't already replaced this one, so a
      // post-write rebuild started while this scan was resolving isn't lost.
      if (this.graphListInflight === scan) {
        this.graphListInflight = null;
        this.graphListInflightGen = -1;
      }
    });
    this.graphListInflight = scan;
    this.graphListInflightGen = startGen;
    return [...(await raceAgainstAbort(scan, options?.signal))];
  }

  /**
   * Run the `SELECT DISTINCT ?g` enumeration and (for managed endpoints) cache
   * the result, unless a write landed during the scan — the generation guard
   * (`startGen` vs the current generation) discards a snapshot that may predate
   * that write so the next call rebuilds.
   */
  private async scanGraphs(startGen: number, options?: QueryOptions): Promise<string[]> {
    const r = await this.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }', options);
    const graphs = r.type === 'bindings' ? r.bindings.map((b) => b.g).filter(Boolean) : [];
    if (this.cacheGraphList && startGen === this.graphListCacheGen) {
      this.graphListCache = graphs;
      this.graphListCacheAt = this.now();
    }
    return graphs;
  }

  async countQuads(graphUri?: string): Promise<number> {
    const sparql = graphUri
      ? `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`
      : `SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }`;
    const r = await this.query(sparql);
    if (r.type === 'bindings' && r.bindings.length > 0) {
      const c = String(r.bindings[0].c ?? '');
      const stripped = c.replace(/^"|"$/g, '');
      return parseInt(stripped, 10) || 0;
    }
    return 0;
  }

  async close(): Promise<void> {
    // Remote service — nothing to close.
  }
}

// ---------------------------------------------------------------------------
// W3C SPARQL 1.1 JSON result types
// ---------------------------------------------------------------------------

interface W3CTerm {
  type: 'uri' | 'literal' | 'bnode' | 'typed-literal';
  value: string;
  datatype?: string;
  'xml:lang'?: string;
}

interface W3CSelectResponse {
  head: { vars: string[] };
  results: { bindings: Array<Record<string, W3CTerm>> };
}

interface W3CAskResponse {
  boolean: boolean;
}

function escapeNQuadsLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function w3cTermToString(t: W3CTerm): string {
  if (t.type === 'bnode') return `_:${t.value}`;
  if (t.type === 'literal' || t.type === 'typed-literal') {
    const escaped = escapeNQuadsLiteral(t.value);
    if (t['xml:lang']) return `"${escaped}"@${t['xml:lang']}`;
    if (t.datatype && t.datatype !== 'http://www.w3.org/2001/XMLSchema#string') {
      return `"${escaped}"^^<${t.datatype}>`;
    }
    return `"${escaped}"`;
  }
  return t.value;
}

// ---------------------------------------------------------------------------
// N-Quads / term helpers
// ---------------------------------------------------------------------------

function formatTerm(term: string): string {
  if (term.startsWith('"')) {
    const m = term.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
    if (m) return `${m[1]}^^<${m[2]}>`;
    return term;
  }
  if (term.startsWith('_:')) return term;
  if (term.startsWith('<')) return term;
  return `<${term}>`;
}

function parseNQuadsText(text: string): DKGQuad[] {
  const quads: DKGQuad[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(
      /^(<[^>]+>|_:\S+)\s+(<[^>]+>)\s+(<[^>]+>|_:\S+|"(?:[^"\\]|\\.)*"(?:@\S+|\^\^<[^>]+>)?)\s*(?:(<[^>]+>)\s*)?\.$/,
    );
    if (!match) continue;
    quads.push({
      subject: stripAngle(match[1]),
      predicate: stripAngle(match[2]),
      object: match[3].startsWith('<') ? stripAngle(match[3]) : match[3],
      graph: match[4] ? stripAngle(match[4]) : '',
    });
  }
  return quads;
}

function stripAngle(s: string): string {
  return s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1) : s;
}

function escapeUri(uri: string): string {
  return uri.replace(/[<>"{}|\\^`]/g, '');
}

function escapeString(s: string): string {
  return s.replace(/[\\"]/g, '\\$&');
}

/** True when an N-Quads term string denotes an RDF blank node (`_:label`). */
export function isBlankNodeTerm(term: string): boolean {
  return typeof term === 'string' && term.startsWith('_:');
}

/**
 * Partition blank-node-bearing quads into connected components: two quads are
 * connected when they share a blank-node label (directly or transitively). A
 * union-find over the blank-node labels does the grouping.
 *
 * Each component is later deleted as ONE `DELETE … WHERE …` so its shared
 * blank-node variables join correctly and any ground terms anchor the match.
 * Disjoint components must be emitted as SEPARATE statements: a single WHERE
 * holding two independent patterns is a cross-product, so if one pattern has
 * no match the whole row is empty and NOTHING is deleted — a silent
 * data-retention bug. Splitting by component avoids that.
 */
function connectedBlankNodeComponents(quads: DKGQuad[]): DKGQuad[][] {
  const parent = new Map<string, string>();
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x); };
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!); // path halving
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  for (const q of quads) {
    const labels: string[] = [];
    if (isBlankNodeTerm(q.subject)) labels.push(q.subject);
    if (isBlankNodeTerm(q.object)) labels.push(q.object);
    labels.forEach(add);
    if (labels.length === 2) union(labels[0], labels[1]);
  }

  const groups = new Map<string, DKGQuad[]>();
  for (const q of quads) {
    const label = isBlankNodeTerm(q.subject) ? q.subject : q.object;
    const root = find(label);
    let arr = groups.get(root);
    if (!arr) { arr = []; groups.set(root, arr); }
    arr.push(q);
  }
  return [...groups.values()];
}

/**
 * Build a spec-legal SPARQL Update that deletes exactly `quads`, including any
 * whose subject or object is a blank node. Returns `null` for empty input.
 *
 * Strategy:
 *  - Ground quads (no blank nodes) → a single `DELETE DATA { … }` block —
 *    exact and fast (identical to the legacy behaviour for the common case).
 *  - Blank-node quads → grouped into connected components ({@link
 *    connectedBlankNodeComponents}); each component becomes a
 *    `DELETE { … } WHERE { … }` with every blank node rewritten to a fresh
 *    query variable. This is the only spec-legal way to remove existing
 *    blank-node structure over the SPARQL protocol (`DELETE DATA` forbids
 *    blank nodes outright).
 *
 * Caveat (inherent to SPARQL): a blank node has no stable name across the
 * protocol, so a component is matched by *shape* + ground anchors, not
 * identity. A truly isolated blank-node triple with no ground anchor (e.g. a
 * lone `_:b <p> <o>`) matches every subject with that predicate/object; in
 * practice such triples are part of a larger entity component anchored by a
 * real IRI, so the match is precise. Two byte-for-byte isomorphic anchored
 * components are indistinguishable in RDF and both delete — which is correct.
 *
 * Exported for unit testing of the generated SPARQL.
 */
export function buildBlankNodeSafeDelete(quads: DKGQuad[]): string | null {
  if (quads.length === 0) return null;

  const ground: DKGQuad[] = [];
  const bnode: DKGQuad[] = [];
  for (const q of quads) {
    if (isBlankNodeTerm(q.subject) || isBlankNodeTerm(q.object)) bnode.push(q);
    else ground.push(q);
  }

  const statements: string[] = [];

  if (ground.length > 0) {
    const body = ground.map((q) => {
      const g = q.graph ? `GRAPH <${escapeUri(q.graph)}> ` : '';
      return `${g}{ ${formatTerm(q.subject)} <${escapeUri(q.predicate)}> ${formatTerm(q.object)} . }`;
    }).join('\n');
    statements.push(`DELETE DATA {\n${body}\n}`);
  }

  if (bnode.length > 0) {
    // Group by graph first — never join components across graphs.
    const byGraph = new Map<string, DKGQuad[]>();
    for (const q of bnode) {
      const g = q.graph || '';
      let arr = byGraph.get(g);
      if (!arr) { arr = []; byGraph.set(g, arr); }
      arr.push(q);
    }
    for (const [graph, list] of byGraph) {
      for (const component of connectedBlankNodeComponents(list)) {
        const vars = new Map<string, string>();
        const render = (t: string): string => {
          if (!isBlankNodeTerm(t)) return formatTerm(t);
          let v = vars.get(t);
          if (!v) { v = `?b${vars.size}`; vars.set(t, v); }
          return v;
        };
        const triples = component
          .map((q) => `${render(q.subject)} <${escapeUri(q.predicate)}> ${render(q.object)} .`)
          .join('\n    ');
        const inner = graph
          ? `GRAPH <${escapeUri(graph)}> {\n    ${triples}\n  }`
          : triples;
        statements.push(`DELETE { ${inner} } WHERE { ${inner} }`);
      }
    }
  }

  return statements.join(';\n');
}

// ---------------------------------------------------------------------------
// Adapter registration
// ---------------------------------------------------------------------------

registerTripleStoreAdapter('sparql-http', async (opts) => {
  const options = opts as SparqlHttpStoreOptions | undefined;
  if (!options?.queryEndpoint) {
    throw new Error('sparql-http adapter requires options.queryEndpoint (and optionally options.updateEndpoint)');
  }
  return new SparqlHttpStore(options);
});
