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
import { SPARQL_QUERY_CONTENT_TYPE, SPARQL_UPDATE_CONTENT_TYPE } from './sparql-content-types.js';
import {
  formatSparqlJsonBindings,
  type AdapterSparqlJsonSelectResponse,
} from './sparql-json-results.js';
import {
  externalStorePriorityScheduler,
  type StorePriorityScheduler,
} from '../store-priority-scheduler.js';
import {
  GraphWriteGenTracker,
  type GraphWriteLifecycle,
  type GraphWriteScope,
} from '../graph-write-gen.js';
import { NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY } from './graph-enumeration-query.js';
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
import { UnsupportedTripleStoreCapabilityError } from '../unsupported-capability-error.js';
import {
  assertQuadLiteralsMutf8Safe,
  classifySparqlOperation,
  getMetrics,
  JAVA_WRITE_UTF_MAX_BYTES,
  type Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AbortableStoreWorkLifecycle, composeAbortSignals } from '../abortable-store-work-lifecycle.js';
import { parseNQuadsTextTolerant } from '../nquads-text.js';
import {
  isStoreOperationTimeoutError,
  StoreOperationTimeoutError,
} from '../store-operation-timeout.js';
import { readSparqlResponseText } from './sparql-response-policy.js';
import type { StoreOperation } from '../store-operation-outcome.js';
import type {
  Rfc64SharedProjectionStreamCapabilityOptionsV1,
  Rfc64SharedProjectionStreamCapabilityV1,
} from '../rfc64-shared-projection-stream-capability.js';
import {
  spoolRfc64SharedProjectionHttpResponseV1,
} from '../rfc64-shared-projection-http-spool.js';
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
/**
 * A non-OK response from the configured SPARQL endpoint.
 *
 * GH#1758 — the upstream status used to be rendered into the message and then
 * recovered at the HTTP boundary with a regex, which coupled the daemon route
 * to this file's exact diagnostic wording. Carrying `status` as data lets the
 * route distinguish "the caller's SPARQL was malformed" (400/422) from
 * "the store rejected US" (401/403/404/429) without string matching.
 *
 * `message` is unchanged from the previous template so existing log greps and
 * error-message assertions keep working.
 */
export class SparqlHttpResponseError extends Error {
  /** Stable discriminant for cross-boundary recognition. */
  readonly code = SPARQL_HTTP_RESPONSE_ERROR_CODE;
  readonly status: number;
  readonly operation: string;
  readonly responseExcerpt: string;

  constructor(operation: string, status: number, responseExcerpt: string) {
    super(`SPARQL HTTP ${operation} failed (${status}): ${responseExcerpt}`);
    this.name = 'SparqlHttpResponseError';
    this.status = status;
    this.operation = operation;
    this.responseExcerpt = responseExcerpt;
  }
}

/** Stable discriminant, so the guard does not key off a mutable class name. */
export const SPARQL_HTTP_RESPONSE_ERROR_CODE = 'SPARQL_HTTP_RESPONSE';

/**
 * The contract a cross-boundary consumer may rely on.
 *
 * PR #2330 review — the previous guard narrowed to the concrete class after
 * checking only `name` and `status`, so `{ name: 'SparqlHttpResponseError',
 * status: 400 }` satisfied it and TypeScript then permitted
 * `err.operation.toUpperCase()` on a value with no `operation`. Narrow to the
 * shape actually validated instead.
 */
export interface SparqlHttpResponseErrorLike {
  readonly code: typeof SPARQL_HTTP_RESPONSE_ERROR_CODE;
  readonly status: number;
  readonly operation: string;
  readonly responseExcerpt: string;
  readonly message: string;
}

/**
 * True when `err` carries the full SPARQL HTTP response contract — either as
 * the concrete class, or structurally when `instanceof` cannot survive the
 * boundary (workers, duplicate module instances). EVERY field the interface
 * promises is validated.
 */
