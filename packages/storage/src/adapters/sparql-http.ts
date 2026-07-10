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
  UpdateOptions,
  QueryResult,
  SelectResult,
  ConstructResult,
  AskResult,
  StorePressureSnapshot,
} from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';
import { externalStorePriorityScheduler } from '../store-priority-scheduler.js';
import { assertQuadLiteralsMutf8Safe, JAVA_WRITE_UTF_MAX_BYTES } from '@origintrail-official/dkg-core';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

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

const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 10_000;
const DEFAULT_SLOW_QUERY_SAMPLE_RATE = 1;
const MANAGED_LIST_GRAPHS_CACHE_MS = 30_000;
const monotonicNow = (): number => performance.now();

export interface SparqlHttpQueryOptions extends QueryOptions {
  /** Caller tag used in slow-query telemetry, e.g. `agent.listContextGraphs`. */
  source?: string;
}

export interface SparqlHttpSlowQueryEvent {
  source: string;
  operation: 'select' | 'ask' | 'construct' | 'describe' | 'unknown';
  elapsedMs: number;
  thresholdMs: number;
  endpoint: string;
  queryHash: string;
  queryBytes: number;
}

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
   * Marker used by higher-level daemon flows to distinguish daemon-owned
   * endpoints from operator-provided URLs.
   *
   * Compatibility note: direct `new SparqlHttpStore({ managedByDkg: true })`
   * callers keep the legacy adapter-local `listGraphs()` cache. The
   * `createTripleStore({ backend: 'sparql-http', options: { managedByDkg: true } })`
   * path suppresses that adapter-local cache and wraps the store in
   * GraphSetIndexStore so managed daemon flows still have a single graph-list
   * index/revalidation owner.
   */
  managedByDkg?: boolean;
  /** Emit sampled slow-query events after this duration. Default 10_000 ms; set 0 to disable. */
  slowQueryThresholdMs?: number;
  /** Sampling rate for slow-query events, from 0 to 1. Default 1. */
  slowQuerySampleRate?: number;
  /** Optional sink for sampled slow-query events; defaults to a compact console warning. */
  onSlowQuery?: (event: SparqlHttpSlowQueryEvent) => void;
  /**
   * Monotonic clock for slow-query telemetry. Graph-list revalidation clocks
   * are owned by GraphSetIndexStore.
   */
  now?: () => number;
}

export class SparqlHttpStore implements TripleStore {
  readonly queryCancellation = 'interruptible' as const;

  private readonly queryEndpoint: string;
  private readonly updateEndpoint: string;
  private readonly timeout: number;
  private readonly headers: Record<string, string>;
  private readonly managedByDkg: boolean;

  private readonly now: () => number;
  private readonly slowQueryThresholdMs: number;
  private readonly slowQuerySampleRate: number;
  private readonly onSlowQuery?: (event: SparqlHttpSlowQueryEvent) => void;
  private listGraphsCache: string[] | null = null;
  private listGraphsCachedAt = 0;
  private listGraphsGeneration = 0;
  private listGraphsInFlight: Promise<string[]> | null = null;

  constructor(options: SparqlHttpStoreOptions) {
    if (!options.queryEndpoint?.trim()) {
      throw new Error('sparql-http adapter requires options.queryEndpoint');
    }
    this.queryEndpoint = options.queryEndpoint.replace(/\/$/, '');
    this.updateEndpoint = (options.updateEndpoint ?? options.queryEndpoint).replace(/\/$/, '');
    this.timeout = options.timeout ?? 30_000;
    this.managedByDkg = options.managedByDkg === true;
    this.now = options.now ?? monotonicNow;
    this.slowQueryThresholdMs = normalizeNonNegativeNumber(
      options.slowQueryThresholdMs,
      DEFAULT_SLOW_QUERY_THRESHOLD_MS,
    );
    this.slowQuerySampleRate = normalizeSampleRate(
      options.slowQuerySampleRate,
      DEFAULT_SLOW_QUERY_SAMPLE_RATE,
    );
    this.onSlowQuery = options.onSlowQuery;
    // Content-Type is set per-request in postQuery/postUpdate (direct POST:
    // application/sparql-query | application/sparql-update). Only shared
    // headers (e.g. Authorization) belong here.
    this.headers = {};
    if (options.auth) {
      this.headers['Authorization'] = options.auth;
    }
  }

