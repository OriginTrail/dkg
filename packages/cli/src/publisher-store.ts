import { join } from 'node:path';
import { createTripleStore, startReadGraphs, type ReadGraphStoreConfig, type TripleStore, type TripleStoreConfig } from '@origintrail-official/dkg-storage';
import type { DkgConfig } from './config.js';
import { readGraphSettingsOutsideDaemon } from './read-graph-settings-start.js';
import { applyGraphCatalogConfig } from './graph-catalog-config.js';

/**
 * The store configuration of a publisher runtime or inspector built outside the daemon (`dkg publisher run`). Like every store object the node builds over
 * its backend, it carries the node's read-graph settings (`readGraphSettingsOutsideDaemon`), when config.json or the settings table has any. `readOnly`: an
 * embedded Oxigraph store is opened read-only and its file is never written (#3551).
 */
export function publisherStoreConfig(
  dataDir: string,
  config: DkgConfig,
  readOnly: boolean,
  readGraphs: ReadGraphStoreConfig | undefined,
): TripleStoreConfig {
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
 * Open the store of a publisher runtime or inspector outside the daemon. It is a second writer that runs while the daemon is down, so before it can write
 * it starts read graphs as the daemon does (`startReadGraphs`). The read graphs its settings keep stay `ready` and its layer maintains its writes to them;
 * working-memory ones only under the identity the daemon recorded in the data directory, which it then uses. Every other read graph is marked dirty, as a
 * release that does not maintain them does at start. A read-only store writes nothing and marks nothing.
 */
export async function createPublisherStore(dataDir: string, config: DkgConfig, readOnly = false): Promise<TripleStore> {
  // A bad `store.graphCatalog` or DKG_STORE_GRAPH_CATALOG_MAX_BYTES stops it here, before the store opens.
  applyGraphCatalogConfig(config.store?.graphCatalog);
  const store = await createTripleStore(publisherStoreConfig(dataDir, config, readOnly, await readGraphSettingsOutsideDaemon(dataDir, config)));
  if (readOnly) return store;
  try {
    await startReadGraphs(store, { dataDir });
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