export function isSparqlHttpResponseError(err: unknown): err is SparqlHttpResponseErrorLike {
  if (err instanceof SparqlHttpResponseError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const c = err as Partial<Record<keyof SparqlHttpResponseErrorLike, unknown>>;
  return (
    c.code === SPARQL_HTTP_RESPONSE_ERROR_CODE &&
    typeof c.status === 'number' &&
    Number.isFinite(c.status) &&
    typeof c.operation === 'string' &&
    typeof c.responseExcerpt === 'string' &&
    typeof c.message === 'string'
  );
}

export const DEFAULT_SPARQL_HTTP_TIMEOUT_MS = 30_000;
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

export interface SparqlHttpRecoveryState {
  recovering: boolean;
  generation: number;
}

export type SparqlHttpConsistencyProfile =
  | 'best-effort'
  | 'atomic-update'
  | 'atomic-readback';

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
  /**
   * Runtime-only marker issued by the daemon supervisor for the Oxigraph
   * process it launched. This is deliberately independent of
   * `managedByDkg`, which only describes namespace/cache ownership and may be
   * present in persisted operator configuration.
   */
  managedOxigraph?: boolean;
  /** Runtime-only recovery hook invoked when the HTTP client deadline fires. */
  onClientTimeout?: (operation: string) => void;
  /** Runtime-only managed-server state used to classify restart collateral. */
  getRecoveryState?: () => SparqlHttpRecoveryState;
  /**
   * Certified endpoint guarantees. `atomic-update` means a whole
   * multi-operation SPARQL Update is one transaction. `atomic-readback` adds
   * that a query issued after a completed update observes that update, as
   * required by receipt-bearing CAS. Daemon-owned Oxigraph endpoints imply
   * `atomic-readback`; all other endpoints default to `best-effort`.
   */
  consistencyProfile?: SparqlHttpConsistencyProfile;
  /** Emit sampled slow-query events after this duration. Default 10_000 ms; set 0 to disable. */
  slowQueryThresholdMs?: number;
  /** Sampling rate for slow-query events, from 0 to 1. Default 1. */
  slowQuerySampleRate?: number;
  /** Optional sink for sampled slow-query events; defaults to a compact console warning. */
  onSlowQuery?: (event: SparqlHttpSlowQueryEvent) => void;
  /** Optional scheduler injection for embedded callers and adapter-boundary tests. */
  scheduler?: StorePriorityScheduler;
  /**
   * Monotonic clock for slow-query telemetry. Graph-list revalidation clocks
   * are owned by GraphSetIndexStore.
   */
  now?: () => number;
}

export class SparqlHttpStore implements TripleStore {
  readonly queryCancellation = 'interruptible' as const;
  /**
   * Runtime-issued RFC-64 capability. It is installed per instance only for
   * the daemon-supervised Oxigraph process, never for an arbitrary SPARQL URL.
   */
  readonly rfc64SharedProjectionStreamV1?:
    Rfc64SharedProjectionStreamCapabilityV1['rfc64SharedProjectionStreamV1'];

  private readonly queryEndpoint: string;
  private readonly updateEndpoint: string;
  private readonly timeout: number;
  private readonly headers: Record<string, string>;
  private readonly managedByDkg: boolean;
  private readonly managedOxigraph: boolean;
  private readonly onClientTimeout?: (operation: string) => void;
  private readonly getRecoveryState?: () => SparqlHttpRecoveryState;
  private readonly consistencyProfile: SparqlHttpConsistencyProfile;
  private readonly scheduler: StorePriorityScheduler;

  private readonly now: () => number;
  private readonly slowQueryThresholdMs: number;
  private readonly slowQuerySampleRate: number;
  private readonly onSlowQuery?: (event: SparqlHttpSlowQueryEvent) => void;
  private readonly workLifecycle = new AbortableStoreWorkLifecycle();
  private listGraphsCache: string[] | null = null;
  private listGraphsCachedAt = 0;
  private listGraphsGeneration = 0;
  private listGraphsInFlight: Promise<string[]> | null = null;
  // #1609: per-graph write generations, bumped at the same choke points that
  // invalidate the listGraphs cache (every local mutation). Feeds the chain-
  // reconcile negative memo via `asGraphWriteGenSource` / `getWriteRevision`.
  private readonly writeGen = new GraphWriteGenTracker();

