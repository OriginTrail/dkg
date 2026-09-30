import { describe, expect, it } from 'vitest';
import {
  asReadSnapshotCapability,
  createTripleStore,
  loadSelectedSharedMemoryQuads,
  type ReadSnapshotCapability,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';

describe('read snapshot through the agent store wrapper', () => {
  it('preserves the production Blazegraph decorator chain capability', async () => {
    const inner = await createTripleStore({
      backend: 'blazegraph',
      options: {
        url: 'http://127.0.0.1:9999/bigdata/namespace/dkg/sparql',
        managedByDkg: true,
      },
    });
    const store = createListContextGraphsCacheInvalidatingStore(inner, () => undefined);
    expect(asReadSnapshotCapability(inner)).not.toBeNull();
    expect(asReadSnapshotCapability(store)).not.toBeNull();
    await inner.close();
  });

  it('keeps a budgeted SWM read pinned and split into bounded graph queries', async () => {
    const inner = await createTripleStore({ backend: 'oxigraph' });
    const queries: string[] = [];
    let snapshotCalls = 0;
    const instrumented = new Proxy(inner, {
      get(target, property) {
        if (property === 'innerStore') return undefined;
        if (property === 'withReadSnapshot') {
          const withReadSnapshot: ReadSnapshotCapability['withReadSnapshot'] = async (read, signal) => {
            snapshotCalls++;
            signal?.throwIfAborted();
            return read({
              query: (sparql, options) => {
                queries.push(sparql);
                return inner.query(sparql, options);
              },
              listGraphs: (options) => inner.listGraphs(options),
              listGraphsByPrefix: (prefix, options) => inner.listGraphsByPrefix!(prefix, options),
            });
          };
          return withReadSnapshot;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      has(target, property) {
        if (property === 'innerStore') return false;
        if (property === 'withReadSnapshot') return true;
        return Reflect.has(target, property);
      },
    });
    const store = createListContextGraphsCacheInvalidatingStore(
      instrumented, () => undefined,
    );
    const bucket = 'urn:dkg:test:shared-memory';
    const root = 'urn:dkg:test:root';
    try {
      expect(asReadSnapshotCapability(store)).not.toBeNull();
      await store.insert(Array.from({ length: 33 }, (_, i) => ({
        graph: `${bucket}/author/${i}`,
        subject: root,
        predicate: `urn:dkg:test:predicate:${i}`,
        object: '"value"',
      })));
      const quads = await loadSelectedSharedMemoryQuads(
        store, bucket, { rootEntities: [root] }, {
          resultBudget: { pageRows: 100, maxRows: 1000, maxBytesEstimate: 1_000_000 },
        },
      );
      expect(quads).toHaveLength(33);
      expect(snapshotCalls).toBe(1);
      const reads = queries.filter((query) => query.includes('VALUES ?g {'));
      expect(reads.length).toBe(3);
      for (const query of reads) {
        expect((query.match(/<urn:dkg:test:shared-memory(?:\/[^>]+)?>/g) ?? []).length).toBeLessThanOrEqual(16);
      }
    } finally {
      await inner.close();
    }
  });

  it('does not advertise snapshots when the inner store lacks them', async () => {
    const inner = await createTripleStore({ backend: 'oxigraph' });
    try {
      const opaque = new Proxy(inner, {
        get(target, property) {
          if (property === 'withReadSnapshot' || property === 'innerStore') return undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        has(target, property) {
          if (property === 'withReadSnapshot' || property === 'innerStore') return false;
          return Reflect.has(target, property);
        },
      }) as TripleStore;
      const store = createListContextGraphsCacheInvalidatingStore(opaque, () => undefined);
      expect(asReadSnapshotCapability(store)).toBeNull();
      expect('withReadSnapshot' in store).toBe(false);
    } finally {
      await inner.close();
    }
  });
});