  private runStoreWork<T>(
    operation: string,
    options: QueryOptions | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    return externalStorePriorityScheduler.run(
      options?.priority,
      options?.source ?? `sparql-http.${operation}`,
      work,
      options?.signal,
    );
  }

  getPressureSnapshot(): StorePressureSnapshot {
    return externalStorePriorityScheduler.snapshot;
  }

  private async postQuery(sparql: string, accept: string, options?: SparqlHttpQueryOptions): Promise<Response> {
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

  private async postUpdate(
    update: string,
    options?: QueryOptions,
    operation = 'update',
  ): Promise<Response> {
    // Direct POST (W3C SPARQL 1.1 Protocol §2.2.2): the update is the raw
    // request body with `application/sparql-update`, not URL-encoded form
    // data. See postQuery for why form encoding breaks large payloads.
    return this.runStoreWork(operation, options, async () => {
      const timeoutSignal = AbortSignal.timeout(this.timeout);
      const signal = composeAbortSignals(options?.signal, timeoutSignal) ?? timeoutSignal;
      return fetch(this.updateEndpoint, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/sparql-update' },
        body: update,
        signal,
      });
    });
  }

  async insert(quads: DKGQuad[], options?: QueryOptions): Promise<void> {
    if (quads.length === 0) return;
    assertQuadLiteralsMutf8Safe(quads, {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
      label: 'SparqlHttpStore.insert',
    });
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
    const res = await this.postUpdate(update, {
      ...options,
      source: options?.source ?? 'sparql-http.insert',
    }, 'insert');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP insert failed (${res.status}): ${text.slice(0, 300)}`);
    }
    this.invalidateListGraphsCache();
  }

  async delete(quads: DKGQuad[], options?: QueryOptions): Promise<void> {
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
    const res = await this.postUpdate(update, {
      ...options,
      source: options?.source ?? 'sparql-http.delete',
    }, 'delete');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP delete failed (${res.status}): ${text.slice(0, 300)}`);
    }
    this.invalidateListGraphsCache();
  }

  async deleteByPattern(pattern: Partial<DKGQuad>, options?: QueryOptions): Promise<number> {
    const graphUri = pattern.graph;
    const before = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteByPattern.countBefore',
    });
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
    const res = await this.postUpdate(update, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteByPattern',
    }, 'deleteByPattern');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP deleteByPattern failed (${res.status}): ${text.slice(0, 300)}`);
    }
    this.invalidateListGraphsCache();
    const after = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteByPattern.countAfter',
    });
    return Math.max(0, before - after);
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    const before = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteBySubjectPrefix.countBefore',
    });
    const escapedPrefix = escapeString(prefix);
    const update = `DELETE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } } WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${escapedPrefix}")) } }`;
    const res = await this.postUpdate(update, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteBySubjectPrefix',
    }, 'deleteBySubjectPrefix');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP deleteBySubjectPrefix failed (${res.status}): ${text.slice(0, 300)}`);
    }
    this.invalidateListGraphsCache();
    const after = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteBySubjectPrefix.countAfter',
    });
    return Math.max(0, before - after);
  }

  /**
   * Server-side SPARQL UPDATE over the SPARQL 1.1 protocol — the endpoint
   * (oxigraph-server) executes graph-to-graph `INSERT…WHERE` copies internally,
   * so terms stay byte-identical (no JS round-trip). See {@link TripleStore.update}.
   */
  async update(sparql: string, options?: UpdateOptions): Promise<void> {
    const res = await this.postUpdate(sparql, {
      ...options,
      source: options?.source ?? 'sparql-http.update',
    }, 'update');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP update failed (${res.status}): ${text.slice(0, 300)}`);
    }
    this.invalidateListGraphsCache();
  }

  async query(sparql: string, options?: SparqlHttpQueryOptions): Promise<QueryResult> {
    return this.runStoreWork('query', options, async () => {
      const startedAt = this.now();
      throwIfAborted(options?.signal);
      const trimmed = sparql.trim();
      const upper = trimmed.toUpperCase();
      const isAsk = upper.startsWith('ASK');
      const isConstruct = upper.startsWith('CONSTRUCT') || upper.startsWith('DESCRIBE');
      const operation = inferQueryOperation(trimmed);

      try {
        if (isConstruct) {
          return await this.queryConstruct(trimmed, options);
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
      } finally {
        this.maybeEmitSlowQuery({
          sparql: trimmed,
          source: options?.source,
          operation,
          startedAt,
        });
      }
    });
  }

  private async queryConstruct(sparql: string, options?: SparqlHttpQueryOptions): Promise<ConstructResult> {
    const res = await this.postQuery(sparql, 'application/n-quads, text/n-quads', options);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP construct failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const text = await res.text();
    const quads = parseNQuadsText(text);
    return { type: 'quads', quads };
  }

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    const r = await this.query(
      `ASK { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`,
      { ...options, source: options?.source ?? 'sparql-http.hasGraph' },
    );
    return r.type === 'boolean' && r.value;
  }

  async createGraph(_graphUri: string): Promise<void> {
    // Graphs are created implicitly on first insert in SPARQL 1.1.
  }

  async dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    const update = `DROP SILENT GRAPH <${escapeUri(graphUri)}>`;
    const res = await this.postUpdate(update, {
      ...options,
      source: options?.source ?? 'sparql-http.dropGraph',
    }, 'dropGraph');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SPARQL HTTP dropGraph failed (${res.status}): ${text.slice(0, 300)}`);
    }
    this.invalidateListGraphsCache();
  }

  async listGraphs(options?: QueryOptions): Promise<string[]> {
    if (!this.managedByDkg) {
      return this.listGraphsDirect(options);
    }
    throwIfAborted(options?.signal);
    if (
      this.listGraphsCache &&
      this.now() - this.listGraphsCachedAt < MANAGED_LIST_GRAPHS_CACHE_MS
    ) {
      return [...this.listGraphsCache];
    }

    const refreshOptions = options?.source ? { source: options.source } : undefined;
    const inFlight = this.listGraphsInFlight ?? this.refreshListGraphsCache(refreshOptions);
    const graphs = await raceAgainstAbort(inFlight, options?.signal);
    return [...graphs];
  }

  private async listGraphsDirect(options?: QueryOptions): Promise<string[]> {
    throwIfAborted(options?.signal);
    // Enumerate named graphs from oxigraph's graph index, NOT via a quad scan.
    // `GRAPH ?g { ?s ?p ?o }` forces oxigraph to iterate EVERY quad and DISTINCT
    // the graph column — O(#quads). Benchmarked on the pinned 0.5.8 RocksDB
    // backend: 12ms -> 947ms as the store grows 25k -> 1M quads (super-linear),
    // so on a large core store it exceeds the request timeout, the graph-set
    // index never seeds, and the sync responder re-runs the doomed scan on every
    // request (the observed 30s `sync.responder.listGraphs` livelock).
    // `GRAPH ?g {}` reads the graph index directly (flat, single-digit ms). The
    // `FILTER EXISTS` keeps the existing non-empty-only contract: a graph emptied
    // by DELETE (but not DROP) stays registered, so bare `GRAPH ?g {}` would
    // over-list it and break graph-set-index-store's invariant — confirmed on the
    // 0.5.8 RocksDB backend (bare=1001 vs FILTER-EXISTS=1000 == the old query).
    const r = await this.query(
      'SELECT ?g WHERE { GRAPH ?g {} FILTER EXISTS { GRAPH ?g { ?s ?p ?o } } }',
      { ...options, source: options?.source ?? 'sparql-http.listGraphs' },
    );
    return r.type === 'bindings' ? r.bindings.map((b) => b.g).filter(Boolean) : [];
  }

  private refreshListGraphsCache(options?: QueryOptions): Promise<string[]> {
    const generation = this.listGraphsGeneration;
    const task = (async () => {
      try {
        const graphs = await this.listGraphsDirect(options);
        const cached = [...graphs];
        if (generation === this.listGraphsGeneration) {
          this.listGraphsCache = cached;
          this.listGraphsCachedAt = this.now();
        }
        return cached;
      } finally {
        if (this.listGraphsGeneration === generation) this.listGraphsInFlight = null;
      }
    })();
    this.listGraphsInFlight = task;
    return task;
  }

  private invalidateListGraphsCache(): void {
    this.listGraphsGeneration++;
    this.listGraphsCache = null;
    this.listGraphsCachedAt = 0;
    this.listGraphsInFlight = null;
  }

  async countQuads(graphUri?: string, options?: QueryOptions): Promise<number> {
    const sparql = graphUri
      ? `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`
      : `SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }`;
    const r = await this.query(sparql, {
      ...options,
      source: options?.source ?? 'sparql-http.countQuads',
    });
    if (r.type === 'bindings' && r.bindings.length > 0) {
      const c = String(r.bindings[0].c ?? '');
      const stripped = c.replace(/^"|"$/g, '');
      return parseInt(stripped, 10) || 0;
    }
    return 0;
  }

  private maybeEmitSlowQuery(input: {
    sparql: string;
    source?: string;
    operation: SparqlHttpSlowQueryEvent['operation'];
    startedAt: number;
  }): void {
    if (this.slowQueryThresholdMs <= 0 || this.slowQuerySampleRate <= 0) return;
    const elapsedMs = this.now() - input.startedAt;
    if (elapsedMs < this.slowQueryThresholdMs) return;
    if (this.slowQuerySampleRate < 1 && Math.random() >= this.slowQuerySampleRate) return;

    const event: SparqlHttpSlowQueryEvent = {
      source: normalizeQuerySource(input.source),
      operation: input.operation,
      elapsedMs,
      thresholdMs: this.slowQueryThresholdMs,
      endpoint: sanitizeEndpointForTelemetry(this.queryEndpoint),
      queryHash: hashQuery(input.sparql),
      queryBytes: Buffer.byteLength(input.sparql, 'utf8'),
    };

    if (this.onSlowQuery) {
      try {
        this.onSlowQuery(event);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`SPARQL HTTP slow query hook failed: ${reason}`);
      }
      return;
    }
    console.warn(
      `SPARQL HTTP slow query source=${event.source} operation=${event.operation} ` +
      `elapsedMs=${Math.round(event.elapsedMs)} thresholdMs=${event.thresholdMs} ` +
      `queryHash=${event.queryHash} queryBytes=${event.queryBytes} endpoint=${event.endpoint}`,
    );
  }

  async close(): Promise<void> {
    // Remote service — nothing to close.
  }
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function normalizeSampleRate(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeQuerySource(source: string | undefined): string {
  const trimmed = source?.trim();
  if (!trimmed) return 'unknown';
  return trimmed.replace(/[^\w:./-]/g, '_').slice(0, 120) || 'unknown';
}

function inferQueryOperation(sparql: string): SparqlHttpSlowQueryEvent['operation'] {
  const upper = sparql.trimStart().toUpperCase();
  if (upper.startsWith('SELECT')) return 'select';
  if (upper.startsWith('ASK')) return 'ask';
  if (upper.startsWith('CONSTRUCT')) return 'construct';
  if (upper.startsWith('DESCRIBE')) return 'describe';
  return 'unknown';
}

function hashQuery(sparql: string): string {
  return createHash('sha256').update(sparql).digest('hex').slice(0, 16);
}

function sanitizeEndpointForTelemetry(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return endpoint.split(/[?#]/, 1)[0];
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
