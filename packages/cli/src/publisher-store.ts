import { join } from 'node:path';
import { createTripleStore, type TripleStore, type TripleStoreConfig } from '@origintrail-official/dkg-storage';
import type { DkgConfig } from './config.js';
import { readGraphStoreSettings, resolveQueryConfig } from './read-graphs-config.js';

/**
 * The store configuration of a publisher runtime or inspector built outside the daemon (`dkg publisher run`). Like every store object the node builds over
 * its backend, it carries the node's read-graph settings when config.json has a `query` section. `readOnly`: an embedded Oxigraph store is opened
 * read-only and its file is never written (#3551).
 */
export function publisherStoreConfig(dataDir: string, config: DkgConfig, readOnly = false): TripleStoreConfig {
  const readGraphs = config.query === undefined ? undefined : readGraphStoreSettings(resolveQueryConfig(config.query));
  const storeConfig = config.store;
  if (storeConfig) {
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
  };
}

export async function createPublisherStore(dataDir: string, config: DkgConfig, readOnly = false): Promise<TripleStore> {
  return await createTripleStore(publisherStoreConfig(dataDir, config, readOnly));
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
