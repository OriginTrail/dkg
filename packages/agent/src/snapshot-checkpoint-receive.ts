// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { open, statfs } from 'node:fs/promises';
import { PUBLIC_CHECKPOINT_KIND as K, type BulkGraphSession } from '@origintrail-official/dkg-core';
import { bulkChunkHash, parseBulkAssetHeader, parseBulkChunkEnd, parseBulkRefusal,
  type BulkGraphRequest } from './sync/bulk-graph-contract.js';
import { BULK_GRAPH_CHUNK_BYTES } from '@origintrail-official/dkg-core';
import { checkpointAssetPath, checkpointSha256, syncCheckpointDirectory, writeCheckpointFile,
  type SnapshotCheckpointEntry } from './snapshot-checkpoint-files.js';

export interface SnapshotCheckpointBudget {
  encodedBytes: number; plainBytes: number;
  readonly maxEncodedBytes: number; readonly maxPlainBytes: number; readonly minFreeBytes: number;
}

/** New protocol only: PERSISTED is local checkpoint persistence, never materialization or coverage. */
export async function receiveSnapshotCheckpointChunk(
  session: Pick<BulkGraphSession, 'next' | 'send' | 'signal'>,
  request: BulkGraphRequest,
  options: { directory: string; startIndex: number; budget: SnapshotCheckpointBudget; assertCurrent(): void },
): Promise<SnapshotCheckpointEntry[]> {
  const entries: SnapshotCheckpointEntry[] = [];
  const hash = bulkChunkHash(request);
  let chunkBytes = 0;
  for (;;) {
    session.signal.throwIfAborted(); options.assertCurrent();
    const frame = await session.next();
    if (frame.kind === K.REFUSE) {
      if (frame.index !== entries.length || frame.sequence !== 0) throw new Error('Invalid checkpoint refusal');
      parseBulkRefusal(frame.payload);
      throw new Error('Checkpoint supplier refused resource admission');
    }
    if (frame.kind === K.CHUNK_END) {
      const end = parseBulkChunkEnd(frame.payload);
      if (!entries.length || frame.index !== entries.length || frame.sequence !== chunkBytes
        || end.assets !== entries.length || end.encodedBytes !== chunkBytes || end.digest !== hash.digest('hex'))
        throw new Error('Checkpoint chunk coverage or digest mismatch');
      return entries;
    }
    if (frame.kind !== K.META || frame.index !== entries.length || frame.sequence !== 0
      || frame.index >= request.assetUals.length) throw new Error('Checkpoint asset order mismatch');
    const header = parseBulkAssetHeader(frame.payload);
    if (header.offset !== chunkBytes || header.encodedBytes > BULK_GRAPH_CHUNK_BYTES - chunkBytes)
      throw new RangeError('Checkpoint chunk allowance exceeded');
    const { budget } = options;
    if (header.encodedBytes > budget.maxEncodedBytes - budget.encodedBytes
      || header.plainBytes > budget.maxPlainBytes - budget.plainBytes)
      throw new RangeError('Checkpoint job allowance exceeded');
    const disk = await statfs(options.directory);
    if (disk.bavail * disk.bsize < budget.minFreeBytes + header.encodedBytes + header.plainBytes)
      throw new Error('Checkpoint disk reserve unavailable');
    budget.encodedBytes += header.encodedBytes; budget.plainBytes += header.plainBytes;
    const index = options.startIndex + entries.length;
    const file = await open(checkpointAssetPath(options.directory, index, 'body'), 'wx', 0o600);
    const bodyHash = createHash('sha256');
    let bytes = 0, sequence = 0;
    hash.update(frame.payload);
    try {
      for (;;) {
        const next = await session.next();
        session.signal.throwIfAborted(); options.assertCurrent();
        if (next.index !== frame.index || next.sequence !== sequence) throw new Error('Checkpoint body order mismatch');
        if (next.kind === K.ASSET_END) {
          if (next.payload.length) throw new Error('Invalid checkpoint asset terminator');
          break;
        }
        if (next.kind !== K.DATA || !next.payload.length || next.payload.length > header.encodedBytes - bytes)
          throw new Error('Checkpoint body size mismatch');
        await file.writeFile(next.payload);
        bodyHash.update(next.payload); hash.update(next.payload);
        bytes += next.payload.length; sequence++;
      }
      if (!sequence || bytes !== header.encodedBytes || bodyHash.digest('hex') !== header.digest)
        throw new Error('Checkpoint body digest mismatch');
      await file.sync();
    } finally { await file.close(); }
    const metadata = Buffer.from(header.metadata, 'base64');
    await writeCheckpointFile(checkpointAssetPath(options.directory, index, 'meta'), metadata);
    await syncCheckpointDirectory(options.directory);
    session.signal.throwIfAborted(); options.assertCurrent();
    entries.push({ index, ual: request.assetUals[frame.index]!, encodedBytes: bytes,
      plainBytes: header.plainBytes, bodySha256: header.digest, metadataSha256: checkpointSha256(metadata) });
    chunkBytes += bytes;
    await session.send({ kind: K.CREDIT, index: frame.index, sequence: bytes, payload: new Uint8Array() });
    await session.send({ kind: K.PERSISTED, index: frame.index, sequence: bytes, payload: new Uint8Array() });
  }
}
