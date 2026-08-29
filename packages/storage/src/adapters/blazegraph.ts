import { performance } from 'node:perf_hooks';
import type {
  TripleStore,
  Quad as DKGQuad,
  QueryOptions,
  UpdateOptions,
  StorePressureSnapshot,
  TripleStoreQueryOptions,
  QueryResult,
  SelectResult,
  ConstructResult,
  AskResult,
} from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';
import { buildBlankNodeSafeDelete } from './sparql-http.js';
import {
  formatSparqlJsonBindings,
  type AdapterSparqlJsonSelectResponse,
} from './sparql-json-results.js';
import { toBlazegraphAsciiSafeNQuads } from './blazegraph-nquads.js';
import { SPARQL_QUERY_CONTENT_TYPE, SPARQL_UPDATE_CONTENT_TYPE } from './sparql-content-types.js';
import {
  assertQuadLiteralsMutf8Safe,
  getMetrics,
  JAVA_WRITE_UTF_MAX_BYTES,
} from '@origintrail-official/dkg-core';
import { certifyRfc64SemanticReadStoreV1 } from '../rfc64-semantic-read-capability.js';
import {
  externalStorePriorityScheduler,
  type StorePriorityScheduler,
} from '../store-priority-scheduler.js';
import {
  buildAtomicGraphAndSubjectReplaceUpdate,
  buildAtomicGraphReplaceUpdate,
  buildAtomicSubjectReplaceUpdate,
  isAtomicGraphReplaceStagingGraph,
} from '../atomic-graph-replace.js';
import {
  buildRfc64AuthorCommitCasUpdateV1,
  executeRfc64AuthorCommitCasV1,
  type Rfc64AuthorCommitCasInputV1,
  type Rfc64AuthorCommitCasResultV1,
} from '../rfc64-author-commit-cas.js';
import { quadToNQuad } from '../bounded-rdf.js';
import { readResponseTextBounded } from '../http-response-limit.js';
import { scanNQuadLines, type NQuadLineScan } from '../nquads-text.js';
import { StoreOperationTimeoutError } from '../store-operation-timeout.js';
import type { StoreOperation, StoreOperationOutcome } from '../store-operation-outcome.js';

export const DEFAULT_BLAZEGRAPH_OPERATION_TIMEOUT_MS = 30_000;

/**
 * Blazegraph's per-request server-side query deadline. The deployed 2.1.x
 * engine honours this header (`BigdataRDFContext$AbstractQueryTask` reads it
 * via `getQueryTimeout`); `web.xml`'s `queryTimeout` context-param is the
 * global equivalent and ships as `0` — unbounded.
 */
const MAX_QUERY_MILLIS_HEADER = 'X-BIGDATA-MAX-QUERY-MILLIS';

/**
 * Multiplier applied to the client deadline to derive the server-side bound.
 *
 * This is deliberately > 1: the server deadline must be WIDER than the
 * client's, never tighter. Two reasons, and the second is a correctness trap:
 *
 * 1. The problem being solved is *abandoned* work. When the client aborts at
 *    its deadline the HTTP connection goes away but Blazegraph keeps executing
 *    the query — observed on mainnet running 10-32+ minutes past a 30s client
 *    abort, with `queryErrorCount = 0` across 20,953 queries confirming the
 *    server never cancelled anything. A handful of these saturate a core. Any
 *    finite server bound fixes that; it does not need to be tight.
 *
 * 2. A tight bound introduces silent data loss. Blazegraph commits `200 OK`
 *    and begins streaming before the deadline fires, then appends its error
 *    into the already-committed body. A CONSTRUCT killed mid-stream therefore
 *    returns a SHORT BUT STRUCTURALLY VALID n-quads document. Since the client
 *    is still reading at that point, it parses the truncated result as a
 *    complete one — a sync page that looks whole and is not. Keeping the
 *    server bound comfortably above the client deadline means the client
 *    always aborts first, so no caller is ever parsing a truncated body.
 *    ({@link parseBlazegraphConstructNQuads} is the belt-and-braces guard for the
 *    residual case.)
 *
 * With the 30s default this yields a 120s server bound: orphan lifetime drops
 * from unbounded to at most 2 minutes, while the truncation path stays
 * unreachable.
 */
