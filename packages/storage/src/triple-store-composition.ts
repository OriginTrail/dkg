/**
 * How `createTripleStore` composes a backend adapter with its decorators: the
 * store configuration types, and the helpers that decide and apply each
 * decorator layer.
 */
import { dirname, join } from 'node:path';
import { DEFAULT_LARGE_LITERAL_THRESHOLD_BYTES } from './shared-memory-literal-blob-store.js';
import {
  GraphSetIndexStore,
  type GraphSetIndexStoreOptions,
} from './graph-set-index-store.js';
import {
  ChangelogStore,
  type ChangelogStoreOptions,
} from './changelog-store.js';
import type { TripleStore } from './triple-store.js';
import type { ReadGraphStoreConfig } from './read-graph/read-graph-store.js';
import type { GraphCatalogStoreConfig } from './graph-catalog-internal-limit.js';

export type TripleStoreBackend = 'oxigraph' | 'oxigraph-persistent' | 'oxigraph-worker' | 'blazegraph' | 'sparql-http' | string;

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
   * store, independent of backend (unlike `graphSetIndex`, whose default
   * depends on the backend): the changelog must work on Blazegraph too, and its cost is
   * a few marker quads per write. Enable ONLY on a single-writer (daemon) store;
   * see the {@link ChangelogStore} single-writer caveat.
   */
  changelog?: boolean | ChangelogStoreOptions;
  /**
   * Settings of the read-graph layer. Every store gets the layer, directly
   * above the adapter; it maintains the read graphs that exist on the backend
   * and sends exactly today's requests while there are none.
   */
  readGraphs?: ReadGraphStoreConfig;
  /** The node's graph catalog ceiling; it applies to the whole process (see `configureStoreGraphCatalogMaxBytes`). */
  graphCatalog?: GraphCatalogStoreConfig;
}

export function wrapChangelog(store: TripleStore, config: TripleStoreConfig): TripleStore {
  const changelog = config.changelog;
  if (changelog == null || changelog === false) return store; // default OFF
  if (typeof changelog === 'object' && changelog.enabled === false) return store;
  const options = typeof changelog === 'object' ? changelog : undefined;
  return new ChangelogStore(store, options);
}

export function resolveAdapterOptions(config: TripleStoreConfig): Record<string, unknown> | undefined {
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
  // process carries separate storage-issued runtime provenance; never derive
  // that consistency proof from persisted namespace ownership.
  return Object.freeze({
    ...config.options,
    managedByDkg: false,
  });
}

export function wrapGraphSetIndex(
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
  if (isDefaultGraphSetIndexBackend(config.backend)) return true;
  return config.options?.managedByDkg === true;
}

/**
 * Backends indexed unless `graphSetIndex` is false: local Oxigraph only. The index
 * assumes this node is the store's only writer. That holds for local Oxigraph and for
 * stores the DKG manages; for a store configured by hand only its operator knows, so
 * `graphSetIndex: true` switches the index on there.
 */
function isDefaultGraphSetIndexBackend(backend: TripleStoreBackend): boolean {
  return backend === 'oxigraph'
    || backend === 'oxigraph-persistent'
    || backend === 'oxigraph-worker';
}

export function resolveLargeLiteralStorageOptions(
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
