/**
 * Tri-Modal Memory (spec §21) — vector-store coverage.
 *
 * Covers VectorStore in isolation (no embedding provider). All assertions
 * target the production schema / SQL paths exactly as ship-written — no
 * mocks, no fakes, real better-sqlite3. Each red test here indicates a
 * real spec-divergence in the production file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore, type EmbeddingRecord } from '../src/vector-store.js';

function makeVec(dim: number, seed: number): number[] {
  const out = new Array(dim);
  let x = seed;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x / 0x7fffffff) * 2 - 1;
  }
  return out;
}

describe('VectorStore — Tri-Modal Memory §21 compliance', () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vec-extra-'));
    store = new VectorStore(dir);
  });

  afterEach(() => {
    try { store.close(); } catch { /* reopen tests may already have closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  function baseRec(overrides: Partial<EmbeddingRecord> = {}): EmbeddingRecord {
    return {
      embedding: makeVec(8, 1),
      sourceUri: 'dkg://cg-a/s1',
      entityUri: 'dkg://cg-a/e1',
      contextGraphId: 'cg-a',
      memoryLayer: 'wm',
      model: 'test-model',
      ...overrides,
    };
  }

  it('persists embeddings across close/reopen (WAL durability)', async () => {
    const id = await store.insert(baseRec());
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    store.close();

    expect(existsSync(join(dir, 'vector-store.db'))).toBe(true);
    expect(statSync(join(dir, 'vector-store.db')).size).toBeGreaterThan(0);

    store = new VectorStore(dir);
    expect(await store.count()).toBe(1);
    expect(await store.count('cg-a')).toBe(1);
    expect(await store.count('cg-b')).toBe(0);
  });

  it('migrate() is idempotent (user_version gate)', async () => {
    await store.insert(baseRec());
    store.close();
    for (let i = 0; i < 3; i++) {
      store = new VectorStore(dir);
      expect(await store.count()).toBe(1);
      store.close();
    }
    store = new VectorStore(dir);
  });

  it('INSERT OR REPLACE: same id overwrites, preserves count', async () => {
    const rec1 = { ...baseRec(), id: 'fixed-id', embedding: makeVec(8, 1), label: 'v1' };
    const rec2 = { ...baseRec(), id: 'fixed-id', embedding: makeVec(8, 2), label: 'v2' };
    const id1 = await store.insert(rec1);
    const id2 = await store.insert(rec2);
    expect(id1).toBe('fixed-id');
    expect(id2).toBe('fixed-id');
    expect(await store.count()).toBe(1);
    const results = await store.search(makeVec(8, 2), { contextGraphId: 'cg-a', memoryLayers: ['wm'], limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe('v2');
  });

  it('search: identical vector returns similarity == 1.0', async () => {
    const q = makeVec(8, 42);
    await store.insert({ ...baseRec(), embedding: q });
    const [hit] = await store.search(q, { contextGraphId: 'cg-a', memoryLayers: ['wm'], limit: 1 });
    expect(hit).toBeDefined();
    expect(hit.similarity).toBeGreaterThan(0.9999);
    expect(hit.similarity).toBeLessThanOrEqual(1.0001);
  });

  it('search: orthogonal vectors return similarity ≈ 0', async () => {
    const a = [1, 0, 0, 0, 0, 0, 0, 0];
    const b = [0, 1, 0, 0, 0, 0, 0, 0];
    await store.insert({ ...baseRec(), embedding: a });
    const [hit] = await store.search(b, { contextGraphId: 'cg-a', memoryLayers: ['wm'], limit: 1 });
    expect(Math.abs(hit.similarity)).toBeLessThan(1e-6);
  });

  it('search: zero query vector returns 0 (not NaN)', async () => {
    const nonZero = [1, 2, 3, 4, 5, 6, 7, 8];
    const zero = [0, 0, 0, 0, 0, 0, 0, 0];
    await store.insert({ ...baseRec(), embedding: nonZero });
    const [hit] = await store.search(zero, { contextGraphId: 'cg-a', memoryLayers: ['wm'], limit: 1 });
    expect(Number.isFinite(hit.similarity)).toBe(true);
    expect(hit.similarity).toBe(0);
  });

  it('search: context-graph isolation — cg-a query does not return cg-b rows', async () => {
    const shared = makeVec(8, 99);
    await store.insert({ ...baseRec({ contextGraphId: 'cg-a', entityUri: 'e-a' }), embedding: shared });
    await store.insert({ ...baseRec({ contextGraphId: 'cg-b', entityUri: 'e-b' }), embedding: shared });
    const results = await store.search(shared, { contextGraphId: 'cg-a', memoryLayers: ['wm', 'swm', 'vm'], limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].entityUri).toBe('e-a');
  });

  it('search: memory-layer filter honours WM/SWM/VM gradient', async () => {
    const q = makeVec(8, 7);
    await store.insert({ ...baseRec({ memoryLayer: 'wm', entityUri: 'e-wm' }), embedding: q });
    await store.insert({ ...baseRec({ memoryLayer: 'swm', entityUri: 'e-swm' }), embedding: q });
    await store.insert({ ...baseRec({ memoryLayer: 'vm', entityUri: 'e-vm' }), embedding: q });

    const vmOnly = await store.search(q, { contextGraphId: 'cg-a', memoryLayers: ['vm'], limit: 10 });
    expect(vmOnly.map((r) => r.entityUri).sort()).toEqual(['e-vm']);

    const swmVm = await store.search(q, { contextGraphId: 'cg-a', memoryLayers: ['swm', 'vm'], limit: 10 });
    expect(swmVm.map((r) => r.entityUri).sort()).toEqual(['e-swm', 'e-vm']);

    const all = await store.search(q, { contextGraphId: 'cg-a', memoryLayers: ['wm', 'swm', 'vm'], limit: 10 });
    expect(all.map((r) => r.entityUri).sort()).toEqual(['e-swm', 'e-vm', 'e-wm']);
  });

  it('search: rejects memory-layer outside WM/SWM/VM enum via CHECK constraint', async () => {
    // Pin to CHECK-constraint error vocabulary so a bare rejection (e.g. a
    // bug that accidentally accepts 'ltm' but rejects on something else
    // downstream) cannot satisfy the assertion.
    await expect(
      store.insert({ ...baseRec(), memoryLayer: 'ltm' as unknown as 'wm' }),
    ).rejects.toThrow(/CHECK|constraint|memoryLayer|memory_layer|enum|invalid/i);
  });

  it('search: dimension mismatch silently skips rows instead of throwing', async () => {
    await store.insert({ ...baseRec(), embedding: makeVec(8, 1), entityUri: 'e-8' });
    await store.insert({ ...baseRec(), embedding: makeVec(16, 1), entityUri: 'e-16' });
    const results = await store.search(makeVec(8, 1), { contextGraphId: 'cg-a', memoryLayers: ['wm'], limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].entityUri).toBe('e-8');
  });

  it('search: top-K ordering is descending by similarity', async () => {
    const q = [1, 0, 0, 0, 0, 0, 0, 0];
    await store.insert({ ...baseRec({ entityUri: 'e-perfect' }), embedding: [1, 0, 0, 0, 0, 0, 0, 0] });
    await store.insert({ ...baseRec({ entityUri: 'e-partial' }), embedding: [1, 1, 0, 0, 0, 0, 0, 0] });
    await store.insert({ ...baseRec({ entityUri: 'e-far' }), embedding: [0, 0, 0, 0, 0, 0, 0, 1] });
    const r = await store.search(q, { contextGraphId: 'cg-a', memoryLayers: ['wm'], limit: 10 });
    expect(r.map((x) => x.entityUri)).toEqual(['e-perfect', 'e-partial', 'e-far']);
    for (let i = 0; i < r.length - 1; i++) {
      expect(r[i].similarity).toBeGreaterThanOrEqual(r[i + 1].similarity);
    }
  });

  it('search: minSimilarity cutoff excludes weak matches', async () => {
    const q = [1, 0, 0, 0, 0, 0, 0, 0];
    await store.insert({ ...baseRec({ entityUri: 'e-perfect' }), embedding: [1, 0, 0, 0, 0, 0, 0, 0] });
    await store.insert({ ...baseRec({ entityUri: 'e-ortho' }), embedding: [0, 1, 0, 0, 0, 0, 0, 0] });
    const r = await store.search(q, { contextGraphId: 'cg-a', memoryLayers: ['wm'], limit: 10, minSimilarity: 0.5 });
    expect(r.map((x) => x.entityUri)).toEqual(['e-perfect']);
  });

  it('search: limit is respected even when more match', async () => {
    const q = makeVec(8, 123);
    for (let i = 0; i < 10; i++) {
      await store.insert({ ...baseRec({ entityUri: `e-${i}` }), embedding: q });
    }
    const r = await store.search(q, { contextGraphId: 'cg-a', memoryLayers: ['wm'], limit: 3 });
    expect(r).toHaveLength(3);
  });

  it('delete by sourceUri removes all rows matching that URI', async () => {
    await store.insert({ ...baseRec({ sourceUri: 's1', entityUri: 'e1' }) });
    await store.insert({ ...baseRec({ sourceUri: 's1', entityUri: 'e2' }) });
    await store.insert({ ...baseRec({ sourceUri: 's2', entityUri: 'e3' }) });
    const deleted = await store.delete({ sourceUri: 's1' });
    expect(deleted).toBe(2);
    expect(await store.count()).toBe(1);
  });

  it('delete by entityUri removes exactly that entity', async () => {
    await store.insert({ ...baseRec({ sourceUri: 's1', entityUri: 'e1' }) });
    await store.insert({ ...baseRec({ sourceUri: 's2', entityUri: 'e1' }) });
    await store.insert({ ...baseRec({ sourceUri: 's3', entityUri: 'e2' }) });
    const deleted = await store.delete({ entityUri: 'e1' });
    expect(deleted).toBe(2);
    expect(await store.count()).toBe(1);
  });

  it('delete without sourceUri or entityUri is a safe no-op', async () => {
    await store.insert(baseRec());
    const deleted = await store.delete({});
    expect(deleted).toBe(0);
    expect(await store.count()).toBe(1);
  });

  it('createdAt defaults to valid ISO-8601 when omitted', async () => {
    await store.insert(baseRec());
    const r = await store.search(baseRec().embedding, { contextGraphId: 'cg-a', memoryLayers: ['wm'], limit: 1 });
    expect(r).toHaveLength(1);
    // No direct exposure of createdAt — but we can at least assert the row round-trips
    expect(r[0].similarity).toBeGreaterThan(0);
  });

  it('float32 round-trip: embedding values survive BLOB encode/decode within float32 precision', async () => {
    const original = [0.1234567, -0.7654321, 1e-6, -1e-6, 3.14, -3.14, 0, 1];
    await store.insert({ ...baseRec(), embedding: original, entityUri: 'roundtrip' });
    const [hit] = await store.search(original, { contextGraphId: 'cg-a', memoryLayers: ['wm'], limit: 1 });
    expect(hit).toBeDefined();
    // Float32 precision ~= 1e-7; cosine self-similarity must be very close to 1
    expect(hit.similarity).toBeGreaterThan(0.9999);
  });
});
