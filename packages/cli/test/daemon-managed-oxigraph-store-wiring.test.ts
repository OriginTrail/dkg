import { describe, expect, it } from 'vitest';

import {
  SyncSemanticStoreV1,
  SyncSharedProjectionStoreV1,
  asChangelogReader,
  createManagedOxigraphRuntimeStoreConfigV1,
  createTripleStore,
  readGraphLayerOf,
  type ChangelogEraGuard,
  type ReadGraphStoreConfig,
} from '@origintrail-official/dkg-storage';

import { buildAgentRuntimeStoreConfig } from '../src/daemon/agent-runtime-store-config.js';
import { readGraphStoreSettings, resolveQueryConfig } from '../src/read-graphs-config.js';

describe('daemon managed Oxigraph store construction', () => {
  it('retains managed RFC-64 authority through the final changelog-wrapped agent config', async () => {
    const activity: boolean[] = [];
    let recoveryReads = 0;
    const managedStore = createManagedOxigraphRuntimeStoreConfigV1({
      backend: 'sparql-http',
      options: {
        queryEndpoint: 'http://127.0.0.1:7878/query',
        updateEndpoint: 'http://127.0.0.1:7878/update',
        managedByDkg: true,
      },
      graphSetIndex: true,
    }, {
      getRecoveryState: () => {
        recoveryReads += 1;
        return { recovering: false, generation: 0 };
      },
      registerActivity: () => ({ report: (activeOperations) => { activity.push(activeOperations); }, dispose() {} }),
    });
    const eraGuard: ChangelogEraGuard = {
      async load() { return null; },
      async save() {},
    };
    const finalConfig = buildAgentRuntimeStoreConfig({
      runtimeStore: managedStore,
      managedStore,
      changelogEnabled: true,
      changelogEraGuard: eraGuard,
    });
    expect(finalConfig).toBeDefined();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      head: {},
      boolean: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    });
    try {
      const store = await createTripleStore(finalConfig!);
      try {
        expect(() => new SyncSharedProjectionStoreV1(store)).not.toThrow();
        expect(() => new SyncSemanticStoreV1(store)).not.toThrow();
        expect(asChangelogReader(store)).not.toBeNull();
        await expect(store.query('ASK { ?s ?p ?o }')).resolves.toMatchObject({
          type: 'boolean',
          value: true,
        });
        expect(recoveryReads).toBeGreaterThan(0);
        expect(activity).toEqual([true, false]);
      } finally {
        await store.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not let a spread copy grant managed RFC-64 authority', async () => {
    const managedStore = createManagedOxigraphRuntimeStoreConfigV1({
      backend: 'sparql-http',
      options: {
        queryEndpoint: 'http://127.0.0.1:7878/query',
        managedByDkg: true,
      },
    });
    const copied = await createTripleStore({ ...managedStore });
    try {
      expect(() => new SyncSharedProjectionStoreV1(copied)).toThrow(
        'triple store has no certified RFC-64 shared-projection stream capability',
      );
    } finally {
      await copied.close();
    }
  });

  it('carries the read-graph settings to every store object over the backend, managed or not', async () => {
    // Modes that keep none: no adapter in this test declares read-graph capabilities.
    const readGraphs: ReadGraphStoreConfig = { modes: { default: 'off' }, viewSemantics: { default: 'merged' } };
    const endpoint = `http://127.0.0.1:7878/${Math.random().toString(36).slice(2)}`;
    const managedStore = createManagedOxigraphRuntimeStoreConfigV1({
      backend: 'sparql-http',
      options: { queryEndpoint: `${endpoint}/query`, updateEndpoint: `${endpoint}/update`, managedByDkg: true },
    }, { getRecoveryState: () => ({ recovering: false, generation: 0 }) });
    const managed = buildAgentRuntimeStoreConfig({
      runtimeStore: managedStore, managedStore, changelogEnabled: false, changelogEraGuard: undefined, readGraphs,
    });
    expect(managed?.readGraphs).toBe(readGraphs);
    const plain = buildAgentRuntimeStoreConfig({
      runtimeStore: { backend: 'sparql-http', options: { queryEndpoint: `${endpoint}-plain/query` } },
      managedStore: undefined, changelogEnabled: false, changelogEraGuard: undefined, readGraphs,
    });
    expect(plain?.readGraphs).toBe(readGraphs);

    const store = await createTripleStore(managed!);
    try {
      expect(readGraphLayerOf(store)?.runtime.modes).toBe(readGraphs.modes);
      expect(readGraphLayerOf(store)?.runtime.viewSemantics).toBe(readGraphs.viewSemantics);
    } finally {
      await store.close();
    }
  });

  it('gives the default embedded store the settings of a written query section, and nothing else changes without one', () => {
    const readGraphs: ReadGraphStoreConfig = { modes: { default: 'build' } };
    const base = { runtimeStore: undefined, managedStore: undefined, changelogEnabled: false, changelogEraGuard: undefined };
    expect(buildAgentRuntimeStoreConfig({ ...base, readGraphs, dataDir: '/tmp/dkg-home' })).toEqual({
      backend: 'oxigraph-worker',
      options: { path: '/tmp/dkg-home/store.nq' },
      readGraphs,
    });
    expect(buildAgentRuntimeStoreConfig({ ...base, dataDir: '/tmp/dkg-home' })).toBeUndefined();
    // A query section that keeps no read graph, an empty one included, leaves the default store as it was: a node
    // that starts from a public checkpoint, which refuses any store configuration, still starts.
    for (const query of [{}, { readGraphs: 'off', viewSemantics: 'merged' }]) {
      const settings = readGraphStoreSettings(resolveQueryConfig(query));
      expect(buildAgentRuntimeStoreConfig({ ...base, readGraphs: settings, dataDir: '/tmp/dkg-home' }), JSON.stringify(query)).toBeUndefined();
    }
  });
});
