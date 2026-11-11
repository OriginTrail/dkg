import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';

/** Storage loaded afresh: the configured ceiling belongs to the process, which keeps one. */
async function freshStorage() {
  vi.resetModules();
  return await import('../src/index.js');
}

afterEach(() => vi.unstubAllEnvs());

describe('the graph catalog ceiling from the store config', () => {
  it('takes the environment variable over the configured value, and the configured value over the default', async () => {
    const storage = await freshStorage();
    vi.stubEnv(storage.STORE_GRAPH_CATALOG_MAX_BYTES_ENV, '');
    expect(storage.storeGraphCatalogMaxBytes()).toBe(storage.DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES);
    storage.configureStoreGraphCatalogMaxBytes(4096);
    expect(storage.storeGraphCatalogMaxBytes()).toBe(4096);
    vi.stubEnv(storage.STORE_GRAPH_CATALOG_MAX_BYTES_ENV, '8192');
    expect(storage.storeGraphCatalogMaxBytes()).toBe(8192);
    // Storage ignores an environment value that is not a positive whole number; the daemon refuses it at boot.
    vi.stubEnv(storage.STORE_GRAPH_CATALOG_MAX_BYTES_ENV, 'lots');
    expect(storage.storeGraphCatalogMaxBytes()).toBe(4096);
  });

  it.each([0, -1, 1.5, Number.NaN, '4096', null, undefined])('refuses %s as the configured ceiling', async (value) => {
    const storage = await freshStorage();
    expect(() => storage.configureStoreGraphCatalogMaxBytes(value)).toThrow(
      /^store\.graphCatalog\.maxBytes must be a positive whole number of bytes, not /,
    );
  });

  it('keeps one ceiling per process: the same value again is accepted, another is refused', async () => {
    const storage = await freshStorage();
    storage.configureStoreGraphCatalogMaxBytes(4096);
    storage.configureStoreGraphCatalogMaxBytes(4096);
    expect(() => storage.configureStoreGraphCatalogMaxBytes(8192)).toThrow(
      'store.graphCatalog.maxBytes is 4096 in this process already; a store config asked for 8192',
    );
  });

  it('bounds the catalog reads of a store built with the setting', async () => {
    const storage = await freshStorage();
    vi.stubEnv(storage.STORE_GRAPH_CATALOG_MAX_BYTES_ENV, '');
    const store = await storage.createTripleStore({ backend: 'oxigraph', graphCatalog: { maxBytes: 200 } });
    try {
      expect(storage.storeGraphCatalogMaxBytes()).toBe(200);
      await store.insert(Array.from({ length: 10 }, (_, i) => ({
        subject: 'urn:s', predicate: 'urn:p', object: `"${i}"`, graph: `did:dkg:context-graph:limit-config/${i}`,
      })));
      await expect(store.listGraphs()).rejects.toMatchObject({
        code: 'STORE_INTERNAL_LIMIT', limitName: 'STORE_GRAPH_CATALOG_MAX_BYTES', limitBytes: 200,
      });
    } finally { await store.close(); }
  });

  it('bounds the catalog reads inside an Oxigraph worker thread, also after the thread respawns', async () => {
    const storage = await freshStorage();
    vi.stubEnv(storage.STORE_GRAPH_CATALOG_MAX_BYTES_ENV, '');
    const dir = mkdtempSync(join(tmpdir(), 'graph-catalog-worker-'));
    // No outer graph index, so the worker's own check is the one that refuses.
    const store = await storage.createTripleStore({
      backend: 'oxigraph-worker', options: { path: join(dir, 'store.nq') }, graphSetIndex: false, graphCatalog: { maxBytes: 200 },
    });
    try {
      await store.insert(Array.from({ length: 10 }, (_, i) => ({
        subject: 'urn:s', predicate: 'urn:p', object: `"${i}"`, graph: `did:dkg:context-graph:limit-config/${i}`,
      })));
      await store.flush?.();
      const refused = { code: 'STORE_INTERNAL_LIMIT', limitName: 'STORE_GRAPH_CATALOG_MAX_BYTES', limitBytes: 200 };
      await expect(store.listGraphs()).rejects.toMatchObject(refused);
      // An unexpected exit respawns the thread, which takes the configured value again. The worker
      // store sits under the read-graph layer that every store gets.
      const adapter = (storage.readGraphLayerOf(store) as unknown as { innerStore: { worker: Worker } }).innerStore;
      await adapter.worker.terminate();
      await expect(store.listGraphs()).rejects.toMatchObject(refused);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the ceiling alone for a store config without the setting', async () => {
    const storage = await freshStorage();
    vi.stubEnv(storage.STORE_GRAPH_CATALOG_MAX_BYTES_ENV, '');
    const store = await storage.createTripleStore({ backend: 'oxigraph' });
    try {
      expect(storage.storeGraphCatalogMaxBytes()).toBe(storage.DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES);
    } finally { await store.close(); }
  });

  it('carries the setting on a managed Oxigraph runtime config', async () => {
    const storage = await freshStorage();
    const managed = storage.createManagedOxigraphRuntimeStoreConfigV1({
      backend: 'sparql-http',
      options: { queryEndpoint: 'http://127.0.0.1:7878/query', managedByDkg: true },
    }, { getRecoveryState: () => ({ recovering: false, generation: 0 }) });
    const updated = storage.withManagedOxigraphRuntimeStoreConfigV1(managed, { graphCatalog: { maxBytes: 4096 } });
    expect(updated.graphCatalog).toEqual({ maxBytes: 4096 });
    // A later update that does not name it keeps it; that update also needs the managed control plane, so the config kept it too.
    expect(storage.withManagedOxigraphRuntimeStoreConfigV1(updated, { changelog: false }).graphCatalog).toEqual({ maxBytes: 4096 });
  });
});
