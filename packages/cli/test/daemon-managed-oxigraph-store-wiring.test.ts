import { describe, expect, it } from 'vitest';

import {
  SyncSemanticStoreV1,
  SyncSharedProjectionStoreV1,
  asChangelogReader,
  createManagedOxigraphRuntimeStoreConfigV1,
  createTripleStore,
  type ChangelogEraGuard,
} from '@origintrail-official/dkg-storage';

import { buildAgentRuntimeStoreConfig } from '../src/daemon/agent-runtime-store-config.js';

describe('daemon managed Oxigraph store construction', () => {
  it('retains managed RFC-64 authority through the final changelog-wrapped agent config', async () => {
    const activity: number[] = [];
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
      onActivityChange: (activeOperations) => { activity.push(activeOperations); },
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
        expect(activity).toEqual([1, 0]);
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
});
