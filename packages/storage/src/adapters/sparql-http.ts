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
  BoundedQueryResponseCapability,
  Quad as DKGQuad,
  QueryOptions,
  UpdateOptions,
  QueryResult,
  ConstructResult,
  StorePressureSnapshot,
} from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';
import { SPARQL_QUERY_CONTENT_TYPE, SPARQL_UPDATE_CONTENT_TYPE } from './sparql-content-types.js';
import { decodeSparqlJsonQueryResult } from '../sparql-json-query-result.js';
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
  type Rfc64AuthorCommitCasInputV1,
  type Rfc64AuthorCommitCasResultV1,
} from '../rfc64-author-commit-cas.js';
import { UnsupportedTripleStoreCapabilityError } from '../unsupported-capability-error.js';
import {
  assertQuadLiteralsMutf8Safe,
  classifySparqlOperation,
  getMetrics,
  JAVA_WRITE_UTF_MAX_BYTES,
  type Rfc64SemanticReadOperationV1,
} from '@origintrail-official/dkg-core';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  AbortableStoreWorkLifecycle,
  composeAbortSignals,
  raceStoreWorkAgainstAbort,
  type StoreWorkContext,
} from '../abortable-store-work-lifecycle.js';
import { parseNQuadsTextTolerant } from '../nquads-text.js';
import {
  sparqlStatements,
  type SparqlQueryPlan,
  type SparqlUpdatePlan,
} from './sparql-statements.js';
import { renderBlankNodeSafeDelete } from './blank-node-safe-delete.js';
import { ADAPTER_SPARQL_TERM_POLICY } from './sparql-term-policy.js';
import {
  isStoreOperationTimeoutError,
  StoreOperationTimeoutError,
} from '../store-operation-timeout.js';
import { readSparqlResponseText } from './sparql-response-policy.js';
import { relayAnswer, type RelayedAnswer } from './sparql-answer-relay.js';
import type { StoreOperation } from '../store-operation-outcome.js';
import type {
  Rfc64SharedProjectionStreamCapabilityV1,
} from '../rfc64-shared-projection-stream-capability.js';
import {
  createManagedOxigraphRuntimeStoreConfigV1,
  getManagedOxigraphRuntimeConstructionAuthorityV1,
  getManagedOxigraphRuntimeHooksV1,
  isManagedOxigraphRuntimeConstructionAuthorityV1,
  snapshotManagedOxigraphRuntimeOptionsV1,
  type ManagedOxigraphRuntimeActivityLeaseV1,
  type ManagedOxigraphRuntimeHooksV1,
  type ManagedOxigraphRuntimeStateV1,
} from '../managed-oxigraph-runtime-store.js';
import {
  createRfc64HttpSharedProjectionRunnerV1,
  RFC64_MANAGED_OXIGRAPH_PROJECTION_RESPONSE_STRATEGY_V1,
  type Rfc64HttpProjectionRequestV1,
} from '../rfc64-http-shared-projection-runner.js';
import {
  executeRfc64ExactBindingsReadCapabilityV1,
  executeRfc64SemanticReadCapabilityV1,
  type Rfc64ExactBindingsReadOperationV1,
} from '../rfc64-exact-bindings-read-capability.js';
import { CANCEL_ON_ABORT, ABANDONED_READ_DRAIN_BUDGET_BYTES, raceCallerAbandon,
  snapshotManagedRecoveryCapability, type SparqlHttpReadPolicy,
  type SparqlHttpManagedRecoveryV1 } from './managed-sparql-recovery.js';
export { ABANDONED_READ_DRAIN_BUDGET_BYTES } from './managed-sparql-recovery.js';
export type { SparqlHttpRecoveryState, SparqlHttpManagedRecoveryV1 } from './managed-sparql-recovery.js';
import { ManagedWorkRecoveryCoordinatorV1 } from
  '../managed-work-recovery-coordinator.js';
import { refusesSparqlHttpAdmissionV1, type SparqlHttpOperationAdmissionV1 } from './managed-sparql-recovery.js';
import { runSparqlHttpAuthorCommitV1 } from './sparql-http-author-commit.js';

