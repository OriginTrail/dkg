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

export interface QueryOptions {
  signal?: AbortSignal;
}

export interface TripleStore {
  insert(quads: Quad[]): Promise<void>;
  delete(quads: Quad[]): Promise<void>;
  deleteByPattern(pattern: Partial<Quad>): Promise<number>;
  query(sparql: string, options?: QueryOptions): Promise<QueryResult>;

  hasGraph(graphUri: string): Promise<boolean>;
  createGraph(graphUri: string): Promise<void>;
  dropGraph(graphUri: string): Promise<void>;
  listGraphs(): Promise<string[]>;

  deleteBySubjectPrefix(graphUri: string, prefix: string): Promise<number>;

  countQuads(graphUri?: string): Promise<number>;

  /**
   * Force any pending writes to durable storage and resolve only once the
   * persistence step is complete (or no-op for non-persistent backends).
   * Callers that need at-least-once durability for a specific write — e.g.
   * context-graph creation, where the SQLite cache survives crashes but the
   * triple store's debounced flush does not — should `await store.flush?.()`
   * after the relevant `insert(...)` call. Optional so HTTP-backed and
   * memory-only adapters can omit it without breaking the interface.
   */
  flush?(): Promise<void>;

  close(): Promise<void>;
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
  const store = await factory(config.options);
  const largeLiteralStorage = resolveLargeLiteralStorageOptions(config);
  if (!largeLiteralStorage) return store;
  return new SharedMemoryLiteralBlobStore(store, largeLiteralStorage);
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