const SERVER_QUERY_DEADLINE_FACTOR = 4;

export interface BlazegraphStoreOptions {
  /** End-to-end timeout including scheduler wait, HTTP work, and response decoding. */
  timeout?: number;
  /** Optional scheduler injection for embedded callers and adapter-boundary tests. */
  scheduler?: StorePriorityScheduler;
}

interface StoreOperationDeadline {
  readonly signal: AbortSignal;
  markStarted(): void;
  waitFor<T>(work: Promise<T>): Promise<T>;
  check(): void;
  dispose(): void;
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveOperationTimeout(configured: number | undefined): number {
  if (configured === undefined) {
    return parsePositiveIntegerEnv(
      'DKG_BLAZEGRAPH_OPERATION_TIMEOUT_MS',
      DEFAULT_BLAZEGRAPH_OPERATION_TIMEOUT_MS,
    );
  }
  if (!Number.isInteger(configured) || configured <= 0) {
    throw new Error('BlazegraphStore timeout must be a positive integer in milliseconds');
  }
  return configured;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

function createStoreOperationDeadline(
  timeoutMs: number,
  callerSignal?: AbortSignal,
  operation: StoreOperation = 'query',
): StoreOperationDeadline {
  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let callerAttached = false;
  let outcome: StoreOperationOutcome = 'not_started';

  const timeoutError = () => new StoreOperationTimeoutError({
    backend: 'blazegraph',
    operation,
    timeoutMs,
    outcome,
  });
  const detachCaller = () => {
    if (!callerAttached) return;
    callerAttached = false;
    callerSignal?.removeEventListener('abort', onCallerAbort);
  };
  const onCallerAbort = () => {
    detachCaller();
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    if (callerSignal) {
      callerAttached = true;
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    timer = setTimeout(() => {
      timer = undefined;
      detachCaller();
      controller.abort(timeoutError());
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  const check = () => {
    if (controller.signal.aborted) throw abortError(controller.signal);
    if (performance.now() < deadlineAt) return;
    const error = timeoutError();
    detachCaller();
    controller.abort(error);
    throw error;
  };
  const waitFor = async <T>(work: Promise<T>): Promise<T> => {
    let result: T;
    try {
      // Do not race the operation against the abort signal here. The signal is
      // already passed to fetch (and therefore to its response body), so the
      // underlying promise settles only after the HTTP stack has processed the
      // cancellation. Racing would reject the scheduler task immediately and
      // release its admission slot while the prior Blazegraph request could
      // still be unwinding server-side, allowing a retry to overlap it.
      result = await work;
    } catch (error) {
      // The timer callback may be delayed by synchronous response processing.
      // Re-check the monotonic deadline before preserving an underlying error
      // so elapsed operations still surface the deadline's TimeoutError.
      check();
      throw error;
    }
    check();
    return result;
  };

  return {
    signal: controller.signal,
    markStarted: () => { outcome = 'indeterminate'; },
    waitFor,
    check,
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      detachCaller();
    },
  };
}

/**
 * BlazegraphStore — TripleStore adapter backed by a remote Blazegraph
 * SPARQL endpoint over HTTP.  Works with any Blazegraph 2.x instance
 * (standalone JAR, Docker, or embedded NanoSparqlServer).
 *
 * All operations are translated to standard SPARQL 1.1 Query / Update
 * plus Blazegraph's N-Quads bulk-insert endpoint.
 */
export class BlazegraphStore implements TripleStore {
  readonly queryCancellation = 'interruptible' as const;

  private readonly url: string;
  private readonly operationTimeoutMs: number;
  private readonly scheduler: StorePriorityScheduler;

  constructor(url: string, options: BlazegraphStoreOptions = {}) {
    this.url = url.replace(/\/$/, '');
    this.operationTimeoutMs = resolveOperationTimeout(options.timeout);
    this.scheduler = options.scheduler ?? externalStorePriorityScheduler;
    certifyRfc64SemanticReadStoreV1(this);
  }

  private runStoreWork<T>(
    operation: StoreOperation,
    options: QueryOptions | undefined,
    work: (deadline: StoreOperationDeadline) => Promise<T>,
  ): Promise<T> {
    const deadline = createStoreOperationDeadline(
      this.operationTimeoutMs,
      options?.signal,
      operation,
    );
    const source = options?.source ?? `blazegraph.${operation}`;
    const scheduled = this.scheduler.run(
      options?.priority,
      source,
      async () => {
        deadline.markStarted();
        try {
          deadline.check();
          const result = await work(deadline);
          deadline.check();
          return result;
        } finally {
          // The admitted transport/body promise has settled before this metric
          // and before the scheduler releases its slot.
          if (deadline.signal.aborted) {
            getMetrics().storeCancellationCompletedTotal.add(1, { operation, source });
          }
        }
      },
      deadline.signal,
      { storeOperation: operation },
    );
    return scheduled.finally(deadline.dispose);
  }

  getPressureSnapshot(): StorePressureSnapshot {
    return this.scheduler.snapshot;
  }

  // -------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------

  async insert(quads: DKGQuad[], options?: QueryOptions): Promise<void> {
    if (quads.length === 0) return;
    await this.runStoreWork('insert', {
      ...options,
      source: options?.source ?? 'blazegraph.insert',
    }, async (deadline) => {
      assertQuadLiteralsMutf8Safe(quads, {
        maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
        label: 'BlazegraphStore.insert',
      });
      // Serialize only after scheduler admission. A blocked store therefore
      // retains the caller's quad array, not an additional potentially-large
      // N-Quads copy for every waiting insert.
      const nquads = quads.map(quadToBlazegraphNQuad).join('\n') + '\n';
      deadline.check();
      const res = await deadline.waitFor(fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/x-nquads' },
        body: nquads,
        signal: deadline.signal,
      }));
      if (!res.ok) {
        const text = await deadline.waitFor(res.text().catch(() => ''));
        throw new Error(`Blazegraph insert failed (${res.status}): ${text.slice(0, 200)}`);
      }
    });
  }

  async delete(quads: DKGQuad[], options?: QueryOptions): Promise<void> {
    if (quads.length === 0) return;
    // Blazegraph is SPARQL 1.1, so blank nodes are illegal in `DELETE DATA`
    // (same constraint as Oxigraph). Reuse the shared blank-node-safe builder
    // so blank-node quads are removed via `DELETE { … } WHERE { … }`.
    const update = buildBlankNodeSafeDelete(quads);
    if (!update) return;
    await this.sparqlUpdate(update, {
      ...options,
      source: options?.source ?? 'blazegraph.delete',
    }, 'delete');
  }

  async deleteByPattern(pattern: Partial<DKGQuad>, options?: QueryOptions): Promise<number> {
    const before = await this.countQuads(pattern.graph, {
      ...options,
      source: options?.source ?? 'blazegraph.deleteByPattern.countBefore',
    });
    const s = pattern.subject ? `<${escapeUri(pattern.subject)}>` : '?s';
    const p = pattern.predicate ? `<${escapeUri(pattern.predicate)}>` : '?p';
    const o = pattern.object ? formatTerm(pattern.object) : '?o';
    const triple = `${s} ${p} ${o}`;
    if (pattern.graph) {
      await this.sparqlUpdate(
        `DELETE { GRAPH <${escapeUri(pattern.graph)}> { ${triple} } } WHERE { GRAPH <${escapeUri(pattern.graph)}> { ${triple} } }`,
        { ...options, source: options?.source ?? 'blazegraph.deleteByPattern' },
        'deleteByPattern',
      );
    } else {
      // `DELETE { ?g_ctx { … } }` is a syntax error — the template needs the
      // `GRAPH` keyword. Rejected with HTTP 400 by a spec-compliant endpoint.
      await this.sparqlUpdate(
        `DELETE { GRAPH ?g_ctx { ${triple} } } WHERE { GRAPH ?g_ctx { ${triple} } }`,
        { ...options, source: options?.source ?? 'blazegraph.deleteByPattern' },
        'deleteByPattern',
      );
    }
    const after = await this.countQuads(pattern.graph, {
      ...options,
      source: options?.source ?? 'blazegraph.deleteByPattern.countAfter',
    });
    return Math.max(0, before - after);
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    const before = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'blazegraph.deleteBySubjectPrefix.countBefore',
    });
    await this.sparqlUpdate(
      `DELETE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } } WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${escapeString(prefix)}")) } }`,
      { ...options, source: options?.source ?? 'blazegraph.deleteBySubjectPrefix' },
      'deleteBySubjectPrefix',
    );
    const after = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'blazegraph.deleteBySubjectPrefix.countAfter',
    });
    return Math.max(0, before - after);
  }

  /**
   * Server-side SPARQL UPDATE — POSTs the update verbatim to the endpoint so a
   * `DELETE { … } WHERE { … }` (or `INSERT … WHERE`) runs entirely inside
   * Blazegraph with NO client-side COUNT scans. Uniform with the
   * oxigraph/sparql-http `update()` (`See {@link TripleStore.update}`) so callers
   * can issue one count-free UPDATE instead of a per-pattern
   * `deleteByPattern`/`deleteBySubjectPrefix` loop — each of those brackets its
   * delete with two full-graph `countQuads` scans (see above), which is
   * prohibitive on a CPU-pegged core.
   */
  async update(sparql: string, options?: UpdateOptions): Promise<void> {
    await this.sparqlUpdate(
      sparql,
      { ...options, source: options?.source ?? 'blazegraph.update' },
      'update',
    );
  }

  async replaceGraph(
    graphUri: string,
    quads: DKGQuad[],
    options?: QueryOptions,
  ): Promise<void> {
    assertQuadLiteralsMutf8Safe(quads, {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
      label: 'BlazegraphStore.replaceGraph',
    });
    const plan = buildAtomicGraphReplaceUpdate(graphUri, quads);
    try {
      await this.sparqlUpdate(
        plan.update,
        { ...options, source: options?.source ?? 'blazegraph.replaceGraph' },
        'replaceGraph',
      );
    } catch (error) {
      if (plan.cleanup) {
        await this.sparqlUpdate(
          plan.cleanup,
          { ...options, source: 'blazegraph.replaceGraph.cleanup' },
          'replaceGraph',
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  async replaceGraphAndSubject(
    graphUri: string,
    graphQuads: DKGQuad[],
    metaGraphUri: string,
    metadataSubject: string,
    metadataQuads: DKGQuad[],
    options?: QueryOptions,
  ): Promise<void> {
    assertQuadLiteralsMutf8Safe([...graphQuads, ...metadataQuads], {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
      label: 'BlazegraphStore.replaceGraphAndSubject',
    });
    const plan = buildAtomicGraphAndSubjectReplaceUpdate(
      graphUri,
      graphQuads,
      metaGraphUri,
      metadataSubject,
      metadataQuads,
    );
    try {
      await this.sparqlUpdate(
        plan.update,
        { ...options, source: options?.source ?? 'blazegraph.replaceGraphAndSubject' },
        'replaceGraphAndSubject',
      );
    } catch (error) {
      await this.sparqlUpdate(
        plan.cleanup,
        { ...options, source: 'blazegraph.replaceGraphAndSubject.cleanup' },
        'replaceGraphAndSubject',
      ).catch(() => undefined);
      throw error;
    }
  }

  async replaceSubject(
    graphUri: string,
    subject: string,
    quads: DKGQuad[],
    options?: QueryOptions,
  ): Promise<void> {
    assertQuadLiteralsMutf8Safe(quads, {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
      label: 'BlazegraphStore.replaceSubject',
    });
    // Blazegraph runs one UPDATE request (DELETE WHERE + INSERT DATA) as a single
    // transaction, so the subject is replaced atomically. No staging/cleanup: a
    // failed request commits nothing.
    await this.sparqlUpdate(
      buildAtomicSubjectReplaceUpdate(graphUri, subject, quads),
      { ...options, source: options?.source ?? 'blazegraph.replaceSubject' },
      'replaceSubject',
    );
  }

  async rfc64AuthorCommitCasV1(
    input: Rfc64AuthorCommitCasInputV1,
    options?: QueryOptions,
  ): Promise<Rfc64AuthorCommitCasResultV1> {
    const plan = buildRfc64AuthorCommitCasUpdateV1(input);
    const { signal: _callerSignal, ...cleanupOptions } = options ?? {};
    assertQuadLiteralsMutf8Safe(plan.semanticQuads, {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
      label: 'BlazegraphStore.rfc64AuthorCommitCasV1',
    });
    return executeRfc64AuthorCommitCasV1({
      executeUpdate: () => this.sparqlUpdate(
        plan.update,
        { ...options, source: options?.source ?? 'blazegraph.rfc64AuthorCommitCasV1' },
        'rfc64AuthorCommitCasV1',
      ),
      readReceipt: () => this.query(plan.receiptAsk, {
        ...options,
        source: 'blazegraph.rfc64AuthorCommitCasV1.receipt',
      }),
      cleanup: () => this.sparqlUpdate(
        plan.cleanup,
        { ...cleanupOptions, source: 'blazegraph.rfc64AuthorCommitCasV1.cleanup' },
        'rfc64AuthorCommitCasV1',
      ),
    });
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  async query(sparql: string, options?: TripleStoreQueryOptions): Promise<QueryResult> {
    return this.queryWithOperation(sparql, options);
  }

  private async queryWithOperation(
    sparql: string,
    options: TripleStoreQueryOptions | undefined,
    storeOperation?: StoreOperation,
  ): Promise<QueryResult> {
    const trimmed = sparql.trim();
    const upper = trimmed.toUpperCase();
    const isAsk = upper.startsWith('ASK');
    const isConstruct = upper.startsWith('CONSTRUCT') || upper.startsWith('DESCRIBE');
    return this.runStoreWork(
      storeOperation ?? (isConstruct ? 'construct' : 'query'),
      options,
      async (deadline) => {

      if (isConstruct) {
        return this.queryConstruct(trimmed, deadline, options);
      }

      // Direct POST (W3C SPARQL 1.1 Protocol): send the query as the raw
      // request body with `application/sparql-query` rather than URL-encoded
      // form data. Form-encoded bodies (`query=...`) are parsed by Jetty's
      // form handler, which caps at `maxFormContentSize` (~200 KB by default
      // on stock Blazegraph) and rejects larger payloads with HTTP 400
      // "Unable to parse form content". The direct-POST body is not form
      // parsed, so large queries (e.g. CONSTRUCT/VALUES) are not capped.
      // SPARQL_QUERY_CONTENT_TYPE carries charset=utf-8 (see sparql-content-types.ts).
      const res = await this.postReadQuery(
        trimmed,
        'application/sparql-results+json',
        deadline,
        options,
        'query',
      );

      const json = options?.maxResponseBytes === undefined
        ? await deadline.waitFor(
            res.json() as Promise<AdapterSparqlJsonSelectResponse | BlazeAskResponse>,
          )
        : JSON.parse(await deadline.waitFor(
            readResponseTextBounded(res, options.maxResponseBytes),
          )) as AdapterSparqlJsonSelectResponse | BlazeAskResponse;

      if (isAsk || 'boolean' in json) {
        return { type: 'boolean', value: (json as BlazeAskResponse).boolean } satisfies AskResult;
      }

      const bindings = formatSparqlJsonBindings(json as AdapterSparqlJsonSelectResponse);
      return { type: 'bindings', bindings } satisfies SelectResult;
      },
    );
  }

  /**
   * Server-side query bound sent with every read. See
   * {@link SERVER_QUERY_DEADLINE_FACTOR} for why this is wider than the
   * client deadline rather than tighter.
   */
  private serverQueryDeadlineMs(): number {
    return this.operationTimeoutMs * SERVER_QUERY_DEADLINE_FACTOR;
  }

  /**
   * Canonical request boundary for Blazegraph reads. Keeping transport and
   * deadline setup here makes it impossible for SELECT/ASK and
   * CONSTRUCT/DESCRIBE to drift on the server-side cancellation policy while
   * leaving their distinct response decoding in the callers.
   */
  private async postReadQuery(
    sparql: string,
    accept: string,
    deadline: StoreOperationDeadline,
    options: TripleStoreQueryOptions | undefined,
    failureLabel: 'query' | 'construct',
  ): Promise<Response> {
    const res = await deadline.waitFor(fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': SPARQL_QUERY_CONTENT_TYPE,
        Accept: accept,
        [MAX_QUERY_MILLIS_HEADER]: String(this.serverQueryDeadlineMs()),
      },
      body: sparql,
      signal: deadline.signal,
    }));
    if (!res.ok) {
      const text = await deadline.waitFor((options?.maxResponseBytes === undefined
        ? res.text()
        : readResponseTextBounded(res, options.maxResponseBytes)
      ).catch(() => ''));
      throw new Error(`Blazegraph ${failureLabel} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res;
  }

  private async queryConstruct(
    sparql: string,
    deadline: StoreOperationDeadline,
    options?: TripleStoreQueryOptions,
  ): Promise<ConstructResult> {
    const res = await this.postReadQuery(
      sparql,
      'text/x-nquads, application/n-quads',
      deadline,
      options,
      'construct',
    );
    const text = await deadline.waitFor(options?.maxResponseBytes === undefined
      ? res.text()
      : readResponseTextBounded(res, options.maxResponseBytes));
    const quads = parseBlazegraphConstructNQuads(text);
    deadline.check();
    return { type: 'quads', quads };
  }

  // -------------------------------------------------------------------
  // Graph management
  // -------------------------------------------------------------------

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    const r = await this.queryWithOperation(
      `ASK { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`,
      { ...options, source: options?.source ?? 'blazegraph.hasGraph' },
      'hasGraph',
    );
    return r.type === 'boolean' && r.value;
  }

  async createGraph(_graphUri: string): Promise<void> {
    // Blazegraph creates graphs implicitly on insert.
  }

  async dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    await this.sparqlUpdate(
      `DROP SILENT GRAPH <${escapeUri(graphUri)}>`,
      { ...options, source: options?.source ?? 'blazegraph.dropGraph' },
      'dropGraph',
    );
  }

  async listGraphs(options?: TripleStoreQueryOptions): Promise<string[]> {
    const r = await this.queryWithOperation(
      'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }',
      options,
      'listGraphs',
    );
    if (r.type !== 'bindings') return [];
    return r.bindings
      .map((b) => b.g)
      .filter((graph) => Boolean(graph) && !isAtomicGraphReplaceStagingGraph(graph));
  }

  // -------------------------------------------------------------------
  // Counts
  // -------------------------------------------------------------------

  async countQuads(graphUri?: string, options?: QueryOptions): Promise<number> {
    const sparql = graphUri
      ? `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`
      : `SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }`;
    const r = await this.queryWithOperation(
      sparql,
      {
        ...options,
        source: options?.source ?? 'blazegraph.countQuads',
      },
      'countQuads',
    );
    if (r.type === 'bindings' && r.bindings.length > 0) {
      const cell = r.bindings[0].c ?? '';
      const digits = cell.match(/\d+/)?.[0];
      return digits ? parseInt(digits, 10) : 0;
    }
    return 0;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async close(): Promise<void> {
    // Blazegraph is an external service — nothing to close.
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private async sparqlUpdate(
    update: string,
    options?: QueryOptions,
    operation: StoreOperation = 'update',
  ): Promise<void> {
    // Direct POST (W3C SPARQL 1.1 Protocol): send the update as the raw
    // request body with `application/sparql-update` rather than URL-encoded
    // form data (`update=...`). Form-encoded bodies hit Jetty's
    // `maxFormContentSize` cap (~200 KB on stock Blazegraph) and fail with
    // HTTP 400 "Unable to parse form content" — which broke large publishes
    // (a publish issues a DELETE DATA / INSERT over the full quad set). The
    // raw body is not form parsed, so large updates succeed.
    //
    // SPARQL_UPDATE_CONTENT_TYPE carries charset=utf-8 (see sparql-content-types.ts).
    await this.runStoreWork(operation, options, async (deadline) => {
      const res = await deadline.waitFor(fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': SPARQL_UPDATE_CONTENT_TYPE },
        body: update,
        signal: deadline.signal,
      }));
      if (!res.ok) {
        const text = await deadline.waitFor(res.text().catch(() => ''));
        throw new Error(`Blazegraph update failed (${res.status}): ${text.slice(0, 300)}`);
      }
    });
  }
}

// =====================================================================
// Blazegraph JSON result types
// =====================================================================

interface BlazeAskResponse {
  boolean: boolean;
}

// =====================================================================
// N-Quad serialisation / parsing helpers (shared with oxigraph adapter)
// =====================================================================

/**
 * N-Quads serializer for Blazegraph's bulk-insert wire format: a standard
 * N-Quads line ({@link quadToNQuad}) made ASCII-safe
 * ({@link toBlazegraphAsciiSafeNQuads}). This is the single serialization
 * entry point for the adapter's write path, so the Blazegraph wire-format
 * invariant lives at the serialization boundary rather than as a separate
 * post-processing pass a caller must remember to apply. The ASCII-safe pass
 * operates on the assembled line by design: it normalizes `\U` escapes and
 * relies on backslash parity across the whole line, both of which are
 * line-level properties of the rendered N-Quads, not of an individual term.
 */
function quadToBlazegraphNQuad(q: DKGQuad): string {
  return toBlazegraphAsciiSafeNQuads(quadToNQuad(q));
}

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

/**
 * Parse a Blazegraph CONSTRUCT body and reject one that the engine cut short.
 *
 * Blazegraph commits `200 OK` and starts streaming before it knows whether the
 * query will finish. If the query is then killed — by the server-side deadline,
 * or by an engine error mid-result — the error text is appended to the
 * already-committed body. The historical parser skips any line it cannot
 * match, so without an integrity check that body parses into a short,
 * structurally valid, silently-incomplete quad set: a sync page that looks
 * whole and is not.
 *
 * The check is deliberately narrow — it looks for *truncation*, not for any
 * unparseable line — so it cannot start rejecting the odd-but-harmless
 * serialisations the tolerant parser has always accepted:
 *
 *  - the final non-comment line must parse as a complete N-Quad statement
 *  - Blazegraph's appended failure text carries a Java exception marker
 *
 * Parsing and final-line validation consume {@link scanNQuadLines}, so line
 * normalization and parse-failure metadata have one shared definition.
 * Interior unparseable lines retain the adapter's historical tolerant
 * behaviour; an unparseable final statement is the truncation signal that
 * must fail closed.
 */
function parseBlazegraphConstructNQuads(text: string): DKGQuad[] {
  const quads: DKGQuad[] = [];
  let finalStatement: NQuadLineScan | undefined;

  for (const scanned of scanNQuadLines(text)) {
    const { line } = scanned;

    // Both alternatives are line-start anchored on purpose. The engine
    // appends failure text as standalone lines, while the same words inside a
    // stored literal occur after the subject and predicate on a valid N-Quad.
    const javaError = /^(?:[\w.$]+\.)?(?:\w*Exception|\w*Error)\b|^\s*at com\.bigdata\./.exec(line);
    if (javaError) {
      throw new Error(
        'Blazegraph returned a truncated CONSTRUCT result: the response body carries an engine '
        + `error (${javaError[0].slice(0, 120)}). Treating this as a failure rather than as an `
        + 'empty/partial result — see parseBlazegraphConstructNQuads.',
      );
    }

    finalStatement = scanned;
    if (scanned.parsed) quads.push(scanned.quad);
  }

  if (finalStatement && !finalStatement.parsed) {
    throw new Error(
      'Blazegraph returned a truncated CONSTRUCT result: the final statement is incomplete '
      + `(${JSON.stringify(finalStatement.line.slice(-120))}). Treating this as a failure rather `
      + 'than as a partial result — see parseBlazegraphConstructNQuads.',
    );
  }

  return quads;
}

function escapeUri(uri: string): string {
  return uri.replace(/[<>"{}|\\^`]/g, '');
}

function escapeString(s: string): string {
  return s.replace(/[\\"]/g, '\\$&');
}

// =====================================================================
// Oversized-literal guard
// =====================================================================

/**
 * Java Modified UTF-8 byte length of a string.
 *
 * Blazegraph uses `DataOutputStream.writeUTF()` for index keys, which
 * encodes strings in Java's Modified UTF-8 (MUTF-8).  The key
 * differences from standard UTF-8:
 *   - U+0000 (NUL) is encoded as 2 bytes (0xC0, 0x80) instead of 1
 *   - Supplementary codepoints (U+10000–U+10FFFF) are encoded as a
 *     UTF-16 surrogate pair, each surrogate taking 3 MUTF-8 bytes =
 *     6 bytes total (vs 4 in standard UTF-8)
 *
 * `writeUTF()` hard-caps the encoded length at 65 535 bytes.
 * Exceeding this triggers `java.io.UTFDataFormatException` and causes
 * the entire batch to fail with HTTP 500.
 */
const BLAZEGRAPH_MUTF8_LIMIT = 65_535;

function javaModifiedUtf8Length(str: string): number {
  let len = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0) {
      len += 2;
    } else if (code <= 0x7f) {
      len += 1;
    } else if (code <= 0x7ff) {
      len += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — the low surrogate at i+1 will add another 3
      len += 3;
    } else {
      len += 3;
    }
  }
  return len;
}

/**
 * Check quads for literal objects that would exceed Blazegraph's
 * MUTF-8 index key limit.  Throws with details about the offending
 * quads so callers know the batch was NOT fully persisted.
 */
function rejectOversizedLiterals(quads: DKGQuad[], maxBytes: number): DKGQuad[] {
  const rejected: Array<{ subject: string; predicate: string; mutf8Len: number }> = [];
  const out: DKGQuad[] = [];
  for (const q of quads) {
    if (q.object.startsWith('"')) {
      const mutf8Len = javaModifiedUtf8Length(q.object);
      if (mutf8Len > maxBytes) {
        rejected.push({
          subject: q.subject.slice(0, 120),
          predicate: q.predicate.slice(0, 120),
          mutf8Len,
        });
        continue;
      }
    }
    out.push(q);
  }
  if (rejected.length > 0) {
    const details = rejected
      .map((r) => `  subject=${r.subject} predicate=${r.predicate} (${r.mutf8Len} MUTF-8 bytes)`)
      .join('\n');
    throw new Error(
      `[BlazegraphStore] ${rejected.length} quad(s) exceed Blazegraph's ${maxBytes}-byte MUTF-8 limit ` +
      `and would cause UTFDataFormatException. Rejected quads:\n${details}`,
    );
  }
  return out;
}

// =====================================================================
// Adapter registration
// =====================================================================

registerTripleStoreAdapter('blazegraph', async (opts) => {
  const url = opts?.url as string | undefined;
  if (!url) throw new Error('blazegraph adapter requires options.url (SPARQL endpoint)');
  const timeout = opts?.timeout as number | undefined;
  return new BlazegraphStore(url, { timeout });
});
