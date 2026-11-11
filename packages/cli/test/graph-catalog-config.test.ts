import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DkgConfig } from '../src/config.js';

const ENV = 'DKG_STORE_GRAPH_CATALOG_MAX_BYTES';

/**
 * Storage and the modules that build stores, loaded afresh: the ceiling belongs to the process,
 * which keeps one, so each case starts from a process that has set none.
 */
async function fresh() {
  vi.resetModules();
  const storage = await import('@origintrail-official/dkg-storage');
  const { applyGraphCatalogConfig } = await import('../src/graph-catalog-config.js');
  const { buildAgentRuntimeStoreConfig } = await import('../src/daemon/agent-runtime-store-config.js');
  return { storage, applyGraphCatalogConfig, buildAgentRuntimeStoreConfig };
}

afterEach(() => vi.unstubAllEnvs());

describe('store.graphCatalog.maxBytes', () => {
  it('sets the process ceiling, which the environment variable overrides', async () => {
    vi.stubEnv(ENV, '');
    const { storage, applyGraphCatalogConfig } = await fresh();
    expect(storage.storeGraphCatalogMaxBytes()).toBe(storage.DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES);
    expect(applyGraphCatalogConfig({ maxBytes: 536_870_912 })).toEqual({ maxBytes: 536_870_912 });
    expect(storage.storeGraphCatalogMaxBytes()).toBe(536_870_912);
    vi.stubEnv(ENV, '1073741824');
    expect(storage.storeGraphCatalogMaxBytes()).toBe(1_073_741_824);
  });

  it('leaves the default when the section or the value is absent', async () => {
    vi.stubEnv(ENV, '');
    const { storage, applyGraphCatalogConfig } = await fresh();
    expect(applyGraphCatalogConfig(undefined)).toBeUndefined();
    expect(applyGraphCatalogConfig({})).toBeUndefined();
    expect(storage.storeGraphCatalogMaxBytes()).toBe(storage.DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES);
  });

  it.each([0, -1, 1.5, '536870912', null, Number.MAX_SAFE_INTEGER + 1])('refuses %s, naming the setting', async (maxBytes) => {
    vi.stubEnv(ENV, '');
    const { storage, applyGraphCatalogConfig } = await fresh();
    expect(() => applyGraphCatalogConfig({ maxBytes })).toThrow(
      /^store\.graphCatalog\.maxBytes must be a positive whole number of bytes, not .+\. Remove it to keep the default of 268435456 bytes\.$/,
    );
    expect(storage.storeGraphCatalogMaxBytes()).toBe(storage.DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES);
  });

  // An array is an object to JavaScript, not to the config.
  it.each([[512], ['512 MiB'], [[512]], [null]])('refuses a section that is not an object (%j)', async (section) => {
    vi.stubEnv(ENV, '');
    const { applyGraphCatalogConfig } = await fresh();
    expect(() => applyGraphCatalogConfig(section)).toThrow(/^store\.graphCatalog must be an object/);
  });

  it.each(['lots', '0', '-5', '1.5'])('refuses %j in the environment variable, naming it', async (value) => {
    vi.stubEnv(ENV, value);
    const { applyGraphCatalogConfig } = await fresh();
    expect(() => applyGraphCatalogConfig({ maxBytes: 536_870_912 })).toThrow(
      new RegExp(`^${ENV} must be a positive whole number of bytes, not "${value.replace('.', '\\.')}"\\.`),
    );
  });

  it('reaches the catalog of the store the daemon builds', async () => {
    vi.stubEnv(ENV, '');
    const { storage, applyGraphCatalogConfig, buildAgentRuntimeStoreConfig } = await fresh();
    const graphCatalog = applyGraphCatalogConfig({ maxBytes: 200 });
    const config = buildAgentRuntimeStoreConfig({
      runtimeStore: { backend: 'oxigraph' }, managedStore: undefined,
      changelogEnabled: false, changelogEraGuard: undefined, graphCatalog,
    });
    expect(config?.graphCatalog).toEqual({ maxBytes: 200 });
    const store = await storage.createTripleStore(config!);
    try {
      await store.insert(Array.from({ length: 10 }, (_, i) => ({
        subject: 'urn:s', predicate: 'urn:p', object: `"${i}"`, graph: `did:dkg:context-graph:catalog-config/${i}`,
      })));
      await expect(store.listGraphs()).rejects.toMatchObject({
        code: 'STORE_INTERNAL_LIMIT', limitName: 'STORE_GRAPH_CATALOG_MAX_BYTES', limitBytes: 200,
      });
    } finally { await store.close(); }
  });

  it('rides on the managed Oxigraph runtime config', async () => {
    vi.stubEnv(ENV, '');
    const { storage, applyGraphCatalogConfig, buildAgentRuntimeStoreConfig } = await fresh();
    const managedStore = storage.createManagedOxigraphRuntimeStoreConfigV1({
      backend: 'sparql-http',
      options: { queryEndpoint: 'http://127.0.0.1:7878/query', updateEndpoint: 'http://127.0.0.1:7878/update', managedByDkg: true },
    }, { getRecoveryState: () => ({ recovering: false, generation: 0 }) });
    const config = buildAgentRuntimeStoreConfig({
      runtimeStore: managedStore, managedStore, changelogEnabled: false, changelogEraGuard: undefined,
      graphCatalog: applyGraphCatalogConfig({ maxBytes: 4096 }),
    });
    expect(config?.graphCatalog).toEqual({ maxBytes: 4096 });
    // Still a managed runtime config: a further update needs its control plane, and keeps the value.
    expect(storage.withManagedOxigraphRuntimeStoreConfigV1(config as never, {}).graphCatalog).toEqual({ maxBytes: 4096 });
    // The store built from it keeps the value: another one would be refused in this process.
    const store = await storage.createTripleStore(config!);
    try {
      expect(storage.storeGraphCatalogMaxBytes()).toBe(4096);
      expect(() => storage.configureStoreGraphCatalogMaxBytes(8192)).toThrow(/is 4096 in this process already/);
    } finally { await store.close(); }
  });

  it.each([
    ['a configured store', { backend: 'oxigraph', graphCatalog: { maxBytes: 4096 } }],
    ['the default store, from a section that holds only settings', { graphCatalog: { maxBytes: 4096 } }],
  ])('reaches the standalone publisher through %s', async (_name, store) => {
    vi.stubEnv(ENV, '');
    const { storage } = await fresh();
    const { createPublisherInspector } = await import('../src/publisher-runner.js');
    const dataDir = await mkdtemp(join(tmpdir(), 'graph-catalog-config-'));
    try {
      const inspector = await createPublisherInspector({ dataDir, config: { store } as unknown as DkgConfig });
      try {
        expect(storage.storeGraphCatalogMaxBytes()).toBe(4096);
      } finally { await inspector.stop(); }
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  });

  it('refuses a bad value before the standalone publisher opens its store', async () => {
    vi.stubEnv(ENV, '');
    await fresh();
    const { createPublisherInspector } = await import('../src/publisher-runner.js');
    await expect(createPublisherInspector({
      dataDir: '/nonexistent-graph-catalog-config', config: { store: { backend: 'oxigraph', graphCatalog: { maxBytes: -1 } } } as unknown as DkgConfig,
    })).rejects.toThrow(/^store\.graphCatalog\.maxBytes must be a positive whole number of bytes, not -1\./);
  });
});