/** Every SPARQL statement this adapter builds by interpolation. */
const statements = sparqlStatements('sparql-http');

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
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
   * @deprecated Ignored. Retained only so old persisted configuration fails
   * closed instead of failing boot; it never grants managed guarantees.
   */
  managedOxigraph?: boolean;
  /**
   * Runtime-only compatibility capability for a DKG-managed Oxigraph
   * supervisor. Generic stores cannot use it to grant managed authority.
   */
  managedRecovery?: SparqlHttpManagedRecoveryV1;
  /**
   * Certified endpoint guarantees. `atomic-update` means a whole
   * multi-operation SPARQL Update is one transaction. `atomic-readback` adds
   * that a query issued after a completed update observes that update, as
   * required by receipt-bearing CAS. Daemon-owned Oxigraph endpoints imply
   * `atomic-readback`; all other endpoints default to `best-effort`.
   */
  consistencyProfile?: SparqlHttpConsistencyProfile;
  /**
   * @deprecated Use `consistencyProfile: 'atomic-update'` instead.
   *
   * This compatibility alias preserves the pre-profile public API. It grants
   * transactional update capability only; receipt-bearing CAS still requires
   * `atomic-readback` or a daemon-certified managed Oxigraph endpoint.
   */
  atomicUpdates?: boolean;
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

export class SparqlHttpStore implements TripleStore, BoundedQueryResponseCapability {
  readonly queryResponseLimitMode = 'pre-materialization' as const;
  readonly writeRevisionCoverage = 'process-local' as const;
  readonly queryCancellation = 'interruptible' as const;
  /**
   * RFC-64 stream capability installed only for a storage-created managed
   * Oxigraph runtime configuration, never for an arbitrary SPARQL URL.
   */
  readonly rfc64SharedProjectionStreamV1?:
    Rfc64SharedProjectionStreamCapabilityV1['rfc64SharedProjectionStreamV1'];
  readonly rfc64SharedProjectionStreamCertifiedV1: true | false;
  readonly rfc64ExactBindingsReadCertifiedV1: true | false;
  readonly rfc64SemanticReadCertifiedV1: true | false;

  private readonly queryEndpoint: string;
  private readonly updateEndpoint: string;
  private readonly timeout: number;
  private readonly headers: Record<string, string>;
  private readonly managedByDkg: boolean;
  private readonly managedOxigraph: boolean;
  private readonly onClientTimeout?: (operation: StoreOperation) => void;
  private readonly getRecoveryState?: () => ManagedOxigraphRuntimeStateV1;
  private managedActivityLease: ManagedOxigraphRuntimeActivityLeaseV1 | null = null;
  private readonly consistencyProfile: SparqlHttpConsistencyProfile;
  private readonly scheduler: StorePriorityScheduler;

  private readonly now: () => number;
  private readonly slowQueryThresholdMs: number;
  private readonly slowQuerySampleRate: number;
  private readonly onSlowQuery?: (event: SparqlHttpSlowQueryEvent) => void;
  private readonly workLifecycle: AbortableStoreWorkLifecycle;
  private readonly managedAbandonedWorkRecovery: ManagedWorkRecoveryCoordinatorV1;
  private activeStoreOperations = 0;
  private retainedManagedWork = 0;
  private listGraphsCache: string[] | null = null;
  private listGraphsCachedAt = 0;
  private listGraphsGeneration = 0;
  private listGraphsInFlight: Promise<string[]> | null = null;
  // #1609: per-graph write generations, bumped at the same choke points that
  // invalidate the listGraphs cache (every local mutation). Feeds the chain-
  // reconcile negative memo via `asGraphWriteGenSource` / `getWriteRevision`.
  private readonly writeGen = new GraphWriteGenTracker();

