/**
 * TripleStore — pure SPARQL 1.1 interface for any RDF repository.
 * No vendor-specific methods. Any SPARQL-capable store (Oxigraph, Blazegraph,
 * Neptune, GraphDB, Jena, etc.) can implement this interface.
 */

import { dirname, join } from 'node:path';
import {
  DEFAULT_LARGE_LITERAL_THRESHOLD_BYTES,
  SharedMemoryLiteralBlobStore,
} from './shared-memory-literal-blob-store.js';
import {
  GraphSetIndexStore,
  type GraphSetIndexStoreOptions,
} from './graph-set-index-store.js';
import {
  ChangelogStore,
  type ChangelogStoreOptions,
} from './changelog-store.js';
import { UnsupportedTripleStoreCapabilityError } from './unsupported-capability-error.js';

export interface Quad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

export interface SelectResult {
  type: 'bindings';
  bindings: Array<Record<string, string>>;
}

export interface ConstructResult {
  type: 'quads';
  quads: Quad[];
}

export interface AskResult {
  type: 'boolean';
  value: boolean;
}

export type QueryResult = SelectResult | ConstructResult | AskResult;
export type QueryCancellationMode = 'interruptible' | 'pre-dispatch';
export type StoreWorkPriority = 'ack' | 'health' | 'normal' | 'background';

export interface StorePressureSnapshot {
  ackInflight: number;
  healthInflight?: number;
  normalInflight: number;
  backgroundInflight: number;
  ackQueued: number;
  healthQueued?: number;
  normalQueued: number;
  backgroundQueued: number;
  maxConcurrent: number;
  ackReservedSlots: number;
  normalReservedSlots?: number;
  healthReservedSlots?: number;
  backgroundReservedSlots?: number;
}

export interface QueryOptions {
  /** Human-readable caller tag used by adapters for diagnostics/telemetry. */
  source?: string;
  /**
   * Store admission priority. ACK verification uses `ack` so it can bypass
   * queued background scans; liveness probes use `health`; sync/catch-up work
   * may use `background`.
   */
  priority?: StoreWorkPriority;
  /**
   * Best-effort caller cancellation. Async backends should reject promptly when
   * aborted; synchronous embedded backends may only observe the signal before
   * dispatching or after returning from their blocking native call.
   */
  signal?: AbortSignal;
  /**
   * Optional pre-parse cap for remote response bodies. HTTP adapters stream
   * and reject above this bound before JSON/N-Quads materialization.
   */
  maxResponseBytes?: number;
}

export type TripleStoreQueryOptions = QueryOptions;

/**
 * Options for a server-side `update()`. A superset of {@link QueryOptions} with an
 * index-maintenance hint — kept OFF the read-path `QueryOptions` so it can't be set
 * on `listGraphs`/`query` reads where it is meaningless.
 */
export interface UpdateOptions extends QueryOptions {
  /**
   * The named graphs whose membership (existence) this UPDATE may change — the graphs
   * it creates, or empties/drops. When supplied, a graph-set index can maintain itself
   * INCREMENTALLY (a bounded `hasGraph` per graph) instead of marking the whole index
   * dirty and forcing a full `SELECT DISTINCT ?g` rebuild on the next read. Omit it for
   * opaque updates whose affected graphs are not derivable at the call site (those fall
   * back to a lazy full rebuild).
   */
  touchedGraphs?: readonly string[];
}

export interface TripleStore {
  /**
   * Whether `query(..., { signal })` can reject while a query is already in
   * flight (`interruptible`) or can only observe cancellation before dispatch
   * and after a blocking call returns (`pre-dispatch`).
   */
  readonly queryCancellation?: QueryCancellationMode;

  /**
   * Optional live pressure snapshot for stores that own or wrap an admission
   * scheduler. ACK deadline diagnostics use this capability instead of
   * reaching into a specific adapter's process-global scheduler.
   */
  getPressureSnapshot?(): StorePressureSnapshot | undefined;

