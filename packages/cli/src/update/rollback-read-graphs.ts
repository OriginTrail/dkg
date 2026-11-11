import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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

/** Embedded backends whose store is a file or directory that the configuration names. */
const EMBEDDED_STORE_BACKENDS: ReadonlySet<string> = new Set(['oxigraph', 'oxigraph-worker', 'oxigraph-persistent']);

/**
 * Refuse a configured embedded store whose location this process cannot match
 * to the daemon's. A relative path resolves against each process's own working
 * directory, and a path with nothing behind it would open a new, empty store:
 * either way the drop would find no read graph while the node's store keeps
 * them. A store without a path holds nothing once the daemon stops.
 */
export function assertStoppedStoreLocation(config: TripleStoreConfig): void {
  if (!EMBEDDED_STORE_BACKENDS.has(config.backend)) return;
  const path = (config.options as { readonly path?: unknown } | undefined)?.path;
  if (typeof path !== 'string' || path === '') return;
  if (!isAbsolute(path)) {
    throw new Error(`The configured store path "${path}" is relative, so it cannot be matched to the store the node used. `
      + 'Set store.options.path to an absolute path in config.json, then run the rollback again.');
  }
  if (!existsSync(path)) {
    throw new Error(`The configured store ${path} does not exist, so its read graphs cannot be dropped. `
      + 'Set store.options.path to the store the node used, then run the rollback again.');
  }
}

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
  const configured = config.store as TripleStoreConfig | undefined;
  if (configured) assertStoppedStoreLocation(configured);
  const store = await createTripleStore({
    ...(configured ?? { backend: 'oxigraph-worker', options: { path: join(dataDir, 'store.nq') } }),
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
