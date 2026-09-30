import { describe, it, expect, vi } from 'vitest';
import {
  createTripleStore,
  loadSelectedSharedMemoryQuads,
  SharedMemoryResultBudgetError,
  SharedMemoryReadConsistencyError,
} from '../src/index.js';
import { contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import { AUTHOR_A_MIXED, key, keys, seedGraphs } from './graph-manager-swm-fixtures.js';

describe('bounded SWM result materialization', () => {
  it('reads a large graph family in bounded queries without losing a recurring root', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-root-recurrence');
    const root = 'urn:chunked:root';
    const child = `${root}/.well-known/genid/child`;
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    try {
      await seedGraphs(store, graphs);
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"same"', graph: graphs[0]! },
        { subject: root, predicate: 'urn:p', object: '"same"', graph: graphs[129]! },
        { subject: child, predicate: 'urn:p', object: '"child"', graph: graphs[129]! },
      ]);
      const query = store.query.bind(store);
      const spy = vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
        if (sparql.includes('VALUES ?g')) {
          const values = sparql.match(/VALUES \?g \{([^}]*)\}/)?.[1] ?? '';
          expect((values.match(/<[^>]+>/g) ?? []).length).toBeLessThanOrEqual(128);
        }
        return query(sparql, options);
      });

      const paged = await loadSelectedSharedMemoryQuads(
        store, swm, { rootEntities: [root] },
        { resultBudget: { pageRows: 1, maxRows: 2, maxBytesEstimate: 1024 * 1024 } },
      );
      const constructed = await loadSelectedSharedMemoryQuads(store, swm, { rootEntities: [root] });

      expect(keys(paged)).toEqual(keys(constructed));
      expect(keys(paged)).toEqual([
        `${child}|urn:p|"child"`,
        `${root}|urn:p|"same"`,
      ].sort());
      expect(spy.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g')).length).toBeGreaterThan(2);
      const graphQueries = spy.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g'));
      expect(graphQueries.some(([sparql]) => sparql.includes(`<${graphs[0]}>`) && !sparql.includes(`<${graphs[129]}>`))).toBe(true);
      expect(graphQueries.some(([sparql]) => sparql.includes(`<${graphs[129]}>`) && !sparql.includes(`<${graphs[0]}>`))).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('enforces row and byte budgets across separate graph chunks', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-cumulative-budget');
    const root = 'urn:chunked:budget-root';
    const graphs = Array.from({ length: 130 }, (_, i) =>
      `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    const first = { subject: root, predicate: 'urn:p:first', object: '"first"', graph: graphs[0]! };
    const second = { subject: root, predicate: 'urn:p:second', object: '"second"', graph: graphs[129]! };
    try {
      await seedGraphs(store, graphs);
      await store.insert([first, second]);
      await expect(loadSelectedSharedMemoryQuads(store, swm, { rootEntities: [root] }, {
        resultBudget: { pageRows: 1, maxRows: 1, maxBytesEstimate: 1024 * 1024 },
      })).rejects.toMatchObject({ reason: 'rows', rows: 2 });
      const keyBytes = 64 + 2 * JSON.stringify([first.subject, first.predicate, first.object]).length;
      const quadBytes = 96 + 2 * (first.subject.length + first.predicate.length + first.object.length);
      await expect(loadSelectedSharedMemoryQuads(store, swm, { rootEntities: [root] }, {
        resultBudget: { pageRows: 1, maxRows: 3, maxBytesEstimate: keyBytes + quadBytes + 1 },
      })).rejects.toMatchObject({ reason: 'bytes', rows: 2 });
    } finally {
      await store.close();
    }
  });

  it('retries a multi-chunk read when an all-writer revision changes between queries', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-revision-fence');
    const root = 'urn:chunked:revision-root';
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    const added = { subject: root, predicate: 'urn:p:new', object: '"new"', graph: graphs[0]! };
    try {
      await seedGraphs(store, graphs);
      await store.insert([{ subject: root, predicate: 'urn:p:old', object: '"old"', graph: graphs[0]! }]);
      const query = store.query.bind(store);
      let injected = false;
      vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
        const result = await query(sparql, options);
        if (!injected && sparql.includes('VALUES ?g')) {
          injected = true;
          await store.insert([added]);
        }
        return result;
      });
      const selected = await loadSelectedSharedMemoryQuads(store, swm, { rootEntities: [root] });
      expect(injected).toBe(true);
      expect(keys(selected)).toContain(key(added));
    } finally {
      await store.close();
    }
  });

  it('keeps an unsupported backend on one snapshot-consistent query', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-no-snapshot-capability');
    const root = 'urn:chunked:fallback-root';
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    try {
      await seedGraphs(store, graphs);
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"same"', graph: graphs[0]! },
        { subject: root, predicate: 'urn:p', object: '"same"', graph: graphs[129]! },
      ]);
      // Deliberately expose only ordinary read operations, as with a backend
      // lacking both snapshot and all-writer revision capabilities.
      const query = vi.fn(store.query.bind(store));
      const plain = {
        query,
        listGraphs: store.listGraphs.bind(store),
      } as unknown as Parameters<typeof loadSelectedSharedMemoryQuads>[0];
      const selected = await loadSelectedSharedMemoryQuads(plain, swm, { rootEntities: [root] });
      expect(keys(selected)).toEqual([`${root}|urn:p|"same"`]);
      expect(query.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g')))
        .toHaveLength(1);
      query.mockClear();
      const budgeted = await loadSelectedSharedMemoryQuads(plain, swm, { rootEntities: [root] }, {
        resultBudget: { pageRows: 1, maxRows: 1, maxBytesEstimate: 1024 * 1024 },
      });
      expect(keys(budgeted)).toEqual(keys(selected));
      const budgetRequests = query.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g'));
      expect(budgetRequests).toHaveLength(1);
      expect(budgetRequests[0]?.[1]?.maxResponseBytes).toBe(5 * 1024 * 1024);
      query.mockClear();
      await loadSelectedSharedMemoryQuads(plain, swm, { rootEntities: [root] }, {
        queryOptions: { maxResponseBytes: 1_024 },
        resultBudget: { pageRows: 1, maxRows: 1, maxBytesEstimate: 1024 * 1024 },
      });
      const stricter = query.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g'));
      expect(stricter).toHaveLength(1);
      expect(stricter[0]?.[1]?.maxResponseBytes).toBe(1_024);
    } finally {
      await store.close();
    }
  });

  it('fails retryably after a write revision changes on every multi-chunk attempt', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-unstable-revision');
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    try {
      await seedGraphs(store, graphs);
      let generation = 0;
      const unstable = {
        query: store.query.bind(store),
        listGraphs: store.listGraphs.bind(store),
        writeRevisionCoverage: 'all-writers',
        getWriteRevision: () => ({ generation: ++generation, stable: true }),
      } as unknown as Parameters<typeof loadSelectedSharedMemoryQuads>[0];
      await expect(loadSelectedSharedMemoryQuads(unstable, swm, 'all'))
        .rejects.toBeInstanceOf(SharedMemoryReadConsistencyError);
    } finally {
      await store.close();
    }
  });

  it('waits for an in-flight writer before reading a large multi-chunk family', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-transient-write');
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    try {
      await seedGraphs(store, graphs);
      let stable = false;
      let scheduled = false;
      const query = vi.fn(store.query.bind(store));
      const fenced = {
        query,
        listGraphs: store.listGraphs.bind(store),
        writeRevisionCoverage: 'all-writers',
        getWriteRevision: () => {
          if (!scheduled) {
            scheduled = true;
            setImmediate(() => { stable = true; });
          }
          return { generation: 1, stable };
        },
      } as unknown as Parameters<typeof loadSelectedSharedMemoryQuads>[0];
      const selected = await loadSelectedSharedMemoryQuads(fenced, swm, 'all');
      expect(selected).toHaveLength(130);
      expect(query.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g')).length)
        .toBeGreaterThan(1);
    } finally {
      await store.close();
    }
  });

  it('honors cancellation while waiting for an in-flight writer', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-aborted-write');
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    try {
      await seedGraphs(store, graphs);
      const controller = new AbortController();
      let scheduled = false;
      const fenced = {
        query: store.query.bind(store),
        listGraphs: store.listGraphs.bind(store),
        writeRevisionCoverage: 'all-writers',
        getWriteRevision: () => {
          if (!scheduled) {
            scheduled = true;
            setImmediate(() => controller.abort(new Error('read cancelled')));
          }
          return { generation: 1, stable: false };
        },
      } as unknown as Parameters<typeof loadSelectedSharedMemoryQuads>[0];
      await expect(loadSelectedSharedMemoryQuads(fenced, swm, 'all', {
        queryOptions: { signal: controller.signal },
      })).rejects.toThrow('read cancelled');
    } finally {
      await store.close();
    }
  });

  it('counts dedupe identities retained for filtered rows in the byte budget', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('result-filter-dedupe-budget');
    try {
      await store.insert(Array.from({ length: 5 }, (_, i) => ({
        subject: `urn:filtered:${i}`, predicate: 'urn:p', object: '"x"', graph: swm,
      })));
      await expect(loadSelectedSharedMemoryQuads(store, swm, 'all', {
        quadFilter: () => false,
        resultBudget: { pageRows: 10, maxRows: 100, maxBytesEstimate: 200 },
      })).rejects.toMatchObject({ name: 'SharedMemoryResultBudgetError', reason: 'bytes' });
    } finally {
      await store.close();
    }
  });

  it('rejects before retaining a result beyond the configured row budget', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('result-budget');
    const root = 'urn:budget:root';
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p:1', object: '"one"', graph: swm },
        { subject: root, predicate: 'urn:p:2', object: '"two"', graph: swm },
      ]);

      await expect(loadSelectedSharedMemoryQuads(
        store,
        swm,
        { rootEntities: [root] },
        { resultBudget: { pageRows: 1, maxRows: 1, maxBytesEstimate: 1024 * 1024 } },
      )).rejects.toBeInstanceOf(SharedMemoryResultBudgetError);
    } finally {
      await store.close();
    }
  });

  it('rejects a large retained result by bytes even while below the row budget', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('result-byte-budget');
    const root = 'urn:budget:large-root';
    try {
      await store.insert([{
        subject: root,
        predicate: 'urn:p:large',
        object: `"${'x'.repeat(2_048)}"`,
        graph: swm,
      }]);

      await expect(loadSelectedSharedMemoryQuads(
        store,
        swm,
        { rootEntities: [root] },
        { resultBudget: { pageRows: 10, maxRows: 100, maxBytesEstimate: 128 } },
      )).rejects.toMatchObject({
        name: 'SharedMemoryResultBudgetError',
        reason: 'bytes',
        limit: 128,
      });
    } finally {
      await store.close();
    }
  });
});
