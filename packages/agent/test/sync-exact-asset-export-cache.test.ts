import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { BlazegraphStore, StoreResponseTooLargeError, type Quad, type QueryOptions } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { createSyncResponderSnapshotBudget } from '../src/sync/responder/snapshot-budget.js';
import { createBoundedExactAssetExportCache, EXACT_ASSET_EXPORT_MAX_ROWS, EXACT_ASSET_EXPORT_MAX_STORE_BYTES } from '../src/sync/responder/exact-asset-export-cache.js';

function fixture(rows = 10_000, literal = 'bounded-value') {
  const contextGraphId = 'bounded-export-public';
  const assetUal = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/1';
  const graph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(assetUal, 1));
  const payload: Quad[] = Array.from({ length: rows }, (_, index) => ({
    graph, subject: `urn:asset:${index.toString().padStart(5, '0')}`,
    predicate: 'urn:predicate', object: JSON.stringify(`${literal}:${index}`),
  }));
  const meta = generateGraphKnowledgeAssetMetadata({
    ual: assetUal, contextGraphId, assertionGraph: graph, assertionVersion: '1',
    merkleRoot: computeFlatKCRootV10(payload, []), publisherPeerId: 'publisher',
    accessPolicy: 'public', timestamp: new Date(0), publicTripleCount: rows, privateTripleCount: 0,
  }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: {
    txHash: `0x${'11'.repeat(32)}`, batchId: 1n,
  } } });
  const store = new BlazegraphStore('http://127.0.0.1:1/unused');
  const reads: Array<{ query: string; options?: QueryOptions }> = [];
  const query = vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    reads.push({ query: sparql, options });
    return options?.source === 'sync.responder.exactAssetExport.metadata'
      ? { type: 'bindings', bindings: meta.map((quad) => ({ predicate: quad.predicate, object: quad.object })) }
      : { type: 'bindings', bindings: payload.map((quad) => ({ s: quad.subject, p: quad.predicate, o: quad.object })) };
  });
  const budget = createSyncResponderSnapshotBudget({
    maxRows: 100_000, maxBytesEstimate: 384 * 1024 * 1024,
    maxSnapshotRows: 100_000, maxSnapshotBytesEstimate: 128 * 1024 * 1024,
  });
  return { contextGraphId, assetUal, graph, expectedRows: rows, payload, meta, store, query, reads, budget,
    cache: createBoundedExactAssetExportCache({ store, budget }) };
}

afterEach(() => vi.restoreAllMocks());

