import { join } from 'node:path';
import { createTripleStore, markReadGraphsDirtyAtStart, type TripleStore, type TripleStoreConfig } from '@origintrail-official/dkg-storage';
import type { DkgConfig } from './config.js';
import { readGraphStoreSettings, resolveQueryConfig } from './read-graphs-config.js';
import { applyGraphCatalogConfig } from './graph-catalog-config.js';

/**
 * The store configuration of a publisher runtime or inspector built outside the daemon (`dkg publisher run`). Like every store object the node builds over
 * its backend, it carries the node's read-graph settings when config.json has a `query` section. `readOnly`: an embedded Oxigraph store is opened
 * read-only and its file is never written (#3551).
 */
export function publisherStoreConfig(dataDir: string, config: DkgConfig, readOnly = false): TripleStoreConfig {
  const readGraphs = config.query === undefined ? undefined : readGraphStoreSettings(resolveQueryConfig(config.query));
  const storeConfig = config.store;
  if (storeConfig?.backend) { // a store section with only settings keeps the default store
    return {
      ...storeConfig,
      // Only the embedded Oxigraph adapters write a store file back; an external store is a server the inspector only queries.
      ...(readOnly && isLocalOxigraphStoreConfig(storeConfig) ? { options: { ...storeConfig.options, readOnly } } : {}),
      // OT-RFC-59 §5.3: the daemon-down CLI publisher is a SECOND writer against
      // the same store. It MUST NOT maintain the change log — a second in-memory
      // seq allocator would fork the log (commit order ≠ seq order across
      // processes). Only the single-writer daemon owns the changelog; force it
      // off here regardless of config.store.changelog.
      changelog: false,
      largeLiteralStorage: config.largeLiteralStorage ?? (
        isLocalOxigraphStoreConfig(storeConfig)
          ? defaultLargeLiteralStorage(dataDir, config)
          : undefined
      ),
      readGraphs,
    };
  }

  return {
    backend: 'oxigraph-worker',
    options: { path: join(dataDir, 'store.nq'), readOnly },
    largeLiteralStorage: defaultLargeLiteralStorage(dataDir, config),
    readGraphs,
    ...(storeConfig?.graphCatalog === undefined ? {} : { graphCatalog: storeConfig.graphCatalog }),
  };
}

/**
 * Open the store of a publisher runtime or inspector outside the daemon. It is a second writer that runs while the daemon is down, and nothing
 * maintains read graphs in its process, so before it can write it marks every read graph it finds dirty, as a release that does not maintain them
 * does at start (`markReadGraphsDirtyAtStart`): no row stays `ready` across its writes. A read-only store writes nothing and marks nothing.
 */
export async function createPublisherStore(dataDir: string, config: DkgConfig, readOnly = false): Promise<TripleStore> {
  // A bad `store.graphCatalog` or DKG_STORE_GRAPH_CATALOG_MAX_BYTES stops it here, before the store opens.
  applyGraphCatalogConfig(config.store?.graphCatalog);
  const store = await createTripleStore(publisherStoreConfig(dataDir, config, readOnly));
  if (readOnly) return store;
  try {
    await markReadGraphsDirtyAtStart(store, { dataDir });
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
  return store;
}

function defaultLargeLiteralStorage(dataDir: string, config: DkgConfig) {
  return {
    enabled: config.largeLiteralStorage?.enabled ?? true,
    thresholdBytes: config.largeLiteralStorage?.thresholdBytes,
    directory: config.largeLiteralStorage?.directory ?? join(dataDir, 'literal-blobs'),
  };
}

function isLocalOxigraphStoreConfig(storeConfig: { backend?: unknown }): boolean {
  return storeConfig.backend === 'oxigraph'
    || storeConfig.backend === 'oxigraph-worker'
    || storeConfig.backend === 'oxigraph-persistent';
}