  constructor(options: SparqlHttpStoreOptions) {
    if (!options.queryEndpoint?.trim()) {
      throw new Error('sparql-http adapter requires options.queryEndpoint');
    }
    this.queryEndpoint = options.queryEndpoint.replace(/\/$/, '');
    this.updateEndpoint = (options.updateEndpoint ?? options.queryEndpoint).replace(/\/$/, '');
    this.timeout = options.timeout ?? DEFAULT_SPARQL_HTTP_TIMEOUT_MS;
    this.managedByDkg = options.managedByDkg === true;
    this.managedOxigraph = options.managedOxigraph === true;
    this.onClientTimeout = options.onClientTimeout;
    this.getRecoveryState = options.getRecoveryState;
    this.consistencyProfile = this.managedOxigraph
      ? 'atomic-readback'
      : normalizeConsistencyProfile(options.consistencyProfile);
    this.scheduler = options.scheduler ?? externalStorePriorityScheduler;
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
    // Content-Type is set per-request by the query/mutation transports (direct POST:
    // application/sparql-query | application/sparql-update). Only shared
    // headers (e.g. Authorization) belong here.
    this.headers = {};
    if (options.auth) {
      this.headers['Authorization'] = options.auth;
    }
    if (this.managedOxigraph) {
      this.rfc64SharedProjectionStreamV1 = (operation, capabilityOptions) =>
        this.openManagedOxigraphSharedProjectionV1(operation, capabilityOptions);
    }
  }

  private openManagedOxigraphSharedProjectionV1(
    operation: Rfc64SharedProjectionStreamOperationV1,
    options: Rfc64SharedProjectionStreamCapabilityOptionsV1,
  ): ReturnType<Rfc64SharedProjectionStreamCapabilityV1['rfc64SharedProjectionStreamV1']> {
    return this.runStoreWork(
      'construct',
      {
        priority: 'background',
        signal: options.signal,
        source: 'rfc64.shared-projection.SYNC_KA_SHARED_PROJECTION_STREAM_V1',
      },
      async (lifecycleSignal) => {
        const effectiveOptions: SparqlHttpQueryOptions = {
          priority: 'background',
          signal: lifecycleSignal,
          source: 'rfc64.shared-projection.SYNC_KA_SHARED_PROJECTION_STREAM_V1',
        };
        return this.postQuery(
          operation.sparql,
          'application/n-quads, text/n-quads',
          'construct',
          'construct',
          effectiveOptions,
          async (response) => {
            if (!response.ok) {
              const text = await readSparqlResponseText(response, {
                maxResponseBytes: Math.min(options.byteCeiling, 64 * 1024),
                managedOxigraph: true,
                operation: 'construct',
                tolerateReadFailure: true,
              });
              throw new SparqlHttpResponseError(
                'rfc64-shared-projection',
                response.status,
                text.slice(0, 300),
              );
            }
            if (response.body === null) {
              throw new SparqlHttpResponseError(
                'rfc64-shared-projection',
                response.status,
                'response has no readable body',
              );
            }
            return spoolRfc64SharedProjectionHttpResponseV1({
              body: response.body,
              operation,
              byteCeiling: options.byteCeiling,
              signal: lifecycleSignal,
              consumptionSignal: options.signal,
              managedOxigraph: true,
            });
          },
        );
      },
    );
  }

  private runStoreWork<T>(
    operation: StoreOperation,
    options: QueryOptions | undefined,
    work: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    const recovery = this.readRecoveryState();
    if (recovery?.recovering) {
      return Promise.reject(this.recoveryError(operation, 'not_started'));
    }
    return this.workLifecycle.run(
      options?.signal,
      (signal) => {
        return this.scheduler.run(
          options?.priority,
          options?.source ?? `sparql-http.${operation}`,
          () => work(signal),
          signal,
          { storeOperation: operation },
        );
      },
    );
  }

  private readRecoveryState(): SparqlHttpRecoveryState | null {
    if (!this.managedOxigraph || !this.getRecoveryState) return null;
    try {
      const state = this.getRecoveryState();
      if (
        typeof state?.recovering === 'boolean'
        && Number.isSafeInteger(state.generation)
        && state.generation >= 0
      ) return state;
    } catch {
      // A broken observability hook must not replace the endpoint's real result.
    }
    return null;
  }