  constructor(
    options: SparqlHttpStoreOptions,
    constructionAuthority?: object,
  ) {
    if (!options.queryEndpoint?.trim()) {
      throw new Error('sparql-http adapter requires options.queryEndpoint');
    }
    this.queryEndpoint = options.queryEndpoint.replace(/\/$/, '');
    this.updateEndpoint = (options.updateEndpoint ?? options.queryEndpoint).replace(/\/$/, '');
    this.timeout = options.timeout ?? DEFAULT_SPARQL_HTTP_TIMEOUT_MS;
    this.managedByDkg = options.managedByDkg === true;
    this.managedOxigraph = isManagedOxigraphRuntimeConstructionAuthorityV1(
      constructionAuthority,
    );
    const managedRuntimeHooks = getManagedOxigraphRuntimeHooksV1(constructionAuthority);
    const managedRecovery = this.managedOxigraph
      ? snapshotManagedRecoveryCapability(options.managedRecovery)
      : undefined;
    this.rfc64SharedProjectionStreamCertifiedV1 = this.managedOxigraph;
    this.rfc64ExactBindingsReadCertifiedV1 = this.managedOxigraph;
    this.rfc64SemanticReadCertifiedV1 = this.managedOxigraph;
    this.onClientTimeout = managedRuntimeHooks?.onClientTimeout
      ?? managedRecovery?.recover;
    this.getRecoveryState = managedRuntimeHooks?.getRecoveryState
      ?? managedRecovery?.readState;
    this.managedActivityLease = this.openManagedActivityLease(managedRuntimeHooks);
    this.workLifecycle = new AbortableStoreWorkLifecycle({
      onActivityChange: (activeOperations) => {
        this.activeStoreOperations = activeOperations;
        this.reportManagedRuntimeActivity(managedRuntimeHooks);
      },
    });
    this.consistencyProfile = this.managedOxigraph
      ? 'atomic-readback'
      : resolveConsistencyProfile(options);
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
    this.managedAbandonedWorkRecovery = new ManagedWorkRecoveryCoordinatorV1({
      now: this.now,
      capability: this.managedOxigraph && this.onClientTimeout
        ? {
            readState: () => this.readRecoveryState(),
            recover: this.onClientTimeout,
          }
        : undefined,
      onPendingChange: (pending) => {
        this.retainedManagedWork = pending ? 1 : 0;
        this.reportManagedRuntimeActivity(managedRuntimeHooks);
      },
    });
    // Content-Type is set per-request by the query/mutation transports (direct POST:
    // application/sparql-query | application/sparql-update). Only shared
    // headers (e.g. Authorization) belong here.
    this.headers = {};
    if (options.auth) {
      this.headers['Authorization'] = options.auth;
    }
    if (this.managedOxigraph) {
      this.rfc64SharedProjectionStreamV1 = createRfc64HttpSharedProjectionRunnerV1({
        runConstruct: (request, consume) => this.runStreamingConstruct(request, consume),
        responseError: (status, excerpt) => new SparqlHttpResponseError(
          'rfc64-shared-projection',
          status,
          excerpt,
        ),
      }, RFC64_MANAGED_OXIGRAPH_PROJECTION_RESPONSE_STRATEGY_V1);
    }
  }

  private reportManagedRuntimeActivity(
    hooks: Readonly<ManagedOxigraphRuntimeHooksV1> | undefined,
  ): void {
    try {
      const activeOperations = this.activeStoreOperations + this.retainedManagedWork;
      if (hooks?.registerActivity) {
        this.managedActivityLease ??= this.openManagedActivityLease(hooks);
        this.managedActivityLease?.report(activeOperations);
      } else {
        hooks?.onActivityChange?.(activeOperations);
      }
    } catch {
      // Runtime observation cannot alter store operation semantics.
    }
  }

  private openManagedActivityLease(
    hooks: Readonly<ManagedOxigraphRuntimeHooksV1> | undefined,
  ): ManagedOxigraphRuntimeActivityLeaseV1 | null {
    if (!hooks?.registerActivity) return null;
    try {
      return hooks.registerActivity();
    } catch {
      return null;
    }
  }

  private runStreamingConstruct<T>(
    request: Rfc64HttpProjectionRequestV1,
    consume: (
      response: Response,
      lifecycleSignal: AbortSignal | undefined,
    ) => Promise<T>,
  ): Promise<T> {
    return this.runStoreWork(
      'construct',
      {
        priority: request.priority,
        signal: request.signal,
        source: request.source,
      },
      async (lifecycleSignal) => {
        const effectiveOptions: SparqlHttpQueryOptions = {
          priority: request.priority,
          signal: lifecycleSignal,
          source: request.source,
        };
        return this.postQuery(
          request.sparql,
          request.accept,
          'construct',
          'construct',
          effectiveOptions,
          (response) => consume(response, lifecycleSignal),
          // Deliberately not detached, unlike an ordinary read: `consume` owns
          // the live body (it spools it under `lifecycleSignal`) and stops
          // reading when the caller leaves, so the request cannot be left
          // running to be drained and discarded. An abort cancels the request
          // and its recovery stays retained until the client deadline.
          CANCEL_ON_ABORT,
        );
      },
    );
  }

  rfc64ExactBindingsReadV1(
    operation: Rfc64ExactBindingsReadOperationV1,
    options?: Pick<QueryOptions, 'signal'>,
  ) {
    if (!this.rfc64ExactBindingsReadCertifiedV1) {
      throw new Error('RFC-64 exact reads require a DKG-managed Oxigraph endpoint');
    }
    return executeRfc64ExactBindingsReadCapabilityV1(this, operation, options);
  }

  rfc64SemanticReadV1(
    operation: Rfc64SemanticReadOperationV1,
    options?: Pick<QueryOptions, 'signal'>,
  ) {
    if (!this.rfc64SemanticReadCertifiedV1) {
      throw new Error('RFC-64 semantic reads require a DKG-managed Oxigraph endpoint');
    }
    return executeRfc64SemanticReadCapabilityV1(this, operation, options);
  }

