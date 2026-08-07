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
import { externalStorePriorityScheduler } from '../store-priority-scheduler.js';
import { GraphWriteGenTracker } from '../graph-write-gen.js';
import { NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY } from './graph-enumeration-query.js';
import {
  ATOMIC_GRAPH_REPLACE_STAGING_PREFIX,
  buildAtomicGraphAndSubjectReplaceUpdate,
  buildAtomicGraphReplaceUpdate,
  buildAtomicSubjectReplaceUpdate,
  isAtomicGraphReplaceStagingGraph,
} from '../atomic-graph-replace.js';
import { assertNotReservedInternalGraphV1 } from '../internal-graph-policy.js';
import {
  ManagedOxigraphBackendUnownedError,
  extractManagedOxigraphHandoffV1,
  extractManagedOxigraphLeaseV1,
  isManagedOxigraphOwnershipLiveV1,
  isManagedOxigraphOwnershipTerminalV1,
  readManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphOwnershipLeaseV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '../managed-oxigraph-ownership-v1-internal.js';
import {
  SystemRecordControllerRegistrationError,
  createSystemRecordLaneControllerV1,
  releaseSystemRecordLaneControllerV1,
  type SystemRecordApplyOutcomeV1,
  type SystemRecordChildHandoffV1,
  type SystemRecordLaneControllerV1,
} from '../system-record-materializer-v1.js';
import { OwnedManagedHttpClient } from './managed-http-client.js';
import { UnsupportedTripleStoreCapabilityError } from '../unsupported-capability-error.js';
import { readResponseTextBounded } from '../http-response-limit.js';
import {
  assertQuadLiteralsMutf8Safe,
  classifySparqlOperation,
  getMetrics,
  JAVA_WRITE_UTF_MAX_BYTES,
} from '@origintrail-official/dkg-core';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  AbortableStoreWorkLifecycle,
  composeAbortSignals,
} from '../abortable-store-work-lifecycle.js';

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
  /**
   * Declare that the endpoint executes a whole multi-operation SPARQL Update
   * request as one transaction (SPARQL 1.1 only RECOMMENDS this). Required for
   * `replaceGraph`: without it the staged DROP/INSERT/MOVE could be applied
   * partially, violating the old-graph-or-new-graph contract, so the
   * capability fails closed. Daemon-owned endpoints (`managedByDkg`) are
   * oxigraph-server, which is known transactional, and imply this flag.
   */
  atomicUpdates?: boolean;
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
  private readonly atomicUpdates: boolean;

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
  // reconcile negative memo via `asGraphWriteGenSource` / `getWriteGen`.
  private readonly writeGen = new GraphWriteGenTracker();

  /**
   * Supervisor-issued ownership lease (#2052 B2), or null on every store that
   * is not a daemon-managed Oxigraph child. Recovered by object identity from a
   * symbol-keyed option, so no persisted configuration can supply one.
   */
  private readonly ownershipLease: ManagedOxigraphOwnershipLeaseV1 | null;
  /** Supervisor half of the handoff. Absent ⇒ the lane is never advertised. */
  private readonly supervisorHandoff: ManagedOxigraphSupervisorHandoffV1 | null;
  /** Lazily built so a store that is never asked for the lane allocates nothing. */
  private systemRecordLane: SystemRecordLaneControllerV1 | null | undefined;
  /** The owned pool for the CURRENT child generation. */
  private managedClient: OwnedManagedHttpClient | null = null;
  /** A pool retired by `destroyClient`, still awaiting drain by `awaitRetiredWork`. */
  private retiredClient: OwnedManagedHttpClient | null = null;

  constructor(options: SparqlHttpStoreOptions) {
    if (!options.queryEndpoint?.trim()) {
      throw new Error('sparql-http adapter requires options.queryEndpoint');
    }
    this.queryEndpoint = options.queryEndpoint.replace(/\/$/, '');
    this.updateEndpoint = (options.updateEndpoint ?? options.queryEndpoint).replace(/\/$/, '');
    this.timeout = options.timeout ?? 30_000;
    this.managedByDkg = options.managedByDkg === true;
    this.atomicUpdates = options.atomicUpdates === true || this.managedByDkg;
    // Namespace ownership is INDEPENDENT of both booleans above. `managedByDkg`
    // is rewritten to false by the storage factory on this very path, and
    // `atomicUpdates` is synthesized as true by that same function, so neither
    // can gate a capability. Only an identity-checked live lease can.
    this.ownershipLease = extractManagedOxigraphLeaseV1(options);
    this.supervisorHandoff = extractManagedOxigraphHandoffV1(options);
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
    work: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    return this.workLifecycle.run(
      options?.signal,
      (signal) => externalStorePriorityScheduler.run(
        options?.priority,
        options?.source ?? `sparql-http.${operation}`,
        () => work(signal),
        signal,
      ),
    );
  }

  getPressureSnapshot(): StorePressureSnapshot {
    return externalStorePriorityScheduler.snapshot;
  }

  /** {@link GraphWriteGenSource} capability (#1609) — see graph-write-gen.ts. */
  getWriteGen(graphPrefix: string): number {
    return this.writeGen.getWriteGen(graphPrefix);
  }

  private async postQuery<T>(
    sparql: string,
    accept: string,
    options: SparqlHttpQueryOptions | undefined,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
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
    //
    // Reads refuse ONLY on terminal ownership — see
    // `assertManagedBackendReadable`. `postQuery` is one of exactly two `fetch`
    // sites in this adapter, and every read form funnels through it
    // (`query`/`queryConstruct`/`hasGraph`/`countQuads`/`listGraphsDirect`), so
    // this one site is the whole endpoint-read surface.
    this.assertManagedBackendReadable(options?.source ?? 'query');
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
          operation: 'query',
          source: options?.source ?? 'sparql-http.query',
        });
      }
      throw error;
    } finally {
      signalScope.dispose();
    }
  }

  private async postUpdate(
    update: string,
    options?: QueryOptions,
    operation = 'update',
  ): Promise<void> {
    // Direct POST (W3C SPARQL 1.1 Protocol §2.2.2): the update is the raw
    // request body with `application/sparql-update`, not URL-encoded form
    // data. See postQuery for why form encoding breaks large payloads.
    return this.runStoreWork(operation, options, async (lifecycleSignal) => {
      // AT DISPATCH, and the placement is the entire guarantee.
      //
      // The scheduler holds ordinary work while a control barrier is pending and
      // releases it when the barrier settles — identically whether the barrier
      // RESOLVED or REJECTED. So a mutation queued before a generation handoff
      // resumes after that handoff failed, and until now nothing on this path
      // consulted ownership: reproduced, an `INSERT DATA` went on the wire while
      // the store's own lease already read
      // `terminal: true, port-release-unproven`. Every fact needed to refuse was
      // available at the dispatch instant and simply never read.
      //
      // Checking in `insert()`/`update()` instead would be checking at CALL
      // time, which is before the queue — precisely the calls the review names
      // as "queued before activation/failure" would pass it and dispatch anyway.
      this.assertManagedBackendOwned(operation);
      const timeoutSignal = AbortSignal.timeout(this.timeout);
      const signalScope = composeAbortSignals(lifecycleSignal, timeoutSignal);
      const signal = signalScope.signal ?? timeoutSignal;
      // charset=utf-8: same ISO-8859-1 default-decode hazard as postQuery —
      // without it a Jetty-backed store corrupts non-ASCII INSERT DATA
      // literals and DELETE DATA patterns silently stop matching.
      try {
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
          throw new Error(`SPARQL HTTP ${operation} failed (${res.status}): ${text.slice(0, 300)}`);
        }
      } catch (error) {
        if (signal.aborted) {
          getMetrics().storeCancellationCompletedTotal.add(1, {
            operation,
            source: options?.source ?? `sparql-http.${operation}`,
          });
        }
        throw error;
      } finally {
        signalScope.dispose();
      }
    });
  }

  /**
   * Refuse a managed-store mutation whose backend we cannot prove we own.
   *
   * Scoped to MUTATIONS on stores that actually hold an ownership lease:
   *
   * - An operator-configured store has no lease, returns on the first line, and
   *   pays one already-loaded field read. Nothing about the default path moves.
   * - Reads are deliberately NOT refused. A lane failure must not take the
   *   daemon's whole triple store down — the same reasoning that made a failed
   *   shutdown leave the child alive rather than kill it. A read against a dead
   *   port fails at the transport anyway, and refusing reads would turn every
   *   child respawn into a total store outage.
   *
   * It is a live READ of the lease, not a latch armed by the lane, and that is a
   * deliberate departure from the fix the review proposed. Three measured
   * reasons:
   *
   * 1. An armed latch's safety margin is ZERO microtasks. The scheduler rejects
   *    the barrier one reaction before it releases queued work, so a latch
   *    written synchronously in the lane's `catch` wins by exactly one tick —
   *    and one added `await` anywhere between them silently disarms it with
   *    every test still green. A dispatch-time read has no ordering requirement
   *    to get wrong.
   * 2. An armed latch is blanket. Of the five handoff steps, two
   *    (`destroyClient`, `rotateMaterializationEpoch`) leave the child proven
   *    and healthy; latching on "the barrier threw" refuses every managed write
   *    for the process lifetime on a node where nothing was wrong.
   * 3. A lane-armed latch fixes the RAREST instance of this class. The same
   *    exposure exists with no lane involved: on an ordinary child exit the
   *    supervisor invalidates ownership and revives, and for the whole backoff
   *    the adapter keeps POSTing to a port it does not own. That path ships
   *    today; the lane path has no production caller at all.
   *
   * Self-clearing follows from being a read: when the supervisor binds a proven
   * replacement generation the lease reads live again and writes resume, with no
   * clear path to forget and no sticky field to leave set. A latch would have
   * needed one, and the version this was modelled on does not have it — which
   * would have converted a self-healing respawn into a mandatory node restart.
   */
  /**
   * Refuse a managed-store READ whose backend may not be ours.
   *
   * Narrower than the mutation guard, deliberately. Writes refuse whenever
   * ownership is not provable; reads refuse only when it is **terminal**:
   *
   * - A child being replaced is not-ready but not terminal. A read there fails
   *   at the transport anyway and the supervisor is about to revive, so
   *   refusing would convert every respawn into a store outage.
   * - Terminal means the supervisor could not prove our child released the bind
   *   and will never bind another. Whatever answers may not be ours — and a
   *   foreign answer does not stay local: `finalized-assertion-author` reads the
   *   store to build the assertion whose merkle root goes ON-CHAIN, and the sync
   *   responder serves store reads TO PEERS. A wrong read is laundered into
   *   irreversible artifacts and into other nodes.
   *
   * KNOWN LIMIT, and it must be closed before the lane is activated: today the
   * supervisor cannot distinguish "a foreign process took the bind" from "our
   * own child is still shutting down". Under `memoryLimits` the tracked child is
   * `systemd-run`, not oxigraph, so the real listener is a grandchild and
   * `resolveListenOwner` fails closed on an exited child — reporting our own
   * process as unattributable. This guard is correct-and-inert today because
   * `port-release-unproven` has no production trigger (the lane has no
   * production caller, and the only other path is daemon shutdown, where the
   * port is dead anyway). It becomes load-bearing — and its false-positive cost
   * becomes real — when a later stack activates the lane. See the activation
   * gates in the PR description.
   */
  /**
   * Production disposal for the memoized lane controller.
   *
   * Cannot throw, so a caller's `close().catch(...)` can never skip it, and is
   * idempotent because `close()` may be called twice. The identity scoping that
   * makes this safe — releasing the global ONLY if this controller still holds
   * it — lives in `releaseSystemRecordLaneControllerV1`, where the registration
   * does.
   */
  private releaseSystemRecordLane(): void {
    const controller = this.systemRecordLane;
    this.systemRecordLane = null;
    if (controller) releaseSystemRecordLaneControllerV1(controller);
  }

  private assertManagedBackendReadable(operation: string): void {
    if (!this.ownershipLease) return;
    if (!isManagedOxigraphOwnershipTerminalV1(this.ownershipLease)) return;
    const snapshot = readManagedOxigraphOwnershipSnapshotV1(this.ownershipLease);
    throw new ManagedOxigraphBackendUnownedError(
      `sparql-http.${operation}`,
      true,
      snapshot?.lastInvalidation,
    );
  }

  private assertManagedBackendOwned(operation: string): void {
    if (!this.ownershipLease) return;
    if (isManagedOxigraphOwnershipLiveV1(this.ownershipLease)) return;
    // Cold path only: the snapshot allocates, so it is taken to build the error
    // and nowhere else.
    const snapshot = readManagedOxigraphOwnershipSnapshotV1(this.ownershipLease);
    throw new ManagedOxigraphBackendUnownedError(
      `sparql-http.${operation}`,
      snapshot?.terminal ?? false,
      snapshot?.lastInvalidation,
    );
  }

  /**
   * Refuse a caller-authored mutation aimed at persistent system-record V1
   * reserved state (#2052 B2).
   *
   * This lives on the ADAPTER rather than on a decorator on purpose. Every
   * decorator is optional — the changelog defaults off, and the graph-set index
   * and blob store are conditional — but all of them delegate downward, so the
   * adapter is the only always-on choke point for the managed endpoint that
   * actually holds reserved state.
   *
   * Reserved graphs are writable only through the materializer's structured,
   * generation-bound command path, which derives its own scope and never calls
   * these public methods. A hard throw is safe because reserved graphs never
   * enumerate: no legitimate iterate-and-drop loop can reach one, only a
   * hardcoded IRI can.
   *
   * `update()` is deliberately NOT guarded. Its argument is an opaque SPARQL
   * program, and scanning it for reserved IRIs would be exactly the evadable
   * best-effort string check that `ChangelogStore.assertNoReservedRef` already
   * documents as insufficient. Opaque updates instead rotate the
   * materialization epoch; Stack C audits and migrates the remaining raw
   * callers before any of this behaviour is enabled.
   */
  private assertGenericMutationScope(
    graphs: Iterable<string | undefined>,
    operation: string,
  ): void {
    for (const graph of graphs) {
      if (graph) assertNotReservedInternalGraphV1(graph, operation, 'SparqlHttpStore');
    }
  }

  /**
   * Allocation-free variant for the quad paths.
   *
   * This guard is the one thing in #2052 B2 that runs on EVERY write on EVERY
   * node today, so it must not allocate proportionally to the batch. The
   * previous `quads.map((q) => q.graph)` built a throwaway array the same
   * length as the payload: irrelevant for ordinary KA writes, but measured at
   * +14.3 ms and ~8 MB transient for a 1,000,000-quad bulk import. Iterating
   * the quads directly matches what `ChangelogStore.assertNoPersistentReservedQuads`
   * already does.
   */
  private assertGenericMutationQuadScope(quads: readonly DKGQuad[], operation: string): void {
    for (const quad of quads) {
      if (quad.graph) assertNotReservedInternalGraphV1(quad.graph, operation, 'SparqlHttpStore');
    }
  }

  /**
   * Expose the system-record V1 lane iff this store is a daemon-managed child
   * (#2052 B2).
   *
   * Advertising is gated on a LIVE lease, not merely on holding one: a store
   * whose child has exited still holds the lease object, but its snapshot is
   * not ready and the lane must not be advertised as usable. The controller
   * itself is built lazily and memoized, so a store nobody asks allocates
   * nothing and the default-off path stays free.
   */
  getSystemRecordLaneControllerV1(): SystemRecordLaneControllerV1 | undefined {
    // Fail-closed on all three preconditions. A store missing ANY of them is
    // not merely degraded, it is a store on which the lane's guarantees cannot
    // be stated, so it advertises nothing rather than something unusable.
    if (!this.ownershipLease || !this.supervisorHandoff) return undefined;
    const snapshot = readManagedOxigraphOwnershipSnapshotV1(this.ownershipLease);
    // `ready` is checked, not just `terminal`. A store whose child has exited
    // still holds the lease object; advertising then would hand out a lane over
    // a child that is not the proven listener. Absence here is transient by
    // design, which is why the decorators above re-probe rather than latch it.
    if (!snapshot || snapshot.terminal || !snapshot.ready) return undefined;

    // `=== undefined`, NOT `!this.systemRecordLane`, and it is the whole
    // never-advertise-after-close guarantee. One field, three meanings:
    //
    //   undefined  never built
    //   null       CLOSED; never build again
    //   controller live
    //
    // A managed store's lease still reads `ready` at `close()` — the supervisor
    // stops the child afterwards — so a truthiness check here would let a first
    // probe issued after close pass every precondition above, construct a
    // controller over a closed store, and take the process registration from
    // the replacement. A separate `systemRecordLaneClosed` boolean was written
    // for this and deleted: its solo mutant SURVIVED, because this comparison
    // already carries the property.
    if (this.systemRecordLane === undefined) {
      try {
        this.systemRecordLane = createSystemRecordLaneControllerV1({
          lease: this.ownershipLease,
          handoff: this.buildChildHandoff(this.supervisorHandoff),
          executor: {
            applyVerified: (proof, childGeneration) =>
              this.executeSystemRecordApply(proof, childGeneration),
          },
          // Every lifecycle transition runs under the scheduler's control
          // barrier, which is what actually makes "the child is stopped only
          // when nothing is talking to it" true. The barrier existed, was
          // exported and was tested from the first commit of this stack and had
          // ZERO production callers, so the lane stopped and replaced the owned
          // child while ordinary requests were still in flight and the seal it
          // implements never once ran in anger.
          //
          // `this` is the store identity: stable for the adapter's lifetime,
          // opaque to the scheduler, and distinct per store, so a second managed
          // store's transition cannot head-of-line block this one's work.
          //
          // The generation is read per transition rather than captured, because
          // the lane outlives any single child: sealing the generation observed
          // when the controller was BUILT would seal a generation that has since
          // been replaced.
          barrier: (purpose, transition) =>
            externalStorePriorityScheduler.runControlBarrier(
              this,
              purpose,
              transition,
              this.ownershipLease
                ? readManagedOxigraphOwnershipSnapshotV1(this.ownershipLease)?.childGeneration
                : undefined,
            ),
        });
      } catch (error) {
        // ONLY the registration refusal, and only because absence is the
        // CORRECT answer to it: another managed store in this process holds the
        // lane, so this store genuinely has none to offer. Every other
        // construction failure is a wiring bug, and the previous catch-all
        // converted such a bug into a capability that is silently and
        // permanently missing with nothing logged.
        //
        // Stated honestly: nothing inside the `try` can throw anything else
        // TODAY — `buildChildHandoff` returns closures, the executor is a
        // literal, and the barrier closure is not invoked at construction. So
        // this branch has no reachable trigger at present. Its value is not a
        // failure it catches now but a failure it stops MASKING later, which is
        // why the test for it injects the failure rather than pretending one
        // exists.
        if (!(error instanceof SystemRecordControllerRegistrationError)) throw error;
        // NOT memoized as `null`. A refusal is transient now that the holder
        // releases its registration on close, and latching it here would
        // contradict the decorators above, which re-probe absence for exactly
        // that reason.
        return undefined;
      }
    }
    return this.systemRecordLane ?? undefined;
  }

  /**
   * Compose the clean-generation handoff from its two owners.
   *
   * The adapter owns exactly the connection pool: it is the only component that
   * can destroy the retired generation's sockets and await the requests issued
   * over them. Process facts — the child exited, the port was released, a
   * replacement is the proven listener — belong to the supervisor, which holds
   * the `ChildProcess`. Splitting them here keeps the ORDER in one place while
   * letting each half assert only what it can actually observe.
   */
  private buildChildHandoff(
    supervisor: ManagedOxigraphSupervisorHandoffV1,
  ): SystemRecordChildHandoffV1 {
    return {
      // `destroyClient` moves the live client to `retiredClient` rather than
      // dropping it, so `awaitRetiredWork` still has something to drain. The
      // previous shape nulled the field and then re-read that same null, which
      // made step 3 of the sequence a structural no-op — harmless only because
      // step 1 happened to await settlement, and actively wrong in `disable`,
      // which calls `awaitRetiredWork` with no preceding `destroyClient` and so
      // would have destroyed the CURRENT client and left the field pointing at
      // a dead pool bound to the live generation.
      destroyClient: async () => {
        const retired = this.managedClient;
        this.managedClient = null;
        if (retired) {
          this.retiredClient = retired;
          await retired.destroyAndSettle();
        }
      },
      stopAndProveOwnedChildDead: () => supervisor.stopAndProveOwnedChildDead(),
      awaitRetiredWork: async () => {
        const retired = this.retiredClient;
        this.retiredClient = null;
        if (retired) await retired.destroyAndSettle();
      },
      startAndProveCleanGeneration: () => supervisor.startAndProveCleanGeneration(),
      rotateMaterializationEpoch: async () => {
        this.invalidateListGraphsCache();
        this.writeGen.recordUnscopedWrite();
      },
    };
  }

  /**
   * Dispatch one verified apply against an explicitly named child generation.
   *
   * The generation is rechecked immediately before any byte can leave, and the
   * request goes through a pool owned by exactly that generation, so a stale
   * facade cannot reach a replacement listener even if it somehow retained a
   * reference.
   */
  private async executeSystemRecordApply(
    _proof: unknown,
    childGeneration: string,
  ): Promise<SystemRecordApplyOutcomeV1> {
    if (!this.ownershipLease) return { outcome: 'capability-lost' };
    const snapshot = readManagedOxigraphOwnershipSnapshotV1(this.ownershipLease);
    if (!snapshot || snapshot.terminal) return { outcome: 'capability-lost' };
    if (!snapshot.ready || snapshot.childGeneration !== childGeneration) {
      return { outcome: 'deferred', reason: 'generation-changed' };
    }

    if (!this.managedClient || this.managedClient.childGeneration !== childGeneration) {
      // A pool is bound to one generation for its whole life; a mismatch means
      // the caller is holding a facade from a retired generation.
      if (this.managedClient) return { outcome: 'capability-lost' };
      this.managedClient = new OwnedManagedHttpClient(childGeneration);
    }

    // The verified-replacement command construction and the full-state CAS
    // transaction are the next increment of this stack; until they land the
    // lane refuses rather than dispatching an unproven write.
    return { outcome: 'deferred', reason: 'validation-mismatch' };
  }

  async insert(quads: DKGQuad[], options?: QueryOptions): Promise<void> {
    if (quads.length === 0) return;
    this.assertGenericMutationQuadScope(quads, 'insert');
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
    await this.postUpdate(update, {
      ...options,
      source: options?.source ?? 'sparql-http.insert',
    }, 'insert');
    this.invalidateListGraphsCache();
    this.writeGen.recordGraphWrites(byGraph.keys());
  }

  async delete(quads: DKGQuad[], options?: QueryOptions): Promise<void> {
    if (quads.length === 0) return;
    this.assertGenericMutationQuadScope(quads, 'delete');
    // SPARQL forbids blank nodes in `DELETE DATA` — a spec-compliant endpoint
    // (Oxigraph, Fuseki, …) rejects the whole statement with HTTP 400 if any
    // quad's subject or object is a blank node. `buildBlankNodeSafeDelete`
    // keeps ground quads on the fast `DELETE DATA` path and removes
    // blank-node quads with `DELETE { … } WHERE { … }` (blank nodes rewritten
    // to variables) — the only spec-legal way to target existing blank-node
    // structure over the SPARQL protocol. See the helper for details.
    const update = buildBlankNodeSafeDelete(quads);
    if (!update) return;
    await this.postUpdate(update, {
      ...options,
      source: options?.source ?? 'sparql-http.delete',
    }, 'delete');
    this.invalidateListGraphsCache();
    this.writeGen.recordGraphWrites(new Set(quads.map((q) => q.graph || '')));
  }

  async deleteByPattern(pattern: Partial<DKGQuad>, options?: QueryOptions): Promise<number> {
    const graphUri = pattern.graph;
    this.assertGenericMutationScope([graphUri], 'deleteByPattern');
    // BEFORE the count. This method and `deleteBySubjectPrefix` are the only
    // mutations that read first, and their `countBefore` reached the wire ahead
    // of `postUpdate`'s ownership guard — so the mutation was correctly refused
    // but a socket had already been opened and a foreign count consumed. That
    // made the "zero I/O" property claimed for the mutation guard false for
    // exactly these two methods.
    this.assertManagedBackendOwned('deleteByPattern');
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
      // An unscoped pattern binds `?g_ctx` across EVERY named graph, so it
      // reaches reserved system-record state while sailing past
      // `assertGenericMutationScope` — whose body is `if (graph)` and is
      // therefore a no-op when `pattern.graph` is undefined. Excluding the
      // operation-internal prefix in the WHERE is the narrow fix: no legitimate
      // caller targets those graphs (they are invisible to enumeration), so
      // this closes a bypass without changing any real caller's semantics.
      update =
        `DELETE { GRAPH ?g_ctx { ${triple} } } WHERE { GRAPH ?g_ctx { ${triple} } ` +
        `FILTER(!STRSTARTS(STR(?g_ctx), "${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}")) }`;
    }
    await this.postUpdate(update, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteByPattern',
    }, 'deleteByPattern');
    this.invalidateListGraphsCache();
    if (graphUri) this.writeGen.recordGraphWrites([graphUri]);
    else this.writeGen.recordUnscopedWrite();
    const after = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteByPattern.countAfter',
    });
    return Math.max(0, before - after);
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    this.assertGenericMutationScope([graphUri], 'deleteBySubjectPrefix');
    // See `deleteByPattern`: the `countBefore` below is a read that outran the
    // mutation guard.
    this.assertManagedBackendOwned('deleteBySubjectPrefix');
    const before = await this.countQuads(graphUri, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteBySubjectPrefix.countBefore',
    });
    const escapedPrefix = escapeString(prefix);
    const update = `DELETE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } } WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${escapedPrefix}")) } }`;
    await this.postUpdate(update, {
      ...options,
      source: options?.source ?? 'sparql-http.deleteBySubjectPrefix',
    }, 'deleteBySubjectPrefix');
    this.invalidateListGraphsCache();
    this.writeGen.recordGraphWrites([graphUri]);
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
    await this.postUpdate(sparql, {
      ...options,
      source: options?.source ?? 'sparql-http.update',
    }, 'update');
    this.invalidateListGraphsCache();
    // `touchedGraphs` hints only membership changes, not every graph whose
    // CONTENT a raw UPDATE mutates — an unscoped bump is the only sound scope.
    this.writeGen.recordUnscopedWrite();
  }

  async replaceGraph(
    graphUri: string,
    quads: DKGQuad[],
    options?: QueryOptions,
  ): Promise<void> {
    // Reserved-scope refusal is checked BEFORE the capability refusal so the
    // outcome does not depend on `atomicUpdates`, which the storage factory
    // synthesizes from plain config and therefore cannot be trusted to order
    // this guard.
    this.assertGenericMutationScope([graphUri], 'replaceGraph');
    if (!this.atomicUpdates) {
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
    const execute = async (update: string, source: string): Promise<void> => {
      await this.postUpdate(update, { ...options, source }, 'replaceGraph');
    };
    try {
      await execute(plan.update, options?.source ?? 'sparql-http.replaceGraph');
    } catch (error) {
      if (plan.cleanup) {
        await execute(plan.cleanup, 'sparql-http.replaceGraph.cleanup').catch(() => undefined);
      }
      this.invalidateListGraphsCache();
      throw error;
    }
    this.invalidateListGraphsCache();
    this.writeGen.recordGraphWrites([graphUri]);
  }

  async replaceGraphAndSubject(
    graphUri: string,
    graphQuads: DKGQuad[],
    metaGraphUri: string,
    metadataSubject: string,
    metadataQuads: DKGQuad[],
    options?: QueryOptions,
  ): Promise<void> {
    this.assertGenericMutationScope([graphUri, metaGraphUri], 'replaceGraphAndSubject');
    if (!this.atomicUpdates) {
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
    const execute = async (update: string, source: string): Promise<void> => {
      await this.postUpdate(update, { ...options, source }, 'replaceGraphAndSubject');
    };
    try {
      await execute(plan.update, options?.source ?? 'sparql-http.replaceGraphAndSubject');
    } catch (error) {
      await execute(plan.cleanup, 'sparql-http.replaceGraphAndSubject.cleanup').catch(() => undefined);
      this.invalidateListGraphsCache();
      throw error;
    }
    this.invalidateListGraphsCache();
    this.writeGen.recordGraphWrites([graphUri, metaGraphUri]);
  }

  async replaceSubject(
    graphUri: string,
    subject: string,
    quads: DKGQuad[],
    options?: QueryOptions,
  ): Promise<void> {
    this.assertGenericMutationScope([graphUri], 'replaceSubject');
    if (!this.atomicUpdates) {
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
    try {
      await this.postUpdate(
        update,
        { ...options, source: options?.source ?? 'sparql-http.replaceSubject' },
        'replaceSubject',
      );
    } catch (error) {
      // Indeterminate remote failure: a timeout / lost response can occur AFTER
      // the endpoint committed the DELETE/INSERT (which may have added the graph's
      // first row or removed its last). Invalidate the graph-list cache before
      // rethrowing so a direct managed caller never serves stale membership —
      // mirrors replaceGraph / replaceGraphAndSubject.
      this.invalidateListGraphsCache();
      throw error;
    }
    this.invalidateListGraphsCache();
    this.writeGen.recordGraphWrites([graphUri]);
  }

  async query(sparql: string, options?: SparqlHttpQueryOptions): Promise<QueryResult> {
    return this.runStoreWork('query', options, async (lifecycleSignal) => {
      const effectiveOptions: SparqlHttpQueryOptions = {
        ...options,
        signal: lifecycleSignal,
      };
      const startedAt = this.now();
      throwIfAborted(lifecycleSignal);
      const trimmed = sparql.trim();
      const upper = trimmed.toUpperCase();
      const isAsk = upper.startsWith('ASK');
      const isConstruct = upper.startsWith('CONSTRUCT') || upper.startsWith('DESCRIBE');

      try {
        if (isConstruct) {
          return await this.queryConstruct(trimmed, effectiveOptions);
        }

        return await this.postQuery(
          trimmed,
          'application/sparql-results+json',
          effectiveOptions,
          async (res) => {
            if (!res.ok) {
              const text = await (effectiveOptions.maxResponseBytes === undefined
                ? res.text()
                : readResponseTextBounded(res, effectiveOptions.maxResponseBytes)
              ).catch(() => '');
              throw new Error(`SPARQL HTTP query failed (${res.status}): ${text.slice(0, 300)}`);
            }

            const json = effectiveOptions.maxResponseBytes === undefined
              ? await res.json() as AdapterSparqlJsonSelectResponse | W3CAskResponse
              : JSON.parse(
                  await readResponseTextBounded(res, effectiveOptions.maxResponseBytes),
                ) as AdapterSparqlJsonSelectResponse | W3CAskResponse;

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

  private async queryConstruct(sparql: string, options?: SparqlHttpQueryOptions): Promise<ConstructResult> {
    return this.postQuery(
      sparql,
      'application/n-quads, text/n-quads',
      options,
      async (res) => {
        if (!res.ok) {
          const text = await (options?.maxResponseBytes === undefined
            ? res.text()
            : readResponseTextBounded(res, options.maxResponseBytes)
          ).catch(() => '');
          throw new Error(`SPARQL HTTP construct failed (${res.status}): ${text.slice(0, 300)}`);
        }
        const text = options?.maxResponseBytes === undefined
          ? await res.text()
          : await readResponseTextBounded(res, options.maxResponseBytes);
        const quads = parseNQuadsText(text);
        return { type: 'quads', quads };
      },
    );
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
    this.assertGenericMutationScope([graphUri], 'dropGraph');
    const update = `DROP SILENT GRAPH <${escapeUri(graphUri)}>`;
    await this.postUpdate(update, {
      ...options,
      source: options?.source ?? 'sparql-http.dropGraph',
    }, 'dropGraph');
    this.invalidateListGraphsCache();
    this.writeGen.recordGraphWrites([graphUri]);
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
    const r = await this.query(
      NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY,
      { ...options, source: options?.source ?? 'sparql-http.listGraphs' },
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
    // BEFORE the drain, and synchronously.
    //
    // The process-global lane registration was released ONLY by a session
    // shutdown, which a store that merely probed for feature detection never
    // performs. So a discovery-only store held the registration for the process
    // lifetime and every replacement store's probe was refused — measured as
    // `{first: true, second: false}`. Same for a failed `open()` and for an
    // open-then-`disable`.
    //
    // Releasing here also latches this store's session terminal, so nothing can
    // be admitted into a lane whose store is draining; doing it after the await
    // would leave that window open.
    this.releaseSystemRecordLane();
    // A managed endpoint is stopped immediately after store.close(). The
    // lifecycle owns one complete generation, aborting and draining every
    // operation admitted before close while rejecting work attempted during
    // close. A fresh generation is installed only after the drain completes.
    await this.workLifecycle.close(new Error('SparqlHttpStore closed'));
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