describe('bounded exact asset export ownership', () => {
  it('observes export substages while preserving bounded reads and the final metadata fence', async () => {
    const f = fixture(20);
    const onStage = vi.fn();
    const lease = await f.cache.acquire({ ...f, onStage });
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([
      'export-metadata-before', 'export-store-payload-query',
      'export-canonical-preparation-root', 'export-metadata-after',
    ]);
    expect(onStage.mock.calls.every(([, duration]) => Number.isFinite(duration) && duration >= 0)).toBe(true);
    expect(lease!.rows).toHaveLength(20);
    expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    expect(f.reads.filter(read => read.options?.source?.endsWith('.metadata'))).toHaveLength(2);
    f.meta.push({ graph: f.meta[0]!.graph, subject: f.assetUal, predicate: 'urn:fence-change', object: '"changed"' });
    await expect(lease!.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
    expect(f.reads.filter(read => read.options?.source?.endsWith('.metadata'))).toHaveLength(3);
    lease!.release();
    expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
  });

  it.each(['throw', 'reject'] as const)('keeps observer %s failures outside export and lease ownership', async mode => {
    const f = fixture(20);
    const onStage = vi.fn((_stage: string, _durationMs: number) => {
      if (mode === 'throw') throw new Error('observational failure');
      return Promise.reject(new Error('observational failure'));
    });
    const lease = await f.cache.acquire({ ...f, onStage });
    expect(onStage).toHaveBeenCalledTimes(4);
    expect(lease!.rows).toHaveLength(20);
    await lease!.assertCurrent();
    lease!.release();
    await Promise.resolve();
    expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
  });

  it('exports a genuine 10k-root fixture in one bounded physical payload read', async () => {
    const f = fixture();
    const lease = await f.cache.acquire(f);
    expect(lease?.rows).toHaveLength(10_000);
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    expect(f.reads.find((read) => read.options?.source?.endsWith('.payload'))).toMatchObject({
      options: { maxResponseBytes: EXACT_ASSET_EXPORT_MAX_STORE_BYTES, priority: 'background' },
    });
    expect(f.reads.find((read) => read.options?.source?.endsWith('.payload'))!.query).toContain('LIMIT 10001');
    expect(Object.isFrozen(lease!.rows)).toBe(true);
    expect(Object.isFrozen(lease!.rows[0])).toBe(true);
    await lease!.assertCurrent();
    expect(f.budget.stats().bytesEstimate).toBeGreaterThan(64 * 1024 * 1024);
    lease!.release(); lease!.release();
    expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
  });

  it('recomputes every page on a revisionless Blazegraph store and fences the session metadata', async () => {
    const f = fixture(300);
    const first = await f.cache.acquire(f);
    first!.release();
    const second = await f.cache.acquire({ ...f, expectedIdentity: first!.identity });
    second!.release();
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(2);
    f.meta.push({ graph: f.meta[0]!.graph, subject: f.assetUal, predicate: 'urn:changed-control', object: '"changed"' });
    await expect(f.cache.acquire({ ...f, expectedIdentity: first!.identity })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
  });

  it('reuses only a stable source/meta revision and rejects mutation after acquisition', async () => {
    const f = fixture(300);
    let generation = 1;
    Object.assign(f.store, { getWriteRevision: () => ({ generation, stable: true }) });
    const cache = createBoundedExactAssetExportCache({ store: f.store, budget: f.budget, maxEntries: 1 });
    const first = await cache.acquire(f); first!.release();
    const second = await cache.acquire(f);
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    generation += 1;
    await expect(second!.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
    second!.release();
    const third = await cache.acquire(f); third!.release();
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(2);
  });

  it('expires a retained identity when metadata changes into a fast-profile refusal', async () => {
    const f = fixture(20);
    const first = await f.cache.acquire(f);
    first!.release();
    f.meta.find((quad) => quad.predicate === 'http://dkg.io/ontology/accessPolicy')!.object = '"private"';
    await expect(f.cache.acquire({ ...f, expectedIdentity: first!.identity })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
  });

  it.each(['byte-limit', 'row-limit', 'non-bindings', 'malformed-binding'] as const)(
    'expires retained metadata on an unreadable %s profile', async (kind) => {
      const f = fixture(20);
      const first = await f.cache.acquire(f);
      first!.release();
      const normal = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (sparql, options) => {
        if (options?.source !== 'sync.responder.exactAssetExport.metadata') return normal(sparql, options);
        if (kind === 'byte-limit') throw new StoreResponseTooLargeError(64 * 1024, 64 * 1024 + 1);
        if (kind === 'row-limit') return { type: 'bindings', bindings: Array.from({ length: 129 }, () => ({ predicate: 'urn:overflow', object: '"overflow"' })) };
        if (kind === 'non-bindings') return { type: 'boolean', value: true };
        return { type: 'bindings', bindings: [{ predicate: 'urn:missing-object' }] };
      });
      await expect(f.cache.acquire({ ...f, expectedIdentity: first!.identity })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
      expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
      expect(f.budget.stats().snapshots).toBe(0);
    },
  );

  it('refuses a larger row profile before any payload or metadata query', async () => {
    const f = fixture(1);
    expect(await f.cache.acquire({ ...f, expectedRows: EXACT_ASSET_EXPORT_MAX_ROWS + 1 })).toBeNull();
    expect(f.reads).toHaveLength(0);
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('treats a canonical-size fast-profile refusal as fallback rather than invalid content', async () => {
    const f = fixture(80, 'x'.repeat(60_000));
    expect(await f.cache.acquire(f)).toBeNull();
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('falls back on physical response byte overflow and retains no budget charge', async () => {
    const f = fixture(1);
    const normal = f.query.getMockImplementation()!;
    f.query.mockImplementation((sparql, options) => options?.source?.endsWith('.payload')
      ? Promise.reject(new StoreResponseTooLargeError(EXACT_ASSET_EXPORT_MAX_STORE_BYTES, EXACT_ASSET_EXPORT_MAX_STORE_BYTES + 1))
      : normal(sparql, options));
    expect(await f.cache.acquire(f)).toBeNull();
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('fails closed on a same-count corrupt body instead of serving or caching it', async () => {
    const f = fixture(10);
    f.payload[0]!.object = '"corrupt"';
    await expect(f.cache.acquire(f)).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('does not dispatch a payload when shared memory admission rejects the build', async () => {
    const f = fixture(1);
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 100_000, maxBytesEstimate: 32 * 1024 * 1024,
      maxSnapshotRows: 100_000, maxSnapshotBytesEstimate: 32 * 1024 * 1024,
    });
    const cache = createBoundedExactAssetExportCache({ store: f.store, budget });
    expect(await cache.acquire(f)).toBeNull();
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(0);
    expect(budget.stats().snapshots).toBe(0);
  });

  it('holds physical ownership and its reservation when cancellation arrives during a query', async () => {
    const f = fixture(10);
    const normal = f.query.getMockImplementation()!;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    f.query.mockImplementation(async (sparql, options) => {
      if (options?.source?.endsWith('.payload')) { started(); await held; }
      return normal(sparql, options);
    });
    const controller = new AbortController();
    const onStage = vi.fn((_stage: string, _durationMs: number) => { throw new Error('observational failure during cancellation'); });
    let settled = false;
    const work = f.cache.acquire({ ...f, signal: controller.signal, onStage }).finally(() => { settled = true; });
    const observed = work.catch((error) => error);
    await entered; controller.abort(Object.assign(new Error('test cancellation'), { name: 'AbortError' }));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(['export-metadata-before']);
    expect(f.budget.stats().bytesEstimate).toBe(80 * 1024 * 1024);
    finish();
    expect(await observed).toMatchObject({ name: 'AbortError' });
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(['export-metadata-before', 'export-store-payload-query']);
    expect(f.budget.stats().snapshots).toBe(0);
  });
});
