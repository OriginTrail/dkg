import { describe, expect, it } from 'vitest';
import { BULK_GRAPH_KIND as K, type BulkGraphFrame, knowledgeAssetLayerGraphUri, MemoryLayer, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { BulkGraphPartialError } from '../src/sync/requester/bulk-graph-stream.js';
import { fixture, cg } from './helpers/bulk-graph-fixture.js';

describe('bulk public graph stream over real Noise sockets and verifier', () => {
  it.each([false, true])('withholds durable ACK while publication is pending or rejected (reject=%s)', async reject => {
    const controls: BulkGraphFrame[] = [];
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const publishing = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(2, -1, false, { onControl: frame => controls.push(frame), beforePublish: async () => {
      entered(); await blocked; if (reject) throw new Error('fixture publication rejected');
    } });
    const result = f.run().then(value => ({ value }), error => ({ error }));
    try {
      await publishing;
      expect(controls.filter(x => x.kind === K.CREDIT)).toHaveLength(2);
      expect(controls.filter(x => x.kind === K.COMMIT)).toHaveLength(0);
      expect(await f.target.countQuads()).toBe(0);
    } finally { release(); }
    const outcome = await result;
    if (reject) {
      expect(outcome).toHaveProperty('error');
      expect(controls.filter(x => x.kind === K.COMMIT)).toHaveLength(0);
      expect(await f.target.countQuads()).toBe(0);
    } else {
      expect(outcome).toHaveProperty('value');
      expect(controls.filter(x => x.kind === K.COMMIT).map(x => x.index)).toEqual([0, 1]);
      expect(await f.target.countQuads()).toBeGreaterThan(0);
    }
  }, 30_000);
  it.each([[5, 5], [10, 1]])('separates expanded assets %j MiB with real decoding and verification', async (first, second) => {
    const f = await fixture(2, -1, false, { payloadBytes: [first, second].map(n => n * 1024 * 1024) });
    const result = await f.run();
    expect(result.committedAssetUals).toEqual(f.uals);
    expect(f.groups).toEqual([1, 1]);
    expect(f.heaps.every(n => n < 64 * 1024 * 1024)).toBe(true);
  }, 60_000);
  it.each(['asset', 'chunk'] as const)('rejects a forged %s digest without losing durable prefix accounting', async tamperDigest => {
    const f = await fixture(20, -1, false, { tamperDigest });
    const error = await f.run().then(() => { throw new Error('forged digest accepted'); }, error => error);
    expect(error).toBeInstanceOf(BulkGraphPartialError);
    expect(error.message).toContain(tamperDigest === 'asset' ? 'encoded asset digest mismatch' : 'directory digest or coverage mismatch');
    if (tamperDigest === 'asset') expect(error.committedAssetUals).toEqual([]);
    else {
      expect(error.committedAssetUals.length).toBeGreaterThanOrEqual(8);
      expect(error.committedAssetUals).toEqual(f.uals.slice(0, error.committedAssetUals.length));
      expect(error.metrics.committedAssets).toBe(error.committedAssetUals.length);
      for (const ual of error.committedAssetUals) expect(await f.target.countQuads(
        knowledgeAssetLayerGraphUri(cg, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, 1)))).toBeGreaterThan(0);
    }
  });
  it('rejects a false expanded-length directory before verification or publication', async () => {
    const f = await fixture(1, -1, false, { expandedLengthMismatch: true });
    await expect(f.run()).rejects.toThrow('Bulk expanded size mismatch');
    expect(await f.target.countQuads()).toBe(0); expect(f.groups).toEqual([]);
  });
  it('transfers more than ten assets, groups atomic publication, and reuses warm payloads', async () => {
    const f=await fixture(); const first=await f.run();
    expect(first.committedAssetUals).toEqual(f.uals); expect(first.metrics.commitGroups).toBeLessThan(20);
    expect(first.metrics.largestGroup).toBeGreaterThan(1); expect(first.metrics.peakStagedBytes).toBeLessThanOrEqual(16*1024*1024);
    expect(f.exports.reduce((a,b)=>a+b,0)).toBe(20);
    const count=await f.target.countQuads(); f.exports.length=0;
    const second=await f.run(); expect(second.committedAssetUals).toEqual(f.uals);
    expect(await f.target.countQuads()).toBe(count); expect(f.exports.every(n=>n===0)).toBe(true);
  },30_000);
  it('retains all completed local commits if physical stream closure subsequently fails', async () => {
    const f = await fixture(12, -1, true);
    let error: unknown; try { await f.run(); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(BulkGraphPartialError);
    expect((error as BulkGraphPartialError).committedAssetUals).toEqual(f.uals);
    expect((error as Error).message).toContain('physical close failed');
  }, 30_000);
  it('does not acknowledge a corrupt asset even when its encoded directory digest agrees', async () => {
    const f=await fixture(20,9);
    let error: unknown; try {await f.run();} catch(e){error=e;}
    expect(error).toBeInstanceOf(BulkGraphPartialError);
    expect((error as BulkGraphPartialError).metrics.receivedAssets).toBeGreaterThanOrEqual(10);
    expect((error as BulkGraphPartialError).committedAssetUals).toEqual(f.uals.slice(0,8));
    expect(await f.target.countQuads(knowledgeAssetLayerGraphUri(cg, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(f.uals[9]!, 1)))).toBe(0);
  },30_000);
});