  private runStoreWork<T>(
    operation: StoreOperation,
    options: QueryOptions | undefined,
    work: (signal: AbortSignal | undefined, context: StoreWorkContext) => Promise<T>,
    admission?: SparqlHttpOperationAdmissionV1,
  ): Promise<T> {
    const recovery = this.readRecoveryState();
    if (refusesSparqlHttpAdmissionV1(recovery, admission)) {
      return Promise.reject(this.recoveryError(operation, 'not_started'));
    }
    return this.workLifecycle.run(
      options?.signal,
      (signal, context) => {
        return this.scheduler.run(
          options?.priority,
          options?.source ?? `sparql-http.${operation}`,
          () => work(signal, context),
          signal,
          { storeOperation: operation },
        );
      },
    );
  }

  private readRecoveryState(): ManagedOxigraphRuntimeStateV1 | null {
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
    started: ManagedOxigraphRuntimeStateV1 | null,
  ): boolean {
    const current = this.readRecoveryState();
    return current !== null && (
      current.recovering
      || (started !== null && current.generation !== started.generation)
    );
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
    policy: SparqlHttpReadPolicy,
    admission?: SparqlHttpOperationAdmissionV1,
  ): Promise<T> {
    const recoveryAtStart = this.readRecoveryState();
    if (refusesSparqlHttpAdmissionV1(recoveryAtStart, admission)) {
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
    const deadline = this.now() + this.timeout;
    const recoveryToken = this.managedAbandonedWorkRecovery.begin(recoveryAtStart);
    // What a managed Oxigraph does after its client has gone depends on the
    // answer: a streamed SELECT/CONSTRUCT stops when it next writes to the
    // closed socket, but a blocking evaluation (an aggregate, an ORDER BY)
    // sends nothing until it is done and keeps evaluating, and once the fetch is
    // aborted the client can no longer see that finish. So a caller that merely
    // stops waiting (its own budget, not a slow store) does not cancel the
    // request: it runs detached, on the store-close and client-deadline signals
    // alone, and only a request that outlives that deadline is reclaimed by a
    // supervised restart. From the first byte of the answer on, though, a caller
    // that has left gets nothing buffered for it: what remains of the answer is
    // read and thrown away up to a small budget (a short answer shows the server
    // finished; a long one is streaming, so it is cancelled and its recovery
    // stays retained), see `relayAnswer`.
    const detach = policy.kind === 'detach-on-caller-abort'
      && recoveryToken !== null
      && policy.work.callerSignal !== undefined
      ? { work: policy.work, callerSignal: policy.work.callerSignal }
      : undefined;
    let requestSignal: AbortSignal = timeoutSignal;
    let dispatched = false;
    let abandoned = false;
    // Set only by having seen the server finish (an answer read to its clean
    // end, by `consume` or, for a caller that left, by the relay). Never
    // inferred from an error: a failed body, or an error status whose
    // diagnostic body could not be read, shows nothing about the server.
    let serverFinished = false;
    let detachedRequest: Promise<T> | undefined;

    /** One HTTP request, cancelled by `cancelSignal` and the client deadline. */
    const request = async (cancelSignal: AbortSignal | undefined): Promise<T> => {
      const scope = composeAbortSignals(cancelSignal, timeoutSignal);
      const signal = requestSignal = scope.signal ?? timeoutSignal;
      try {
        throwIfAborted(signal);
        dispatched = true;
        const response = await fetch(this.queryEndpoint, {
          method: 'POST',
          headers: { ...this.headers, 'Content-Type': SPARQL_QUERY_CONTENT_TYPE, Accept: accept },
          body: sparql,
          signal,
        });
        let relay: RelayedAnswer | undefined;
        if (detach !== undefined) {
          relay = relayAnswer(response, detach.callerSignal, ABANDONED_READ_DRAIN_BUDGET_BYTES);
          if (detach.callerSignal.aborted) {
            // The caller left before the answer began: the relay discards it.
            serverFinished = await relay.finish();
            return undefined as T;
          }
        }
        try {
          // Keep the composed signal linked until the response body has
          // settled. A fetch promise may resolve as soon as headers arrive,
          // while JSON/N-Quads parsing is still holding the scheduler admission.
          const result = await consume(relay?.response ?? response);
          serverFinished = true;
          return result;
        } catch (error) {
          // `consume` failed. If the caller left mid-body it was failed on
          // purpose and the relay is discarding the rest in its place: wait for
          // that (this request is the lifecycle's unit of work), and learn
          // whether the server was seen to finish.
          if (relay !== undefined && await relay.finish()) serverFinished = true;
          throw error;
        }
      } finally {
        scope.dispose();
      }
    };

    try {
      if (detach === undefined) return await request(options?.signal);
      throwIfAborted(detach.callerSignal);
      // The request is handed to the lifecycle, which keeps it in its drain
      // set until it has settled; `close()` aborts and waits for it.
      // SCHEDULER SLOT: the race below settles this call, and so the scheduler
      // operation awaiting it, the moment the caller aborts. The slot is
      // therefore freed then, not when the detached request finishes. That is
      // unchanged from before detaching: aborting the fetch settled the
      // operation just as early. What differs with the answer is only what the
      // server does meanwhile: a streamed evaluation stops when it next writes
      // to the closed socket (so the slot is freed for work that is really
      // over), a blocking one keeps evaluating either way. Holding the slot
      // until the server finishes would be a different admission policy (a
      // runaway read would occupy a slot for up to the client deadline), so it
      // is left to the maintainers rather than changed here.
      detachedRequest = detach.work.runDetached(request);
      return await raceCallerAbandon(
        detachedRequest,
        detach.callerSignal,
        () => { abandoned = true; },
      );
    } catch (error) {
      if (requestSignal.aborted || detach?.callerSignal.aborted) {
        getMetrics().storeCancellationCompletedTotal.add(1, {
          operation,
          source: options?.source ?? `sparql-http.${operation}`,
        });
      }
      if (abandoned && detachedRequest !== undefined) {
        // The caller is gone but the request is still running. Hand it to the
        // lifecycle-owned retained-deadline coordinator: it is reclaimed by a
        // supervised restart only if it outlives the client deadline, and is
        // withdrawn as soon as the server has visibly finished. A request whose
        // answer was cancelled (longer than the drain budget) or failed never
        // shows that, so its retention stays.
        const retention = timeoutSignal.aborted
          ? null
          : this.managedAbandonedWorkRecovery.retain(operation, deadline, recoveryToken, detachedRequest);
        const settled = () => {
          if (serverFinished) retention?.release();
        };
        void detachedRequest.then(settled, settled);
      }
      if (timeoutSignal.aborted) {
        this.managedAbandonedWorkRecovery.clientTimedOut(
          operation, deadline, dispatched && !serverFinished ? recoveryToken : null, detachedRequest,
        );
        throw new StoreOperationTimeoutError({
          backend: this.managedOxigraph ? 'oxigraph-server' : 'sparql-http',
          operation,
          storeOperation,
          timeoutMs: this.timeout,
          cause: error,
        });
      }
      if (!abandoned && dispatched && requestSignal.aborted) {
        // A cancelled request does not show the server stopped: a streamed
        // evaluation ends when it next writes to the closed socket, but a
        // blocking one (an aggregate) keeps evaluating, and the client cannot
        // tell which. Hand the dispatched read to the lifecycle-owned
        // retained-deadline coordinator instead of extending the caller wait.
        this.managedAbandonedWorkRecovery.retain(operation, deadline, recoveryToken);
      }
      if (this.recoveryInterrupted(recoveryAtStart)) {
        throw this.recoveryError(storeOperation, 'indeterminate', error);
      }
      throw error;
    }
  }

  /** Best-effort cleanup transport for an already tracked atomic mutation. */
  private async postCleanupUpdate(
    update: string,
    options?: QueryOptions,
    operation: StoreOperation = 'update',
    admission?: SparqlHttpOperationAdmissionV1,
  ): Promise<void> {
    return this.postUpdate(update, options, operation, () => undefined, admission);
  }

  /** One owner for mutation/cleanup admission, dispatch and recovery retention. */
  private async postUpdate(
    update: string,
    options: QueryOptions | undefined,
    operation: StoreOperation,
    beforeDispatch: () => void,
    admission?: SparqlHttpOperationAdmissionV1,
  ): Promise<void> {
    // Direct POST (W3C SPARQL 1.1 Protocol §2.2.2): the update is the raw
    // request body with `application/sparql-update`, not URL-encoded form
    // data. See postQuery for why form encoding breaks large payloads.
    return this.runStoreWork(operation, options, async (lifecycleSignal) => {
      const recoveryAtStart = this.readRecoveryState();
      if (refusesSparqlHttpAdmissionV1(recoveryAtStart, admission)) {
        throw this.recoveryError(operation, 'not_started');
      }
      const timeoutSignal = AbortSignal.timeout(this.timeout);
      const deadline = this.now() + this.timeout;
      const recoveryToken = this.managedAbandonedWorkRecovery.begin(recoveryAtStart);
      const signalScope = composeAbortSignals(lifecycleSignal, timeoutSignal);
      const signal = signalScope.signal ?? timeoutSignal;
      let dispatched = false;
      // charset=utf-8: same ISO-8859-1 default-decode hazard as postQuery —
      // without it a Jetty-backed store corrupts non-ASCII INSERT DATA
      // literals and DELETE DATA patterns silently stop matching.
      try {
        throwIfAborted(signal);
        beforeDispatch();
        dispatched = true;
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
          this.managedAbandonedWorkRecovery.clientTimedOut(operation, deadline, dispatched ? recoveryToken : null);
          throw new StoreOperationTimeoutError({
            backend: this.managedOxigraph ? 'oxigraph-server' : 'sparql-http',
            operation,
            timeoutMs: this.timeout,
            cause: error,
          });
        }
        if (dispatched && signal.aborted) {
          this.managedAbandonedWorkRecovery.retain(operation, deadline, recoveryToken);
        }
        if (this.recoveryInterrupted(recoveryAtStart)) {
          throw this.recoveryError(operation, 'indeterminate', error);
        }
        throw error;
      } finally {
        signalScope.dispose();
      }
    }, admission);
  }

