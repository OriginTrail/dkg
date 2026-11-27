import { describe, expect, it, vi } from 'vitest';
import { ExactPageSessionReader, type ExactPageStoreSource } from '../src/sync/responder/exact-page-reader.js';
import type { ExactAssetExportCache, ExactAssetExportLease } from '../src/sync/responder/exact-asset-export-cache.js';
import { serializedResponderRowByteLength } from '../src/sync/responder/row-serialization.js';

const row = { s: 'urn:subject', p: 'urn:predicate', o: '"value"', g: 'urn:graph' };
function fixture(acquire: ExactAssetExportCache['acquire']) {
  const readRows = vi.fn(async () => [row]);
  const store: ExactPageStoreSource = { totalRows: 1, readRows, rememberReturnedPrefix: vi.fn() };
  const cache = { acquire } as ExactAssetExportCache;
  const scope = { contextGraphId: 'public-graph', assetUal: 'urn:asset', graph: row.g, expectedRows: 1, cache };
  return { store, scope, readRows };
}
function lease() {
  const release = vi.fn();
  const value: ExactAssetExportLease = { rows: [row], identity: 'verified-identity', assertCurrent: vi.fn(async () => {}), release };
  return { value, release };
}
const request = { offset: 0, limit: 64, maxBytes: 4096 };

describe('exact page reader response ownership', () => {
  it('returns the lease explicitly and retains its charge until the response releases it', async () => {
    const first = lease(), f = fixture(vi.fn(async () => first.value));
    const page = await new ExactPageSessionReader(f.store, f.scope).read(request);
    expect(page.rows).toEqual([row]); expect(page.responseLease).toBe(first.value);
    expect(first.release).not.toHaveBeenCalled(); expect(f.readRows).not.toHaveBeenCalled();
    await page.responseLease!.assertCurrent(); page.responseLease!.release();
    expect(first.release).toHaveBeenCalledOnce();
  });

  it('releases an initial export lease when its first row exceeds the wire byte budget', async () => {
    const first = lease(), f = fixture(vi.fn(async () => first.value));
    const reader = new ExactPageSessionReader(f.store, f.scope);
    await expect(reader.read({ ...request, maxBytes: serializedResponderRowByteLength(row) - 1 })).rejects.toMatchObject({ reason: 'snapshot_bytes' });
    expect(first.release).toHaveBeenCalledOnce(); expect(f.readRows).not.toHaveBeenCalled();
  });

  it('releases an initial export lease when serializing an invalid row throws before adoption', async () => {
    const first = lease();
    const f = fixture(vi.fn(async () => ({ ...first.value, rows: [{ ...row, p: 'invalid predicate>' }] })));
    await expect(new ExactPageSessionReader(f.store, f.scope).read(request)).rejects.toThrow();
    expect(first.release).toHaveBeenCalledOnce(); expect(f.readRows).not.toHaveBeenCalled();
  });

  it.each([false, true])('requires a fresh verified export during unstable recovery with scope=%s', async hasScope => {
    const acquire = vi.fn(async () => null), f = fixture(acquire);
    const reader = new ExactPageSessionReader(f.store, hasScope ? f.scope : undefined, true);
    await expect(reader.read(request)).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_UNAVAILABLE' });
    await expect(reader.read({ ...request, offset: 1 })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_UNAVAILABLE' });
    expect(f.readRows).not.toHaveBeenCalled(); expect(acquire).toHaveBeenCalledTimes(hasScope ? 1 : 0);
  });

  it('keeps a failed shared selection failed rather than selecting another reader on retry', async () => {
    const acquire = vi.fn(async () => { throw new Error('identity changed'); }), f = fixture(acquire);
    const reader = new ExactPageSessionReader(f.store, f.scope);
    await expect(reader.read(request)).rejects.toThrow('identity changed');
    await expect(reader.read(request)).rejects.toThrow('identity changed');
    expect(acquire).toHaveBeenCalledOnce(); expect(f.readRows).not.toHaveBeenCalled();
  });
});
