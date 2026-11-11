import { join } from 'node:path';
import {
  clearReadGraphPartitionsNote,
  createTripleStore,
  dropReadGraphPartitions,
  mayHoldReadGraphPartitions,
  withManagedOxigraphRuntimeStoreConfigV1,
  type TripleStore,
  type TripleStoreConfig,
} from '@origintrail-official/dkg-storage';
import { loadConfig } from '../config.js';
import { startManagedOxigraph } from '../daemon/oxigraph-managed.js';

// Read graphs are node-local data derived from the stored graphs. A release
// that does not recognize them would list, sync and count them as ordinary
// graphs, so a rollback drops them before the version switch.

/** A triple store opened while the daemon is stopped. */
interface StoppedNodeStore {
  readonly store: TripleStore;
  close(): Promise<void>;
}

export type OpenStoppedNodeStore = (dataDir: string, log: (message: string) => void) => Promise<StoppedNodeStore>;

/**
 * Open this node's triple store with the daemon stopped, the way the daemon
 * opens it: a managed Oxigraph server runs only for the duration, and the
 * changelog stays off because this process is not the daemon.
 */
export const openStoppedNodeStore: OpenStoppedNodeStore = async (dataDir, log) => {
  const config = await loadConfig();
  const managed = await startManagedOxigraph({ config, dataDir, log });
  if (managed) {
    try {
      const store = await createTripleStore(withManagedOxigraphRuntimeStoreConfigV1(managed.storeConfig, { changelog: false }));
      return { store, close: async () => { try { await store.close(); } finally { await managed.handle.stop(); } } };
    } catch (error) {
      await managed.handle.stop();
      throw error;
    }
  }
  // A store section with only settings (no backend) keeps the default store, with those settings, as the daemon does.
  const configured = config.store?.backend ? config.store as TripleStoreConfig : undefined;
  const store = await createTripleStore({
    ...(configured ?? { backend: 'oxigraph-worker', options: { path: join(dataDir, 'store.nq') }, graphCatalog: config.store?.graphCatalog }),
    changelog: false,
  });
  return { store, close: () => store.close() };
};

/**
 * With the daemon stopped: drop every read-graph partition when the data
 * directory says the store may hold one. Null when there was nothing to do;
 * otherwise the number of graphs dropped. The note is removed only after the
 * store has closed, so an embedded store has written the drop to disk.
 */
export async function dropReadGraphsForRollback(
  dataDir: string,
  log: (message: string) => void,
  open: OpenStoppedNodeStore = openStoppedNodeStore,
): Promise<number | null> {
  if (!mayHoldReadGraphPartitions(dataDir)) return null;
  const opened = await open(dataDir, log);
  let dropped: number;
  try {
    dropped = await dropReadGraphPartitions(opened.store, { priority: 'background' });
  } catch (error) {
    await opened.close().catch(() => undefined);
    throw error;
  }
  await opened.close();
  clearReadGraphPartitionsNote(dataDir);
  return dropped;
}
