import { expect, it, vi } from 'vitest';
import { GRAPH_TRANSFER_KIND as K, type BulkGraphFrame } from '@origintrail-official/dkg-core';
import { servePublicBulkChunk } from '../src/sync/responder/bulk-graph-stream.js';
import type { PublicAssetServingOptions } from '../src/sync/responder/public-asset-responder.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; };
const request = { version: 1 as const, contextGraphId: 'graph', snapshotDigest: 'a'.repeat(64), assetUals: ['first', 'next'] };
function fixture() {
  const released: string[] = [], frames: BulkGraphFrame[] = [], control: BulkGraphFrame[] = [];
  const abort = new AbortController();
  const lease = (id: string) => ({ body: new Uint8Array([1]), metadata: new Uint8Array([1]),
    identity: id, plainBytes: 1, encodingDurationMs: 0, wholePayloadExports: 0 as const,
    assertCurrent: vi.fn(async () => {}), release: () => { released.push(id); } });
  const options = { isPublicContextGraph: vi.fn(async () => true), exportCache: {
    acquireEncoded: vi.fn<PublicAssetServingOptions['exportCache']['acquireEncoded']>(async input => lease(input.assetUal)),
  } };
  const session = { signal: abort.signal, next: async () => control.shift()!, send: async (frame: BulkGraphFrame) => {
    frames.push(frame);
    if (frame.kind === K.ASSET_END) control.push(...[K.CREDIT, K.FINAL_ACK].map(kind => ({ kind, index: frame.index, sequence: 1, payload: new Uint8Array() })));
  } };
  return { options, session, lease, released, frames, abort };
}

it('prepares exactly one next export during transfer and releases both normal leases', async () => {
  const f = fixture(), prepared = deferred();
  f.options.exportCache.acquireEncoded.mockImplementation(async input => {
    if (input.assetUal === 'next') prepared.resolve();
    return f.lease(input.assetUal);
  });
  const send = f.session.send;
  f.session.send = async frame => { if (frame.kind === K.DATA && frame.index === 0) await prepared.promise; await send(frame); };
  await servePublicBulkChunk(request, f.session, f.options, true);
  expect(f.options.exportCache.acquireEncoded).toHaveBeenCalledTimes(2);
  expect(f.released).toEqual(['first', 'next']);
  expect(f.frames.filter(frame => frame.kind === K.META).map(frame => frame.index)).toEqual([0, 1]);
});

it('a speculative admission refusal falls back to ordinary admission only after the current lease releases', async () => {
  const f = fixture(); let preparations = 0;
  f.options.exportCache.acquireEncoded.mockImplementation(async input => {
    if (input.assetUal === 'next' && ++preparations === 1) { expect(f.released).toEqual([]); return null; }
    if (input.assetUal === 'next') expect(f.released).toEqual(['first']);
    return f.lease(input.assetUal);
  });
  await servePublicBulkChunk(request, f.session, f.options, true);
  expect(preparations).toBe(2); expect(f.released).toEqual(['first', 'next']);
  expect(f.frames.some(frame => frame.kind === K.REFUSE)).toBe(false);
});

it('never retries or discloses a prepared asset after its fresh authority check fails', async () => {
  const f = fixture();
  f.options.exportCache.acquireEncoded.mockImplementation(async input => {
    const lease = f.lease(input.assetUal);
    if (input.assetUal === 'next') lease.assertCurrent.mockRejectedValue(new Error('access revoked'));
    return lease;
  });
  await expect(servePublicBulkChunk(request, f.session, f.options, true)).rejects.toThrow('access revoked');
  expect(f.options.exportCache.acquireEncoded).toHaveBeenCalledTimes(2);
  expect(f.frames.filter(frame => frame.kind === K.META).map(frame => frame.index)).toEqual([0]);
  expect(f.released).toEqual(['first', 'next']);
});

it('holds ownership until an in-flight lookahead settles after a failed physical send', async () => {
  const f = fixture(), started = deferred(), cancelled = deferred(), physical = deferred(); let settled = false;
  f.options.exportCache.acquireEncoded.mockImplementation(async input => {
    if (input.assetUal === 'next') {
      input.signal!.addEventListener('abort', cancelled.resolve, { once: true });
      started.resolve(); await physical.promise;
    }
    return f.lease(input.assetUal);
  });
  f.session.send = async () => { await started.promise; throw new Error('physical send failed'); };
  const work = servePublicBulkChunk(request, f.session, f.options, true);
  const rejected = expect(work).rejects.toThrow('physical send failed');
  void work.catch(() => { settled = true; });
  await cancelled.promise;
  expect(settled).toBe(false); expect(f.released).toEqual(['first']);
  physical.resolve(); await rejected;
  expect(f.released).toEqual(['first', 'next']);
});
