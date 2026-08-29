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
import type {
  Rfc64AuthorCommitCasInputV1,
  Rfc64AuthorCommitCasResultV1,
} from './rfc64-author-commit-cas.js';
import type {
  Rfc64SemanticReadOperationV1,
  Rfc64SemanticStoreRowV1,
} from '@origintrail-official/dkg-core';

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
  /**
   * Execute one closed RFC-64 semantic read and return normalized typed rows.
   * Only adapters with explicit conformance evidence expose this capability;
   * generic SPARQL support is insufficient.
   */
  rfc64SemanticReadV1?(
    operation: Rfc64SemanticReadOperationV1,
    options?: Pick<QueryOptions, 'signal'>,
  ): Promise<readonly Rfc64SemanticStoreRowV1[]>;

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
  /**
   * Atomically replace every row for one subject inside a shared named graph,
   * leaving all other subjects in that graph untouched. Implementations MUST
   * guarantee ONE commit boundary, so a concurrent reader observes the subject
   * fully in its prior or its new state, never transiently empty (#1863).
   *
   * STRICT single-subject payload: EVERY quad in `quads` MUST target `graphUri`
   * and carry `subject` as its subject (implementations reject anything else),
   * and `subject` must be a canonical skolem IRI (not a blank node). Co-located
   * writes for another subject (e.g. an immutable request record re-asserted
   * beside a mutable job record) are the caller's own separate write, sequenced
   * so the reader never observes a dangling reference. Optional because generic
   * `update()` support is NOT sufficient — a non-transactional SPARQL endpoint
   * would apply the delete and the insert sequentially — so callers fall back
   * (delete-then-insert) when it is absent or refuses.
   */
  replaceSubject?(
    graphUri: string,
    subject: string,
    quads: Quad[],
    options?: QueryOptions,
  ): Promise<void>;
  /**
   * RFC-64 `SYNC_AUTHOR_COMMIT_CAS_V1`: atomically replace one complete shared
   * projection, its author-seal subject, the guarded author current-head
   * pointer, and bounded mutation/applied-set subjects.
   *
   * Implementations MUST refuse before mutation unless the whole generated
   * update is one backend transaction. `conflict` proves no semantic target was
   * changed; execution failures remain indeterminate and propagate.
   */
  rfc64AuthorCommitCasV1?(
    input: Rfc64AuthorCommitCasInputV1,
    options?: QueryOptions,
  ): Promise<Rfc64AuthorCommitCasResultV1>;
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
 * Public boundary implemented by every TripleStore decorator. Capability
 * discovery may traverse only this accessor; decorator-private fields are not
 * part of the contract.
 */
export interface TripleStoreDecorator extends TripleStore {
  readonly innerStore: TripleStore;
}

/** Resolve one optional capability through the documented decorator chain. */
export function findTripleStoreCapability<T>(
  store: unknown,
  isCapability: (candidate: unknown) => candidate is T,
): T | null {
  let candidate = store;
  const seen = new Set<unknown>();
  for (let depth = 0; candidate && depth < 16; depth += 1) {
    if (isCapability(candidate)) return candidate;
    if (typeof candidate !== 'object' || seen.has(candidate)) return null;
    seen.add(candidate);
    if (!('innerStore' in candidate)) return null;
    candidate = (candidate as { innerStore?: unknown }).innerStore;
  }
  return null;
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

/**
 * Attempt one atomic single-subject replace inside a shared named graph.
 *
 * Returns `false` when the store does not implement `replaceSubject`, or when a
 * decorator reports the wrapped store cannot guarantee it (a clean preflight
 * capability refusal raised before mutation) — the caller then takes its
 * non-atomic delete-then-insert fallback. Genuine execution failures propagate
 * so a caller never mistakes an outage or a partial mutation for "unsupported".
 */
export async function tryReplaceSubjectAtomically(
  store: TripleStore,
  graphUri: string,
  subject: string,
  quads: Quad[],
  options: QueryOptions = {},
): Promise<boolean> {
  const replaceSubject = store.replaceSubject;
  if (typeof replaceSubject !== 'function') return false;
  try {
    await replaceSubject.call(store, graphUri, subject, quads, options);
    return true;
  } catch (error) {
    if (
      error instanceof UnsupportedTripleStoreCapabilityError &&
      error.capability === 'replaceSubject'
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Attempt the certified RFC-64 author-publication CAS boundary.
 *
 * `null` is a clean capability refusal raised before mutation. A returned
 * `conflict` is also known not to have mutated semantic targets. Every other
 * failure propagates because the backend may have committed before its
 * response was lost.
 */
export async function tryRfc64AuthorCommitCasV1(
  store: TripleStore,
  input: Rfc64AuthorCommitCasInputV1,
  options: QueryOptions = {},
): Promise<Rfc64AuthorCommitCasResultV1 | null> {
  const commit = store.rfc64AuthorCommitCasV1;
  if (typeof commit !== 'function') return null;
  try {
    return await commit.call(store, input, options);
  } catch (error) {
    if (
      error instanceof UnsupportedTripleStoreCapabilityError
      && error.capability === 'rfc64AuthorCommitCasV1'
    ) {
      return null;
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
  // The outer GraphSetIndexStore replaces the adapter-local graph-list cache,
  // so clear only that cache-ownership flag. A daemon-supervised Oxigraph
  // process carries the separate runtime-only `managedOxigraph` capability;
  // never derive that consistency proof from persisted namespace ownership.
  return {
    ...config.options,
    managedByDkg: false,
  };
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