  private recoveryError(
    operation: StoreOperation,
    outcome: 'not_started' | 'indeterminate',
    cause?: unknown,
  ): StoreOperationTimeoutError {
    return new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation,
      outcome,
      message: outcome === 'not_started'
        ? `Managed Oxigraph is recovering; ${operation} was not started`
        : `Managed Oxigraph recovery interrupted ${operation}; outcome is indeterminate`,
      cause,
    });
  }

  private recoveryInterrupted(
    started: SparqlHttpRecoveryState | null,
  ): boolean {
    const current = this.readRecoveryState();
    return current !== null && (
      current.recovering
      || (started !== null && current.generation !== started.generation)
    );
  }

  private notifyClientTimeout(operation: StoreOperation): void {
    try {
      this.onClientTimeout?.(operation);
    } catch {
      // Recovery notification must never replace the typed timeout contract.
    }
  }

  getPressureSnapshot(): StorePressureSnapshot {
    return this.scheduler.snapshot;
  }

  /** {@link GraphWriteGenSource} capability (#1609) — see graph-write-gen.ts. */
  getWriteGen(graphPrefix: string): number {
    return this.writeGen.getWriteGen(graphPrefix);
  }

  getWriteRevision(graphPrefix: string) {
    return this.writeGen.getWriteRevision(graphPrefix);
  }

  private async postQuery<T>(
    sparql: string,
    accept: string,
    operation: 'query' | 'construct',
    storeOperation: StoreOperation,
    options: SparqlHttpQueryOptions | undefined,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const recoveryAtStart = this.readRecoveryState();
    if (recoveryAtStart?.recovering) {
      throw this.recoveryError(storeOperation, 'not_started');
    }
    // Direct POST (W3C SPARQL 1.1 Protocol §2.1.3): the query is the raw
    // request body with `application/sparql-query`, not URL-encoded form
    // data. Form-encoded bodies (`query=...`) are parsed by the server's
    // form handler, which on Jetty-backed stores (Blazegraph) caps at
    // `maxFormContentSize` (~200 KB) and rejects larger payloads with
    // HTTP 400 "Unable to parse form content". The direct-POST body is not
    // form parsed, so large queries are not capped.
    // charset=utf-8: Jetty-backed stores (Blazegraph) decode a raw body whose
    // Content-Type lacks a charset parameter as ISO-8859-1 (servlet default),
    // mojibake-ing any non-ASCII character in the query. UTF-8 is what the
    // SPARQL protocol prescribes.
    const timeoutSignal = AbortSignal.timeout(this.timeout);
    const signalScope = composeAbortSignals(options?.signal, timeoutSignal);
    const signal = signalScope.signal ?? timeoutSignal;
    try {
      const response = await fetch(this.queryEndpoint, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': SPARQL_QUERY_CONTENT_TYPE, Accept: accept },
        body: sparql,
        signal,
      });
      // Keep the composed caller/deadline signal linked until the response body
      // has settled. A fetch promise may resolve as soon as headers arrive,
      // while JSON/N-Quads parsing is still holding the scheduler admission.
      return await consume(response);
    } catch (error) {
      if (signal.aborted) {
        getMetrics().storeCancellationCompletedTotal.add(1, {
          operation,
          source: options?.source ?? `sparql-http.${operation}`,
        });
      }
      if (timeoutSignal.aborted) {
        this.notifyClientTimeout(operation);
        throw new StoreOperationTimeoutError({
          backend: this.managedOxigraph ? 'oxigraph-server' : 'sparql-http',
          operation,
          storeOperation,
          timeoutMs: this.timeout,
          cause: error,
        });
      }
      if (this.recoveryInterrupted(recoveryAtStart)) {
        throw this.recoveryError(storeOperation, 'indeterminate', error);
      }
      throw error;
    } finally {
      signalScope.dispose();
    }
  }

  /** Best-effort cleanup transport for an already tracked atomic mutation. */
  private async postCleanupUpdate(
    update: string,
    options?: QueryOptions,
    operation: StoreOperation = 'update',
  ): Promise<void> {
    // Direct POST (W3C SPARQL 1.1 Protocol §2.2.2): the update is the raw
    // request body with `application/sparql-update`, not URL-encoded form
    // data. See postQuery for why form encoding breaks large payloads.
    return this.runStoreWork(operation, options, async (lifecycleSignal) => {
      const recoveryAtStart = this.readRecoveryState();
      if (recoveryAtStart?.recovering) {
        throw this.recoveryError(operation, 'not_started');
      }
      const timeoutSignal = AbortSignal.timeout(this.timeout);
      const signalScope = composeAbortSignals(lifecycleSignal, timeoutSignal);
      const signal = signalScope.signal ?? timeoutSignal;
      // charset=utf-8: same ISO-8859-1 default-decode hazard as postQuery —
      // without it a Jetty-backed store corrupts non-ASCII INSERT DATA
      // literals and DELETE DATA patterns silently stop matching.
      try {
        throwIfAborted(signal);
        const res = await fetch(this.updateEndpoint, {
          method: 'POST',
          headers: { ...this.headers, 'Content-Type': SPARQL_UPDATE_CONTENT_TYPE },
          body: update,
          signal,
        });
        if (!res.ok) {
          // Keep scheduler admission until the response body has settled too;
          // otherwise retries can dispatch while an error body is unwinding.
          const text = await res.text().catch(() => '');
          throw new SparqlHttpResponseError(operation, res.status, text.slice(0, 300));
        }
      } catch (error) {
        if (signal.aborted) {
          getMetrics().storeCancellationCompletedTotal.add(1, {
            operation,
            source: options?.source ?? `sparql-http.${operation}`,
          });
        }
        if (timeoutSignal.aborted) {
          this.notifyClientTimeout(operation);
          throw new StoreOperationTimeoutError({
            backend: this.managedOxigraph ? 'oxigraph-server' : 'sparql-http',
            operation,
            timeoutMs: this.timeout,
            cause: error,
          });
        }
        if (this.recoveryInterrupted(recoveryAtStart)) {
          throw this.recoveryError(operation, 'indeterminate', error);
        }
        throw error;
      } finally {
        signalScope.dispose();
      }
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
    await this.runRemoteGraphMutation({
      scope: { kind: 'graphs', graphs: [...byGraph.keys()] },
      update,
      options: {
        ...options,
        source: options?.source ?? 'sparql-http.insert',
      },
      operation: 'insert',
    });
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
    await this.runRemoteGraphMutation({
      scope: { kind: 'graphs', graphs: [...new Set(quads.map((q) => q.graph || ''))] },
      update,
      options: {
        ...options,
        source: options?.source ?? 'sparql-http.delete',
      },
      operation: 'delete',
    });
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
    await this.runRemoteGraphMutation({
      scope: graphUri
        ? { kind: 'graphs', graphs: [graphUri] }
        : { kind: 'all' },
      update,
      options: {
        ...options,
        source: options?.source ?? 'sparql-http.deleteByPattern',
      },
      operation: 'deleteByPattern',
    });
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
    await this.runRemoteGraphMutation({
      scope: { kind: 'graphs', graphs: [graphUri] },
      update,
      options: {
        ...options,
        source: options?.source ?? 'sparql-http.deleteBySubjectPrefix',
      },
      operation: 'deleteBySubjectPrefix',
    });
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
    await this.runRemoteGraphMutation({
      // `touchedGraphs` hints only membership changes, not every graph whose
      // CONTENT a raw UPDATE mutates — an unscoped lifecycle is the only sound scope.
      scope: { kind: 'all' },
      update: sparql,
      options: {
        ...options,
        source: options?.source ?? 'sparql-http.update',
      },
      operation: 'update',
    });
  }

  async replaceGraph(
    graphUri: string,
    quads: DKGQuad[],
    options?: QueryOptions,
  ): Promise<void> {
    if (!this.supportsConsistency('atomic-update')) {
      // A generic SPARQL endpoint may apply the staged DROP/INSERT/MOVE
      // operations non-transactionally, which can strand the target graph in a
      // partial state — the one outcome replaceGraph must never produce. Fail
      // closed (before any request) so callers take their non-atomic fallback.
      throw new UnsupportedTripleStoreCapabilityError('replaceGraph', 'SparqlHttpStore');
    }
    assertQuadLiteralsMutf8Safe(quads, {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
      label: 'SparqlHttpStore.replaceGraph',
    });
    const plan = buildAtomicGraphReplaceUpdate(graphUri, quads);
    await this.runRemoteGraphMutation({
      scope: { kind: 'graphs', graphs: [graphUri] },
      update: plan.update,
      options: { ...options, source: options?.source ?? 'sparql-http.replaceGraph' },
      operation: 'replaceGraph',
      cleanup: plan.cleanup
        ? {
          update: plan.cleanup,
          options: { ...options, source: 'sparql-http.replaceGraph.cleanup' },
          operation: 'replaceGraph',
        }
        : undefined,
    });
  }

  async replaceGraphAndSubject(
    graphUri: string,
    graphQuads: DKGQuad[],
    metaGraphUri: string,
    metadataSubject: string,
    metadataQuads: DKGQuad[],
    options?: QueryOptions,
  ): Promise<void> {
    if (!this.supportsConsistency('atomic-update')) {
      throw new UnsupportedTripleStoreCapabilityError(
        'replaceGraphAndSubject',
        'SparqlHttpStore',
      );
    }
    assertQuadLiteralsMutf8Safe([...graphQuads, ...metadataQuads], {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
      label: 'SparqlHttpStore.replaceGraphAndSubject',
    });
    const plan = buildAtomicGraphAndSubjectReplaceUpdate(
      graphUri,
      graphQuads,
      metaGraphUri,
      metadataSubject,
      metadataQuads,
    );
    await this.runRemoteGraphMutation({
      scope: { kind: 'graphs', graphs: [graphUri, metaGraphUri] },
      update: plan.update,
      options: { ...options, source: options?.source ?? 'sparql-http.replaceGraphAndSubject' },
      operation: 'replaceGraphAndSubject',
      cleanup: {
        update: plan.cleanup,
        options: { ...options, source: 'sparql-http.replaceGraphAndSubject.cleanup' },
        operation: 'replaceGraphAndSubject',
      },
    });
  }

  async replaceSubject(
    graphUri: string,
    subject: string,
    quads: DKGQuad[],
    options?: QueryOptions,
  ): Promise<void> {
    if (!this.supportsConsistency('atomic-update')) {
      // A generic endpoint may apply DELETE WHERE; INSERT DATA as separate
      // operations, re-exposing the transient-empty subject. Fail closed before
      // any request so callers take their non-atomic delete-then-insert fallback.
      throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'SparqlHttpStore');
    }
    assertQuadLiteralsMutf8Safe(quads, {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
      label: 'SparqlHttpStore.replaceSubject',
    });
    const update = buildAtomicSubjectReplaceUpdate(graphUri, subject, quads);
    await this.runRemoteGraphMutation({
      scope: { kind: 'graphs', graphs: [graphUri] },
      update,
      options: { ...options, source: options?.source ?? 'sparql-http.replaceSubject' },
      operation: 'replaceSubject',
    });
  }

  async rfc64AuthorCommitCasV1(
    input: Rfc64AuthorCommitCasInputV1,
    options?: QueryOptions,
  ): Promise<Rfc64AuthorCommitCasResultV1> {
    if (!this.supportsConsistency('atomic-readback')) {
      throw new UnsupportedTripleStoreCapabilityError(
        'rfc64AuthorCommitCasV1',
        'SparqlHttpStore',
      );
    }
    const plan = buildRfc64AuthorCommitCasUpdateV1(input);
    const { signal: _callerSignal, ...cleanupOptions } = options ?? {};
    assertQuadLiteralsMutf8Safe(plan.semanticQuads, {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
      label: 'SparqlHttpStore.rfc64AuthorCommitCasV1',
    });
    return executeRfc64AuthorCommitCasV1({
      executeUpdate: () => this.runRemoteGraphMutation({
        // The transactional request always mutates private receipt/staging
        // graphs, while semantic graphs change only when the receipt is true.
        scope: { kind: 'graphs', graphs: [plan.receiptGraph] },
        update: plan.update,
        options: { ...options, source: options?.source ?? 'sparql-http.rfc64AuthorCommitCasV1' },
        operation: 'rfc64AuthorCommitCasV1',
      }),
      readReceipt: () => this.query(plan.receiptAsk, {
        ...options,
        source: 'sparql-http.rfc64AuthorCommitCasV1.receipt',
      }),
      cleanup: () => this.postCleanupUpdate(
        plan.cleanup,
        { ...cleanupOptions, source: 'sparql-http.rfc64AuthorCommitCasV1.cleanup' },
        'rfc64AuthorCommitCasV1',
      ),
      onCommitted: () => {
        this.writeGen.recordWrite({ kind: 'graphs', graphs: [...plan.touchedGraphs] });
      },
    });
  }

  /**
   * The only dispatch path for public remote mutations. The request owns its
   * write scope, HTTP dispatch, lifecycle transitions, graph-list invalidation,
   * timeout classification, and optional staging cleanup as one operation.
   * There is no callback a caller can omit while still sending an update.
   */
  private supportsConsistency(
    required: Exclude<SparqlHttpConsistencyProfile, 'best-effort'>,
  ): boolean {
    return this.consistencyProfile === 'atomic-readback'
      || this.consistencyProfile === required;
  }

  private async runRemoteGraphMutation(opts: {
    scope: GraphWriteScope;
    update: string;
    options?: QueryOptions;
    operation: StoreOperation;
    cleanup?: {
      update: string;
      options?: QueryOptions;
      operation: StoreOperation;
    };
  }): Promise<void> {
    let lifecycle: GraphWriteLifecycle | undefined;
    try {
      await this.runStoreWork(opts.operation, opts.options, async (lifecycleSignal) => {
        const recoveryAtStart = this.readRecoveryState();
        if (recoveryAtStart?.recovering) {
          throw this.recoveryError(opts.operation, 'not_started');
        }
        const timeoutSignal = AbortSignal.timeout(this.timeout);
        const signalScope = composeAbortSignals(lifecycleSignal, timeoutSignal);
        const signal = signalScope.signal ?? timeoutSignal;
        try {
          // The lifecycle begins after every pre-dispatch refusal and directly
          // before fetch. From this point onward the server may have committed.
          throwIfAborted(signal);
          lifecycle = this.writeGen.beginWrite(opts.scope);
          this.invalidateListGraphsCache();
          const res = await fetch(this.updateEndpoint, {
            method: 'POST',
            headers: { ...this.headers, 'Content-Type': SPARQL_UPDATE_CONTENT_TYPE },
            body: opts.update,
            signal,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new SparqlHttpResponseError(
              opts.operation,
              res.status,
              text.slice(0, 300),
            );
          }
        } catch (error) {
          if (signal.aborted) {
            getMetrics().storeCancellationCompletedTotal.add(1, {
              operation: opts.operation,
              source: opts.options?.source ?? `sparql-http.${opts.operation}`,
            });
          }
          if (timeoutSignal.aborted) {
            this.notifyClientTimeout(opts.operation);
            throw new StoreOperationTimeoutError({
              backend: this.managedOxigraph ? 'oxigraph-server' : 'sparql-http',
              operation: opts.operation,
              timeoutMs: this.timeout,
              cause: error,
            });
          }
          if (this.recoveryInterrupted(recoveryAtStart)) {
            throw this.recoveryError(opts.operation, 'indeterminate', error);
          }
          throw error;
        } finally {
          signalScope.dispose();
        }
      });
    } catch (error) {
      if (opts.cleanup) {
        await this.postCleanupUpdate(
          opts.cleanup.update,
          opts.cleanup.options,
          opts.cleanup.operation,
        ).catch(() => undefined);
      }
      if (lifecycle) {
        if (isStoreOperationTimeoutError(error) && error.outcome === 'not_started') {
          lifecycle.settle();
        } else {
          lifecycle.indeterminate();
        }
        this.invalidateListGraphsCache();
      }
      throw error;
    }
    lifecycle?.settle();
    if (lifecycle) this.invalidateListGraphsCache();
  }

  async query(sparql: string, options?: SparqlHttpQueryOptions): Promise<QueryResult> {
    return this.queryWithOperation(sparql, options);
  }

  private async queryWithOperation(
    sparql: string,
    options: SparqlHttpQueryOptions | undefined,
    storeOperation?: StoreOperation,
  ): Promise<QueryResult> {
    const trimmed = sparql.trim();
    const upper = trimmed.toUpperCase();
    const isAsk = upper.startsWith('ASK');
    const isConstruct = upper.startsWith('CONSTRUCT') || upper.startsWith('DESCRIBE');
    const canonicalOperation = storeOperation ?? (isConstruct ? 'construct' : 'query');
    return this.runStoreWork(canonicalOperation, options, async (lifecycleSignal) => {
      const effectiveOptions: SparqlHttpQueryOptions = {
        ...options,
        signal: lifecycleSignal,
      };
      const startedAt = this.now();
      throwIfAborted(lifecycleSignal);

      try {
        if (isConstruct) {
          return await this.queryConstruct(trimmed, effectiveOptions, canonicalOperation);
        }

        return await this.postQuery(
          trimmed,
          'application/sparql-results+json',
          'query',
          canonicalOperation,
          effectiveOptions,
          async (res) => {
            if (!res.ok) {
              const text = await readSparqlResponseText(res, {
                maxResponseBytes: effectiveOptions.maxResponseBytes,
                managedOxigraph: this.managedOxigraph,
                operation: canonicalOperation,
                tolerateReadFailure: true,
              });
              throw new SparqlHttpResponseError('query', res.status, text.slice(0, 300));
            }

            const text = await readSparqlResponseText(res, {
              maxResponseBytes: effectiveOptions.maxResponseBytes,
              managedOxigraph: this.managedOxigraph,
              operation: canonicalOperation,
            });
            const json = JSON.parse(text) as AdapterSparqlJsonSelectResponse | W3CAskResponse;

            if (isAsk || 'boolean' in json) {
              return {
                type: 'boolean',
                value: (json as W3CAskResponse).boolean,
              } satisfies AskResult;
            }

            const bindings = formatSparqlJsonBindings(json as AdapterSparqlJsonSelectResponse);
            return { type: 'bindings', bindings } satisfies SelectResult;
          },
        );
      } finally {
        this.maybeEmitSlowQuery({
          sparql: trimmed,
          source: options?.source,
          startedAt,
        });
      }
    });
  }

  private async queryConstruct(
    sparql: string,
    options: SparqlHttpQueryOptions | undefined,
    storeOperation: StoreOperation,
  ): Promise<ConstructResult> {
    return this.postQuery(
      sparql,
      'application/n-quads, text/n-quads',
      'construct',
      storeOperation,
      options,
      async (res) => {
        if (!res.ok) {
          const text = await readSparqlResponseText(res, {
            maxResponseBytes: options?.maxResponseBytes,
            managedOxigraph: this.managedOxigraph,
            operation: storeOperation,
            tolerateReadFailure: true,
          });
          throw new SparqlHttpResponseError('construct', res.status, text.slice(0, 300));
        }
        const text = await readSparqlResponseText(res, {
          maxResponseBytes: options?.maxResponseBytes,
          managedOxigraph: this.managedOxigraph,
          operation: storeOperation,
        });
        const quads = parseNQuadsTextTolerant(text);
        return { type: 'quads', quads };
      },
    );
  }

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    const r = await this.queryWithOperation(
      `ASK { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } }`,
      { ...options, source: options?.source ?? 'sparql-http.hasGraph' },
      'hasGraph',
    );
    return r.type === 'boolean' && r.value;
  }

  async createGraph(_graphUri: string): Promise<void> {
    // Graphs are created implicitly on first insert in SPARQL 1.1.
  }

  async dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    const update = `DROP SILENT GRAPH <${escapeUri(graphUri)}>`;
    await this.runRemoteGraphMutation({
      scope: { kind: 'graphs', graphs: [graphUri] },
      update,
      options: {
        ...options,
        source: options?.source ?? 'sparql-http.dropGraph',
      },
      operation: 'dropGraph',
    });
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
    // Index-read enumeration shared with OxigraphStore — see the rationale on
    // NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY (O(#graphs) vs the legacy O(#quads)
    // scan; FILTER EXISTS preserves the non-empty-only contract).
    const r = await this.queryWithOperation(
      NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY,
      { ...options, source: options?.source ?? 'sparql-http.listGraphs' },
      'listGraphs',
    );
    return r.type === 'bindings'
      ? r.bindings
          .map((b) => b.g)
          .filter((graph) => Boolean(graph) && !isAtomicGraphReplaceStagingGraph(graph))
      : [];
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
    const r = await this.queryWithOperation(
      sparql,
      {
        ...options,
        source: options?.source ?? 'sparql-http.countQuads',
      },
      'countQuads',
    );
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
    startedAt: number;
  }): void {
    if (this.slowQueryThresholdMs <= 0 || this.slowQuerySampleRate <= 0) return;
    const elapsedMs = this.now() - input.startedAt;
    if (elapsedMs < this.slowQueryThresholdMs) return;
    if (this.slowQuerySampleRate < 1 && Math.random() >= this.slowQuerySampleRate) return;

    const event: SparqlHttpSlowQueryEvent = {
      source: normalizeQuerySource(input.source),
      // Classification scans the complete query. Keep it behind the same
      // threshold/sample gates as hashing so normal reads pay no telemetry cost.
      operation: inferQueryOperation(input.sparql),
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
    // A managed endpoint is stopped immediately after store.close(). The
    // lifecycle owns one complete generation, aborting and draining every
    // operation admitted before close while rejecting work attempted during
    // close. A fresh generation is installed only after the drain completes.
    await this.workLifecycle.close(new Error('SparqlHttpStore closed'));
  }
}

function normalizeConsistencyProfile(value: unknown): SparqlHttpConsistencyProfile {
  if (value === undefined) return 'best-effort';
  if (value === 'best-effort' || value === 'atomic-update' || value === 'atomic-readback') {
    return value;
  }
  throw new Error(
    'sparql-http consistencyProfile must be best-effort, atomic-update, or atomic-readback',
  );
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
  const operation = classifySparqlOperation(sparql);
  if (operation.kind !== 'read') return 'unknown';
  switch (operation.form) {
    case 'SELECT': return 'select';
    case 'ASK': return 'ask';
    case 'CONSTRUCT': return 'construct';
    case 'DESCRIBE': return 'describe';
  }
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

interface W3CAskResponse {
  boolean: boolean;
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
