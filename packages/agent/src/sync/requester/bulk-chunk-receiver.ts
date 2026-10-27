// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { BULK_GRAPH_CHUNK_BYTES, BULK_GRAPH_KIND as K, type BulkGraphSession } from '@origintrail-official/dkg-core';
import { bulkChunkHash, parseBulkAssetHeader, parseBulkChunkEnd, parseBulkRefusal,
  type BulkGraphRequest } from '../bulk-graph-contract.js';

type Header = ReturnType<typeof parseBulkAssetHeader>;
interface AssetSink {
  write(bytes: Uint8Array): Promise<void>;
  verified?(): Promise<void>;
  close(): Promise<void>;
}

/** Shared framing and integrity checks. Consumers own admission, persistence and acknowledgements. */
export async function receiveBulkChunk(session: Pick<BulkGraphSession, 'next'>, request: BulkGraphRequest, options: {
  signal: AbortSignal;
  assertCurrent?(): void;
  open(index: number, header: Header): Promise<AssetSink>;
  complete(index: number, header: Header, chunks: number): Promise<void>;
}) {
  const hash = bulkChunkHash(request);
  let assets = 0, encodedBytes = 0;
  const assertCurrent = () => { options.signal.throwIfAborted(); options.assertCurrent?.(); };
  const next = async () => { assertCurrent(); const frame = await session.next(); assertCurrent(); return frame; };
  for (;;) {
    const frame = await next();
    if (frame.kind === K.REFUSE) {
      parseBulkRefusal(frame.payload);
      if (frame.index !== assets || frame.sequence !== 0) throw new Error('Invalid bulk graph refusal');
      throw Object.assign(new Error('Bulk graph source refused RESOURCE_LIMIT'), { code: 'RESOURCE_LIMIT' });
    }
    if (frame.kind === K.CHUNK_END) {
      const end = parseBulkChunkEnd(frame.payload);
      if (!assets || frame.index !== assets || frame.sequence !== encodedBytes || end.assets !== assets
        || end.encodedBytes !== encodedBytes || end.digest !== hash.digest('hex'))
        throw new Error('Bulk chunk directory digest or coverage mismatch');
      return { assets, encodedBytes };
    }
    if (frame.kind !== K.META || frame.index !== assets || frame.sequence !== 0 || assets >= request.assetUals.length)
      throw new Error('Bulk asset order mismatch');
    const header = parseBulkAssetHeader(frame.payload);
    if (header.offset !== encodedBytes || header.encodedBytes > BULK_GRAPH_CHUNK_BYTES - encodedBytes)
      throw new RangeError('Bulk chunk or staging credit exceeded');
    const sink = await options.open(assets, header);
    const assetHash = createHash('sha256');
    let bytes = 0, chunks = 0;
    hash.update(frame.payload);
    try {
      for (;;) {
        const body = await next();
        if (body.index !== assets || body.sequence !== chunks) throw new Error('Bulk data order mismatch');
        if (body.kind === K.ASSET_END) {
          if (body.payload.length) throw new Error('Invalid bulk asset terminator');
          break;
        }
        if (body.kind !== K.DATA || !body.payload.length || body.payload.length > header.encodedBytes - bytes)
          throw new Error('Bulk body size mismatch');
        await sink.write(body.payload);
        bytes += body.payload.length; chunks++;
        hash.update(body.payload); assetHash.update(body.payload);
      }
      if (!chunks || bytes !== header.encodedBytes || assetHash.digest('hex') !== header.digest)
        throw new Error('Bulk encoded asset digest mismatch');
      assertCurrent();
      await sink.verified?.();
    } finally { await sink.close(); }
    assertCurrent();
    await options.complete(assets, header, chunks);
    encodedBytes += bytes; assets++;
  }
}
