import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore, StoreResponseTooLargeError, type StorePressureSnapshot, type TripleStore } from '@origintrail-official/dkg-storage';
import { exactGraphSnapshotBatchWidth, readExactGraphSnapshotBatch } from '../src/sync/responder/exact-graph-snapshot-batch.js';
import { readExactGraphPlanSnapshot, type ExactGraphPagePlan } from '../src/sync/responder/exact-graph-reader.js';
import { compareRows } from '../src/sync/responder/row-serialization.js';
import type { RowListCache } from '../src/sync/responder/responder-row-page.js';

const limits = { maxRows: 10_000, maxBytesEstimate: 4 * 1024 * 1024 };
const cache = { key: 'snapshot-batch-test' } as RowListCache;
const idle: StorePressureSnapshot = {
  ackInflight: 0, normalInflight: 0, backgroundInflight: 0,
  ackQueued: 0, normalQueued: 0, backgroundQueued: 0, maxConcurrent: 4, ackReservedSlots: 1,
};
function plan(counts: number[]): ExactGraphPagePlan {
  const entries = counts.map((rowCount, i) => ({ graph: `urn:graph:${String(i).padStart(4, '0')}`, rowCount }));
  return { entries, totalRows: counts.reduce((a, b) => a + b, 0), pagedGraphs: new Set(), cursors: new Map([[0, null]]) };
}
async function seed(store: TripleStore, snapshot: ExactGraphPagePlan) {
  const quads = snapshot.entries.flatMap(({ graph, rowCount }) => Array.from({ length: rowCount }, (_, i) => ({
    graph, subject: `urn:subject:${i}`, predicate: 'urn:predicate', object: `"value-${i}"`,
  })));
  await store.insert(quads);
  return quads.map(q => ({ g: q.graph, s: q.subject, p: q.predicate, o: q.object })).sort(compareRows);
}