  insert(quads: Quad[], options?: QueryOptions): Promise<void>;
  delete(quads: Quad[], options?: QueryOptions): Promise<void>;
  deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions): Promise<number>;
  query(sparql: string, options?: QueryOptions): Promise<QueryResult>;

  hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean>;
  createGraph(graphUri: string): Promise<void>;
  dropGraph(graphUri: string, options?: QueryOptions): Promise<void>;
  /**
   * Atomically replace one named graph with the supplied complete quad set.
   *
   * Every quad MUST target `graphUri`. On success readers observe the complete
   * new graph (or no graph for an empty set); on failure they observe either the
   * complete prior graph or the complete new graph, never a DROP/INSERT prefix.
   * Optional because third-party adapters may not provide a transactional
   * SPARQL Update boundary. Rootless KA mutation paths require this capability
   * and fail closed when it is unavailable.
   */
  replaceGraph?(graphUri: string, quads: Quad[], options?: QueryOptions): Promise<void>;
  /**
   * Atomically replace one complete named graph and every row for one subject
   * in a second named graph. Implementations MUST guarantee one commit boundary
   * for both replacements; generic update() support is not sufficient.
   */
  replaceGraphAndSubject?(
    graphUri: string,
    graphQuads: Quad[],
    metaGraphUri: string,
    metadataSubject: string,
    metadataQuads: Quad[],
    options?: QueryOptions,
  ): Promise<void>;
  listGraphs(options?: QueryOptions): Promise<string[]>;
  listGraphsByPrefix?(prefix: string, options?: QueryOptions): Promise<string[]>;

  deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number>;

  /**
   * Run a SPARQL UPDATE (e.g. a server-side `INSERT { GRAPH dst {…} } WHERE
   * { GRAPH src {…} }` graph-to-graph copy) entirely inside the backend, so
   * terms NEVER get serialized to JS and re-parsed. This is required for any
   * byte-stable copy: the `insert(quads)` path round-trips object terms through
   * `termToString`→`parseTerm`, which doubles backslashes for literals bearing
   * `\`/newline/quote/CR/tab and therefore changes the bytes a content-bound
   * hash (e.g. RS proof leaves) is computed over. Optional: only the embedded
   * `oxigraph` and the `oxigraph-server`/`sparql-http` adapters implement it;
   * callers needing a byte-stable copy MUST guard on its presence and never
   * fall back to `insert(quads)` for already-stored terms.
   */
  update?(sparql: string, options?: UpdateOptions): Promise<void>;

  /**
   * True only when a single multi-operation UPDATE request (e.g.
   * `DELETE WHERE { … } ; INSERT DATA { … }`) commits as ONE atomic
   * transaction, so a concurrent reader observes every operation applied or
   * none — never a partial prefix. Merely implementing `update()` is NOT
   * sufficient: a generic SPARQL endpoint may apply the operations
   * sequentially. Callers that need old-or-new visibility across a multi-op
   * group (e.g. a single-subject atomic replace built from `DELETE WHERE` +
   * `INSERT DATA`) MUST gate on this and fall back otherwise. Decorators
   * forward the wrapped store's value; an unforwarded/absent value is falsy,
   * so callers conservatively take their non-atomic fallback.
   */
  readonly atomicUpdateGroups?: boolean;

  countQuads(graphUri?: string, options?: QueryOptions): Promise<number>;

  /**
   * Force any pending writes to durable storage and resolve only once the
   * persistence step is complete (or no-op for non-persistent backends).
   * Callers that need at-least-once durability for a specific write — e.g.
   * context-graph creation, where the SQLite cache survives crashes but the
   * triple store's debounced flush does not — should `await store.flush?.()`
   * after the relevant `insert(...)` call. Optional so HTTP-backed and
   * memory-only adapters can omit it without breaking the interface.
   */
  flush?(options?: QueryOptions): Promise<void>;

  close(): Promise<void>;
}