  async insert(quads: DKGQuad[], options?: QueryOptions): Promise<void> {
    if (quads.length === 0) return;
    assertQuadLiteralsMutf8Safe(quads, {
      maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
      label: 'SparqlHttpStore.insert',
    });
    await this.runUpdatePlan(statements.insertData(quads), options);
  }

  async delete(quads: DKGQuad[], options?: QueryOptions): Promise<void> {
    if (quads.length === 0) return;
    // SPARQL forbids blank nodes in `DELETE DATA` — a spec-compliant endpoint
    // (Oxigraph, Fuseki, …) rejects the whole statement with HTTP 400 if any
    // quad's subject or object is a blank node. The blank-node-safe builder
    // behind `deleteData` keeps ground quads on the fast `DELETE DATA` path and removes
    // blank-node quads with `DELETE { … } WHERE { … }` (blank nodes rewritten
    // to variables) — the only spec-legal way to target existing blank-node
    // structure over the SPARQL protocol. See the helper for details.
    await this.runUpdatePlan(statements.deleteData(quads), options);
  }

  async deleteByPattern(pattern: Partial<DKGQuad>, options?: QueryOptions): Promise<number> {
    const graphUri = pattern.graph;
    const before = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteByPattern.countBefore',
    });
    await this.applyDeleteByPattern(pattern, options);
    const after = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteByPattern.countAfter',
    });
    return Math.max(0, before - after);
  }

  async deleteByPatternWithoutCount(
    pattern: Partial<DKGQuad>,
    options?: QueryOptions,
  ): Promise<void> {
    await this.applyDeleteByPattern(pattern, options);
  }

  private async applyDeleteByPattern(
    pattern: Partial<DKGQuad>,
    options?: QueryOptions,
  ): Promise<void> {
    await this.runUpdatePlan(statements.deleteByPattern(pattern), options);
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    const before = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteBySubjectPrefix.countBefore',
    });
    await this.runUpdatePlan(statements.deleteBySubjectPrefix(graphUri, prefix), options);
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
    statements.checkIris.replaceGraph(graphUri, quads);
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
    statements.checkIris.replaceGraphAndSubject(
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
    statements.checkIris.replaceSubject(graphUri, subject, quads);
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
    statements.checkIris.rfc64AuthorCommitCasV1(plan);
    const state = this.readRecoveryState();
    if (refusesSparqlHttpAdmissionV1(state)) throw this.recoveryError('rfc64AuthorCommitCasV1', 'not_started');
    return runSparqlHttpAuthorCommitV1({
      lifecycle: this.workLifecycle,
      signal: options?.signal,
      storeGeneration: state?.generation ?? null,
      touchedGraphs: [...plan.touchedGraphs],
      writeGen: this.writeGen,
      indeterminateError: (cause) => new StoreOperationTimeoutError({
        backend: this.managedOxigraph ? 'oxigraph-server' : 'sparql-http',
        operation: 'rfc64AuthorCommitCasV1',
        outcome: 'indeterminate',
        message: `RFC-64 CAS outcome is indeterminate: ${cause instanceof Error ? cause.message : 'receipt unavailable'}`,
        cause,
      }),
      executeUpdate: (admission, signal) => this.runRemoteGraphMutation({
        // The transactional request always mutates private receipt/staging
        // graphs, while semantic graphs change only when the receipt is true.
        scope: { kind: 'graphs', graphs: [plan.receiptGraph] },
        update: plan.update,
        options: { ...options, signal, source: options?.source ?? 'sparql-http.rfc64AuthorCommitCasV1' },
        operation: 'rfc64AuthorCommitCasV1',
        admission,
      }),
      readReceipt: (admission, signal) => this.queryWithOperation(plan.receiptAsk, {
        ...options,
        signal,
        source: 'sparql-http.rfc64AuthorCommitCasV1.receipt',
      }, 'rfc64AuthorCommitCasV1', admission),
      cleanup: (admission) => this.postCleanupUpdate(
        plan.cleanup,
        { ...cleanupOptions, source: 'sparql-http.rfc64AuthorCommitCasV1.cleanup' },
        'rfc64AuthorCommitCasV1',
        admission,
      ),
    });
  }

  private supportsConsistency(
    required: Exclude<SparqlHttpConsistencyProfile, 'best-effort'>,
  ): boolean {
    return this.consistencyProfile === 'atomic-readback'
      || this.consistencyProfile === required;
  }

  /** Send a statement plan under its own operation and write scope; nothing for a null plan. */
  private async runUpdatePlan(plan: SparqlUpdatePlan | null, options?: QueryOptions): Promise<void> {
    if (plan === null) return;
    await this.runRemoteGraphMutation({
      scope: plan.scope,
      update: plan.update,
      options: { ...options, source: options?.source ?? `sparql-http.${plan.operation}` },
      operation: plan.operation,
    });
  }

  /** Run a statement plan's query under its own operation. */
  private runQueryPlan(plan: SparqlQueryPlan, options?: QueryOptions): Promise<QueryResult> {
    return this.queryWithOperation(
      plan.sparql,
      { ...options, source: options?.source ?? `sparql-http.${plan.operation}` },
      plan.operation,
    );
  }

  /**
   * The only dispatch path for public remote mutations. The request owns its
   * write scope, HTTP dispatch, lifecycle transitions, graph-list invalidation,
   * timeout classification, and optional staging cleanup as one operation.
   * There is no callback a caller can omit while still sending an update.
   */
  private async runRemoteGraphMutation(opts: {
    scope: GraphWriteScope;
    update: string;
    options?: QueryOptions;
    operation: StoreOperation;
    admission?: SparqlHttpOperationAdmissionV1;
    cleanup?: {
      update: string;
      options?: QueryOptions;
      operation: StoreOperation;
    };
  }): Promise<void> {
    let lifecycle: GraphWriteLifecycle | undefined;
    try {
      await this.postUpdate(opts.update, opts.options, opts.operation, () => {
        // Begin the semantic write only after all pre-dispatch refusals.
        lifecycle = this.writeGen.beginWrite(opts.scope);
        this.invalidateListGraphsCache();
        if (opts.admission) opts.admission.dispatched = true;
      }, opts.admission);
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
    admission?: SparqlHttpOperationAdmissionV1,
  ): Promise<QueryResult> {
    const trimmed = sparql.trim();
    // PREFIX / BASE prologues precede the query form. Use the shared scanner
    // so graph-producing queries negotiate N-Quads instead of SPARQL JSON.
    const operation = classifySparqlOperation(trimmed);
    const isAsk = operation.kind === 'read' && operation.form === 'ASK';
    const isConstruct = operation.kind === 'read'
      && (operation.form === 'CONSTRUCT' || operation.form === 'DESCRIBE');
    const canonicalOperation = storeOperation ?? (isConstruct ? 'construct' : 'query');
    return this.runStoreWork(canonicalOperation, options, async (lifecycleSignal, work) => {
      const effectiveOptions: SparqlHttpQueryOptions = {
        ...options,
        signal: lifecycleSignal,
      };
      // An ordinary read whose caller stops waiting leaves its dispatched
      // request running until the server's answer starts (see
      // SparqlHttpReadPolicy); the streaming projection reader is the one read
      // that cancels at once.
      const readPolicy: SparqlHttpReadPolicy = { kind: 'detach-on-caller-abort', work };
      const startedAt = this.now();
      throwIfAborted(lifecycleSignal);

      try {
        if (isConstruct) {
          return await this.queryConstruct(
            trimmed,
            effectiveOptions,
            canonicalOperation,
            readPolicy,
            admission,
          );
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
            return decodeSparqlJsonQueryResult(text, isAsk ? 'ask' : 'select');
          },
          readPolicy,
          admission,
        );
      } finally {
        this.maybeEmitSlowQuery({
          sparql: trimmed,
          source: options?.source,
          startedAt,
        });
      }
    }, admission);
  }

  private async queryConstruct(
    sparql: string,
    options: SparqlHttpQueryOptions | undefined,
    storeOperation: StoreOperation,
    readPolicy: SparqlHttpReadPolicy,
    admission?: SparqlHttpOperationAdmissionV1,
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
      readPolicy,
      admission,
    );
  }

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    const r = await this.runQueryPlan(statements.hasGraph(graphUri), options);
    return r.type === 'boolean' && r.value;
  }

  async createGraph(_graphUri: string): Promise<void> {
    // Graphs are created implicitly on first insert in SPARQL 1.1.
  }

  async dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    await this.runUpdatePlan(statements.dropGraph(graphUri), options);
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
    const graphs = await raceStoreWorkAgainstAbort(inFlight, options?.signal);
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
    const r = await this.runQueryPlan(statements.countQuads(graphUri), options);
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
    this.managedAbandonedWorkRecovery.close();
    // A managed endpoint is stopped immediately after store.close(). The
    // lifecycle owns one complete generation, aborting and draining every
    // operation admitted before close, including a dispatched read whose caller
    // already left (`runDetached`), while rejecting work attempted during
    // close. A fresh generation is installed only after the drain completes.
    await this.workLifecycle.close(new Error('SparqlHttpStore closed'));
    try {
      this.managedActivityLease?.dispose();
    } catch {
      // Runtime observation cannot alter store close semantics.
    }
    this.managedActivityLease = null;
  }
}

