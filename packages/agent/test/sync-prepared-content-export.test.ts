import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPreparedContentCache, resolvePreparedContentCacheConfig } from '../src/sync/responder/prepared-content-cache.js';
import { createBoundedExactAssetExportCache } from '../src/sync/responder/exact-asset-export-cache.js';
import { exactAssetExportFixture as fixture } from './fixtures/exact-asset-export.js';

afterEach(() => vi.restoreAllMocks());

describe('cold prepared writes retain source fences and response ownership', () => {
  it.each(['metadata', 'revision', 'abort'] as const)('rejects a %s change while persistence is pending', async kind => {
    const f = fixture(3), controller = new AbortController();
    let revision = 1;
    if (kind === 'revision') Object.assign(f.store, { getWriteRevision: () => ({ generation: revision, stable: true }) });
    let enter!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    const put = vi.fn(async () => { enter(); await held; });
    const cache = createBoundedExactAssetExportCache({ store: f.store, budget: f.budget,
      preparedContentCache: { get: async () => null, put } });
    const lease = (await cache.acquireEncoded({ ...f, signal: controller.signal }))!;
    let settled = false, completed = false;
    const pending = lease.assertCurrent().then(() => { completed = true; })
      .finally(() => { settled = true; lease.release(); });
    const observed = pending.catch(error => error);
    await started;
    const reserved = f.budget.stats();
    try {
      if (kind === 'metadata') f.meta.push({ subject: f.assetUal, predicate: 'urn:changed', object: '"value"', graph: '' });
      if (kind === 'revision') revision++;
      if (kind === 'abort') controller.abort(Object.assign(new Error('cancelled persistence'), { name: 'AbortError' }));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(reserved.bytesEstimate).toBeGreaterThan(96 * 1024 * 1024);
      expect(f.budget.stats()).toEqual(reserved);
    } finally { finish(); }
    expect(await observed).toMatchObject(kind === 'abort' ? { name: 'AbortError' } : { code: 'SYNC_EXACT_EXPORT_CHANGED' });
    expect(completed).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
    if (kind === 'revision') {
      expect(f.budget.stats()).toEqual({ snapshots: 2, rows: 3, bytesEstimate: reserved.bytesEstimate - 96 * 1024 * 1024 });
    } else {
      expect(f.budget.stats()).toEqual({ snapshots: 1, rows: 0, bytesEstimate: cache.stats().encodedCacheBytes });
    }
  });
});

describe('prepared assertion reuse across responder restarts', () => {
  it('serves prepared bytes when memory retention declines and keeps the response charged and fenced', async () => {
    const f = fixture(4), directory = mkdtempSync(join(tmpdir(), 'prepared-no-retain-'));
    const config = resolvePreparedContentCacheConfig({ enabled: true, directory })!;
    const restart = () => createBoundedExactAssetExportCache({ store: f.store, budget: f.budget,
      encodedMaxBytes: 1, preparedContentCache: createPreparedContentCache(config) });
    try {
      const first = (await restart().acquireEncoded(f))!;
      await first.assertCurrent(); const expected = first.body.slice(); first.release();
      const before = f.budget.stats().bytesEstimate;
      const cache = restart(); f.reads.length = 0;
      const lease = (await cache.acquireEncoded(f))!;
      expect(lease.body).toEqual(expected);
      expect(lease.wholePayloadExports).toBe(0);
      expect(cache.stats()).toMatchObject({ exports: 0, preparedCacheHits: 1, encodedCacheEntries: 0 });
      expect(f.budget.stats().bytesEstimate).toBe(before + 96 * 1024 * 1024);
      await lease.assertCurrent();
      f.meta.push({ subject: f.assetUal, predicate: 'urn:changed', object: '"value"', graph: '' });
      await expect(lease.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
      lease.release(); lease.release();
      expect(f.budget.stats().bytesEstimate).toBe(before);
      expect(f.reads.every(read => read.options?.source?.endsWith('.metadata'))).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('reuses disk bytes without exporting DATA, but reads fresh metadata and fences every response', async () => {
    const f = fixture(4), directory = mkdtempSync(join(tmpdir(), 'prepared-responder-'));
    const config = resolvePreparedContentCacheConfig({ enabled: true, directory })!;
    const restart = () => createBoundedExactAssetExportCache({ store: f.store, budget: f.budget,
      preparedContentCache: createPreparedContentCache(config) });
    try {
      const first = restart(), cold = (await first.acquireEncoded(f))!;
      await cold.assertCurrent(); const expected = cold.body.slice(); cold.release();
      const second = restart(); f.reads.length = 0;
      const warm = (await second.acquireEncoded(f))!;
      expect(warm.body).toEqual(expected); expect(warm.wholePayloadExports).toBe(0);
      await warm.assertCurrent(); warm.release();
      expect(second.stats()).toMatchObject({ exports: 0, preparedCacheHits: 1 });
      expect(f.reads.every(read => read.options?.source?.endsWith('.metadata'))).toBe(true);
      // A policy transition invalidates access even though the disk copy exists.
      f.meta.find(q => q.predicate === 'http://dkg.io/ontology/accessPolicy')!.object = '"private"';
      expect(await restart().acquireEncoded(f)).toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('does not persist an unfenced response or reuse changed metadata', async () => {
    const f = fixture(3), directory = mkdtempSync(join(tmpdir(), 'prepared-responder-'));
    const config = resolvePreparedContentCacheConfig({ enabled: true, directory })!;
    const restart = () => createBoundedExactAssetExportCache({ store: f.store, budget: f.budget,
      preparedContentCache: createPreparedContentCache(config) });
    try {
      const abandoned = (await restart().acquireEncoded(f))!; abandoned.release();
      const second = restart(), cold = (await second.acquireEncoded(f))!;
      expect(cold.wholePayloadExports).toBe(1); await cold.assertCurrent(); cold.release();
      f.meta.push({ subject: f.assetUal, predicate: 'urn:additional-metadata', object: '"changed"', graph: '' });
      const third = restart(), changed = (await third.acquireEncoded(f))!;
      expect(changed.wholePayloadExports).toBe(1); await changed.assertCurrent(); changed.release();
      expect(third.stats().preparedCacheHits).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('retains source revision fences and cancellation after disk IO', async () => {
    const f = fixture(3); let revision = 1;
    Object.assign(f.store, { getWriteRevision: () => ({ generation: revision, stable: true }) });
    let value: any;
    const preparedContentCache = { get: async () => value ?? null, put: async (_key: string, saved: any) => { value = saved; } };
    const first = createBoundedExactAssetExportCache({ store: f.store, budget: f.budget, preparedContentCache });
    const cold = (await first.acquireEncoded(f))!; await cold.assertCurrent(); cold.release();
    const second = createBoundedExactAssetExportCache({ store: f.store, budget: f.budget,
      preparedContentCache: { ...preparedContentCache, get: async () => { revision++; return value; } } });
    await expect(second.acquireEncoded(f)).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
    const controller = new AbortController();
    const third = createBoundedExactAssetExportCache({ store: f.store, budget: f.budget,
      preparedContentCache: { ...preparedContentCache, get: async () => { controller.abort(); return value; } } });
    await expect(third.acquireEncoded({ ...f, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