/**
 * Run a server-side update whose affected named graphs are known by the caller.
 * Returns `false` when the store does not support `update()` directly, or when
 * a decorator reports that its wrapped store lacks the capability. Genuine
 * update execution errors propagate so feature code cannot mask an outage or
 * partially executed mutation as a compatibility fallback.
 */
export async function tryUpdateWithTouchedGraphs(
  store: TripleStore,
  sparql: string,
  touchedGraphs: readonly string[],
  options: QueryOptions = {},
): Promise<boolean> {
  const update = store.update;
  if (typeof update !== 'function') return false;
  try {
    await update.call(store, sparql, { ...options, touchedGraphs });
    return true;
  } catch (error) {
    if (
      error instanceof UnsupportedTripleStoreCapabilityError &&
      error.capability === 'update'
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Attempt an atomic complete named-graph replacement.
 *
 * `false` means the capability is genuinely unavailable and no mutation was
 * started. Execution failures propagate, including indeterminate remote-store
 * failures, so callers never mistake an outage for a safe compatibility path.
 */
export async function tryReplaceGraphAtomically(
  store: TripleStore,
  graphUri: string,
  quads: Quad[],
  options: QueryOptions = {},
): Promise<boolean> {
  const replaceGraph = store.replaceGraph;
  if (typeof replaceGraph !== 'function') return false;
  try {
    await replaceGraph.call(store, graphUri, quads, options);
    return true;
  } catch (error) {
    if (
      error instanceof UnsupportedTripleStoreCapabilityError &&
      error.capability === 'replaceGraph'
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Attempt one atomic complete-graph + metadata-subject replacement.
 *
 * `false` is a clean capability refusal raised before mutation. Execution
 * failures propagate because a remote response can be indeterminate.
 */
export async function tryReplaceGraphAndSubjectAtomically(
  store: TripleStore,
  graphUri: string,
  graphQuads: Quad[],
  metaGraphUri: string,
  metadataSubject: string,
  metadataQuads: Quad[],
  options: QueryOptions = {},
): Promise<boolean> {
  const replace = store.replaceGraphAndSubject;
  if (typeof replace !== 'function') return false;
  try {
    await replace.call(
      store,
      graphUri,
      graphQuads,
      metaGraphUri,
      metadataSubject,
      metadataQuads,
      options,
    );
    return true;
  } catch (error) {
    if (
      error instanceof UnsupportedTripleStoreCapabilityError &&
      error.capability === 'replaceGraphAndSubject'
    ) {
      return false;
    }
    throw error;
  }
}

export type TripleStoreBackend = 'oxigraph' | 'oxigraph-persistent' | 'oxigraph-worker' | 'blazegraph' | 'sparql-http' | string;

// Backends that talk to a remote SPARQL endpoint over HTTP rather than
// owning local files. The local/external split governs three pieces of
// daemon behaviour:
//   1. Store-size metric — local backends report file bytes, external
//      backends have no file to stat (`getStoreBytes` returns null).
//   2. Chain-reset wipe — local backends `rm` files, external backends
//      issue SPARQL UPDATE (scoped DELETE for operator-provided URLs to
//      avoid clobbering V6/V8 data sharing the instance; DROP ALL only
//      when the namespace is owned by the CLI, signalled via
//      `storeConfig.options.managedByDkg`).
//   3. Boot health check — for external backends, an ASK probe runs at
//      daemon start; an unreachable endpoint exits the daemon with an
//      actionable message rather than booting half-broken.
const EXTERNAL_BACKENDS: ReadonlySet<string> = new Set(['blazegraph', 'sparql-http']);

export function isExternalBackend(backend: string | undefined | null): boolean {
  return typeof backend === 'string' && EXTERNAL_BACKENDS.has(backend);
}

/**
 * Shape-normalised SPARQL endpoint extracted from a TripleStoreConfig.
 *
 * `blazegraph` adapters use a single `options.url`; `sparql-http`
 * adapters use distinct `options.queryEndpoint` / `options.updateEndpoint`
 * with an optional auth header. Callers that need to issue raw SPARQL
 * (chain-reset wipe, boot health check, namespace identity tag) use this
 * helper instead of duplicating the options-shape logic in three places.
 */
export interface SparqlEndpoint {
  queryUrl: string;
  updateUrl: string;
  headers: Record<string, string>;
}

export function getSparqlEndpoint(storeConfig: TripleStoreConfig): SparqlEndpoint {
  if (!isExternalBackend(storeConfig.backend)) {
    throw new Error(
      `getSparqlEndpoint called for non-external backend "${storeConfig.backend}"`,
    );
  }
  const opts = (storeConfig.options ?? {}) as Record<string, unknown>;
  if (storeConfig.backend === 'blazegraph') {
    const url = typeof opts.url === 'string' ? opts.url : '';
    if (!url) {
      throw new Error('blazegraph storeConfig requires options.url');
    }
    return { queryUrl: url, updateUrl: url, headers: {} };
  }
  // sparql-http
  const queryEndpoint = typeof opts.queryEndpoint === 'string' ? opts.queryEndpoint : '';
  if (!queryEndpoint) {
    throw new Error('sparql-http storeConfig requires options.queryEndpoint');
  }
  const updateEndpoint =
    typeof opts.updateEndpoint === 'string' && opts.updateEndpoint
      ? opts.updateEndpoint
      : queryEndpoint;
  const headers: Record<string, string> = {};
  if (typeof opts.auth === 'string' && opts.auth) {
    headers['Authorization'] = opts.auth;
  }
  return { queryUrl: queryEndpoint, updateUrl: updateEndpoint, headers };
}

export interface LargeLiteralStorageConfig {
  /** Enable large SWM literal blob storage. Defaults to true when present. */
  enabled?: boolean;
  /** Externalize literal object terms larger than this UTF-8 byte size. */
  thresholdBytes?: number;
  /** Content-addressed blob directory. Defaults to `<dirname(options.path)>/literal-blobs` when a persistent path is available. */
  directory?: string;
}

export interface TripleStoreConfig {
  backend: TripleStoreBackend;
  options?: Record<string, unknown>;
  largeLiteralStorage?: LargeLiteralStorageConfig;
  graphSetIndex?: boolean | GraphSetIndexStoreOptions;
  /**
   * OT-RFC-59 append-only change log (write-side). **Default OFF** — opt-in per
   * store, independent of backend (unlike `graphSetIndex`, which is gated to
   * local Oxigraph): the changelog must work on Blazegraph too, and its cost is
   * a few marker quads per write. Enable ONLY on a single-writer (daemon) store;
   * see the {@link ChangelogStore} single-writer caveat.
   */
  changelog?: boolean | ChangelogStoreOptions;
}

type AdapterFactory = (
  options?: Record<string, unknown>,
) => Promise<TripleStore>;

const adapterRegistry = new Map<string, AdapterFactory>();

export function registerTripleStoreAdapter(
  name: string,
  factory: AdapterFactory,
): void {
  adapterRegistry.set(name, factory);
}

export async function createTripleStore(
  config: TripleStoreConfig,
): Promise<TripleStore> {
  const factory = adapterRegistry.get(config.backend);
  if (!factory) {
    throw new Error(
      `Unknown TripleStore backend: "${config.backend}". ` +
        `Registered: [${[...adapterRegistry.keys()].join(', ')}]`,
    );
  }
  const store = await factory(resolveAdapterOptions(config));
  const largeLiteralStorage = resolveLargeLiteralStorageOptions(config);
  const withLargeLiteralStorage = largeLiteralStorage
    ? new SharedMemoryLiteralBlobStore(store, largeLiteralStorage)
    : store;
  const withGraphSetIndex = wrapGraphSetIndex(withLargeLiteralStorage, config);
  // Changelog is the OUTERMOST decorator: it observes logical mutations first,
  // reuses the graph-set index's fast listGraphs() for reconcile, and hides its
  // own reserved graph from everything above.
  return wrapChangelog(withGraphSetIndex, config);
}

function wrapChangelog(store: TripleStore, config: TripleStoreConfig): TripleStore {
  const changelog = config.changelog;
  if (changelog == null || changelog === false) return store; // default OFF
  if (typeof changelog === 'object' && changelog.enabled === false) return store;
  const options = typeof changelog === 'object' ? changelog : undefined;
  return new ChangelogStore(store, options);
}

function resolveAdapterOptions(config: TripleStoreConfig): Record<string, unknown> | undefined {
  if (
    config.backend !== 'sparql-http' ||
    config.options?.managedByDkg !== true ||
    isGraphSetIndexExplicitlyDisabled(config.graphSetIndex) ||
    !shouldEnableGraphSetIndex(config)
  ) {
    return config.options;
  }
  // `managedByDkg` has two independent meanings in SparqlHttpStore: it owns
  // the adapter-local graph-list cache and it identifies the transactional
  // daemon-managed Oxigraph endpoint. The outer GraphSetIndexStore replaces
  // only the cache, so preserve the endpoint's atomic-update capability when
  // clearing the cache-ownership flag.
  return { ...config.options, managedByDkg: false, atomicUpdates: true };
}

function wrapGraphSetIndex(
  store: TripleStore,
  config: TripleStoreConfig,
): TripleStore {
  const graphSetIndex = config.graphSetIndex;
  if (isGraphSetIndexExplicitlyDisabled(graphSetIndex)) return store;
  if (!shouldEnableGraphSetIndex(config)) return store;
  const options = typeof graphSetIndex === 'object' ? graphSetIndex : undefined;
  return new GraphSetIndexStore(store, options);
}

function isGraphSetIndexExplicitlyDisabled(
  graphSetIndex: TripleStoreConfig['graphSetIndex'],
): boolean {
  return graphSetIndex === false ||
    (typeof graphSetIndex === 'object' && graphSetIndex.enabled === false);
}

function shouldEnableGraphSetIndex(config: TripleStoreConfig): boolean {
  if (config.graphSetIndex === true || typeof config.graphSetIndex === 'object') return true;
  if (isDefaultLocalGraphSetIndexBackend(config.backend)) return true;
  return config.options?.managedByDkg === true;
}

function isDefaultLocalGraphSetIndexBackend(backend: TripleStoreBackend): boolean {
  return backend === 'oxigraph'
    || backend === 'oxigraph-persistent'
    || backend === 'oxigraph-worker';
}

function resolveLargeLiteralStorageOptions(
  config: TripleStoreConfig,
): { blobDir: string; thresholdBytes: number } | undefined {
  const largeLiteralStorage = config.largeLiteralStorage;
  if (!largeLiteralStorage || largeLiteralStorage.enabled === false) return undefined;

  const thresholdBytes = largeLiteralStorage.thresholdBytes ?? DEFAULT_LARGE_LITERAL_THRESHOLD_BYTES;
  const directory = largeLiteralStorage.directory ?? inferLiteralBlobDirectory(config.options);
  if (!directory) {
    throw new Error(
      'largeLiteralStorage.directory is required when the triple-store options do not include a persistent path',
    );
  }

  return { blobDir: directory, thresholdBytes };
}

function inferLiteralBlobDirectory(options: Record<string, unknown> | undefined): string | undefined {
  const persistPath = options?.path;
  if (typeof persistPath !== 'string' || persistPath.trim().length === 0) return undefined;
  return join(dirname(persistPath), 'literal-blobs');
}