/**
 * Construct a SPARQL adapter for a DKG-supervised local Oxigraph process.
 * Generic constructor options cannot grant managed-server capabilities.
 */
export function createManagedOxigraphSparqlStoreV1(
  options: SparqlHttpStoreOptions,
  hooks: ManagedOxigraphRuntimeHooksV1 = {},
): SparqlHttpStore {
  const config = createManagedOxigraphRuntimeStoreConfigV1({
    backend: 'sparql-http',
    options: snapshotManagedOxigraphRuntimeOptionsV1(
      options,
      true,
    ),
  }, hooks);
  return new SparqlHttpStore(
    config.options as unknown as SparqlHttpStoreOptions,
    getManagedOxigraphRuntimeConstructionAuthorityV1(config),
  );
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

function resolveConsistencyProfile(
  options: Pick<SparqlHttpStoreOptions, 'consistencyProfile' | 'atomicUpdates'>,
): SparqlHttpConsistencyProfile {
  const profile = normalizeConsistencyProfile(options.consistencyProfile);
  if (options.atomicUpdates === undefined) return profile;

  const legacyProfile: SparqlHttpConsistencyProfile = options.atomicUpdates
    ? 'atomic-update'
    : 'best-effort';
  if (options.consistencyProfile === undefined) return legacyProfile;

  const compatible = options.atomicUpdates
    ? profile === 'atomic-update' || profile === 'atomic-readback'
    : profile === 'best-effort';
  if (!compatible) {
    throw new Error(
      'sparql-http atomicUpdates conflicts with consistencyProfile; remove the deprecated alias',
    );
  }
  return profile;
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
// Adapter registration
// ---------------------------------------------------------------------------

registerTripleStoreAdapter('sparql-http', async (opts, constructionAuthority) => {
  const options = opts as SparqlHttpStoreOptions | undefined;
  if (!options?.queryEndpoint) {
    throw new Error('sparql-http adapter requires options.queryEndpoint (and optionally options.updateEndpoint)');
  }
  return new SparqlHttpStore(options, constructionAuthority);
});

// Compatibility exports: `dist/adapters/sparql-http.js` is a public package
// path, and these helpers used to live here.

/** @deprecated Moved to `./blank-node-safe-delete.js`. */
export { isBlankNodeTerm } from './blank-node-safe-delete.js';

/**
 * @deprecated The blank-node-safe delete is now `deleteData` in
 * `./sparql-statements.js`. This keeps the former one-argument signature and
 * returns the same update. It reports nothing, as the function it replaces
 * never counted invalid terms.
 */
export function buildBlankNodeSafeDelete(quads: DKGQuad[]): string | null {
  const ignoreInvalidTerms = (): void => {};
  return renderBlankNodeSafeDelete(
    quads,
    ADAPTER_SPARQL_TERM_POLICY.renderer({ adapter: 'sparql-http', operation: 'delete' }, ignoreInvalidTerms),
  );
}