describe('bounded exact graph snapshot batches', () => {
  it.each([
    [undefined, 4], [idle, 2], [{ ...idle, normalInflight: 1 }, 13],
    [{ ...idle, backgroundQueued: 1 }, 4], [{ ...idle, ackQueued: 1 }, 13],
  ] as const)('keeps complete sorted snapshots under pressure %j', async (pressure, expectedQueries) => {
    const store: TripleStore = new OxigraphStore();
    if (pressure) store.getPressureSnapshot = () => pressure;
    try {
      const snapshot = plan(Array(100).fill(3));
      const expected = await seed(store, snapshot);
      await store.insert([{ graph: 'urn:private:unadmitted', subject: 'urn:secret', predicate: 'urn:p', object: '"secret"' }]);
      const query = vi.spyOn(store, 'query');
      expect(await readExactGraphPlanSnapshot(store, snapshot, cache, limits)).toEqual(expected);
      expect(query).toHaveBeenCalledTimes(expectedQueries as number);
      for (const [sparql, options] of query.mock.calls) {
        expect(sparql).not.toMatch(/ORDER BY|OFFSET/);
        expect(sparql).toMatch(/LIMIT \d+/);
        expect(options).toMatchObject({ priority: 'background' });
        expect(options!.maxResponseBytes).toBeLessThanOrEqual(limits.maxBytesEstimate * 2);
      }
    } finally { await store.close(); }
  });

  it('rechecks pressure between requests and does not repeat or skip graphs when shrinking', async () => {
    const store: TripleStore = new OxigraphStore();
    try {
      let pressure = idle;
      store.getPressureSnapshot = () => pressure;
      const snapshot = plan(Array(80).fill(2));
      const expected = await seed(store, snapshot);
      const original = store.query.bind(store);
      const query = vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
        const result = await original(sparql, options);
        pressure = { ...idle, healthQueued: 1 };
        return result;
      });
      expect(await readExactGraphPlanSnapshot(store, snapshot, cache, limits)).toEqual(expected);
      expect(query.mock.calls.map(([text]) => (text.match(/<urn:graph:/g) ?? []).length)).toEqual([64, 8, 8]);
    } finally { await store.close(); }
  });

  it('bounds planned rows and keeps large or already-paged graphs on the existing path', () => {
    const store = { getPressureSnapshot: () => idle } as TripleStore;
    const entries = plan([1000, 1000, 1000]).entries;
    expect(exactGraphSnapshotBatchWidth(store, entries, 0, 10_000, new Set())).toBe(2);
    expect(exactGraphSnapshotBatchWidth(store, entries, 0, 1500, new Set())).toBe(1);
    expect(exactGraphSnapshotBatchWidth(store, entries, 0, 10_000, new Set([entries[1]!.graph]))).toBe(1);
    expect(exactGraphSnapshotBatchWidth(store, plan([3000, 1]).entries, 0, 10_000, new Set())).toBe(1);
  });

  it('combines batches and large single graphs without changing the snapshot', async () => {
    const store: TripleStore = new OxigraphStore();
    try {
      const snapshot = plan([2, 2, 2049, 2, 2]);
      const expected = await seed(store, snapshot);
      const query = vi.spyOn(store, 'query');
      expect(await readExactGraphPlanSnapshot(store, snapshot, cache, limits)).toEqual(expected);
      expect(query.mock.calls.map(([, options]) => options?.source)).toEqual([
        'sync.responder.readExactGraphSnapshotBatch', 'sync.responder.readExactGraphSnapshot',
        'sync.responder.readExactGraphSnapshotBatch',
      ]);
    } finally { await store.close(); }
  });

  it('keeps code-point order across shuffled graph plans, rows and batch boundaries', async () => {
    const store: TripleStore = new OxigraphStore();
    try {
      const snapshot = plan([...Array(70).fill(2), 2049, 2]);
      snapshot.entries[0]!.graph = 'urn:graph:\uFF01';
      snapshot.entries[1]!.graph = 'urn:graph:\u{1F600}';
      const expected = await seed(store, snapshot);
      snapshot.entries.reverse();
      const original = store.query.bind(store);
      vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
        const result = await original(sparql, options);
        return result.type === 'bindings'
          ? { ...result, bindings: [...result.bindings].reverse() } : result;
      });
      const originalOrder = snapshot.entries.map(entry => entry.graph);
      expect(await readExactGraphPlanSnapshot(store, snapshot, cache, limits)).toEqual(expected);
      expect(snapshot.entries.map(entry => entry.graph)).toEqual(originalOrder);
    } finally { await store.close(); }
  });

  it('lets queued event-loop work run before a bulk snapshot finishes', async () => {
    const store: TripleStore = new OxigraphStore();
    try {
      const snapshot = plan(Array(32).fill(20));
      const expected = await seed(store, snapshot);
      let settled = false;
      const pending = readExactGraphPlanSnapshot(store, snapshot, cache, limits)
        .then(rows => { settled = true; return rows; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(await pending).toEqual(expected);
    } finally { await store.close(); }
  });

  it.each([[[2, 4]], [[2, 3]], [[4, 3]]])('rejects per-graph count drift even when totals compensate (%j)', async (counts) => {
    const store: TripleStore = new OxigraphStore();
    try {
      await seed(store, plan(counts));
      await expect(readExactGraphPlanSnapshot(store, plan([3, 3]), cache, limits)).rejects.toThrow('plan changed');
    } finally { await store.close(); }
  });

  it('preserves snapshot byte-budget errors and transport failures', async () => {
    const store: TripleStore = new OxigraphStore();
    try {
      const snapshot = plan([1, 1]);
      await seed(store, snapshot);
      await expect(readExactGraphPlanSnapshot(store, snapshot, cache, { ...limits, maxBytesEstimate: 1 }))
        .rejects.toMatchObject({ name: 'SyncRowSnapshotBudgetError', reason: 'snapshot_bytes' });
      const query = vi.spyOn(store, 'query');
      query.mockRejectedValue(new StoreResponseTooLargeError(1, 2));
      await expect(readExactGraphPlanSnapshot(store, snapshot, cache, limits))
        .rejects.toMatchObject({ name: 'SyncRowSnapshotBudgetError', reason: 'snapshot_bytes' });
      const failure = new Error('backend disconnected');
      query.mockRejectedValue(failure);
      await expect(readExactGraphPlanSnapshot(store, snapshot, cache, limits)).rejects.toBe(failure);
    } finally { await store.close(); }
  });

  it.each([
    { type: 'boolean', value: false },
    { type: 'bindings', bindings: [{ g: 'urn:unadmitted', s: 'urn:s', p: 'urn:p', o: '"v"' }] },
    { type: 'bindings', bindings: [{ g: 'urn:graph:0000', s: 'urn:s', o: '"v"' }] },
  ])('rejects malformed or unadmitted store responses', async (result) => {
    const store = { query: vi.fn().mockResolvedValue(result) } as unknown as TripleStore;
    await expect(readExactGraphSnapshotBatch(store, plan([1, 1]).entries, 1024)).rejects.toThrow();
  });

  it('rejects oversized, duplicate or invalid batches before dispatch', async () => {
    const store = { query: vi.fn() } as unknown as TripleStore;
    for (const entries of [[], plan(Array(65).fill(1)).entries, plan([2049]).entries,
      plan([0, 1]).entries, [plan([1]).entries[0]!, plan([1]).entries[0]!]]) {
      await expect(readExactGraphSnapshotBatch(store, entries, 1024)).rejects.toThrow('Invalid bounded');
    }
    expect(store.query).not.toHaveBeenCalled();
  });
});
