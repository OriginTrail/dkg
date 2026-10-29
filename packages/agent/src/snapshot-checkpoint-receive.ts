// SPDX-License-Identifier: Apache-2.0
import { receiveBulkChunk } from './sync/requester/bulk-chunk-receiver.js';
import { open, statfs } from 'node:fs/promises';
import { PUBLIC_CHECKPOINT_KIND as K, type BulkGraphSession } from '@origintrail-official/dkg-core';
import { type BulkGraphRequest } from './sync/bulk-graph-contract.js';
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
  await receiveBulkChunk(session, request, {
    signal: session.signal, assertCurrent: options.assertCurrent,
    open: async (assetIndex, header) => {
      const { budget } = options;
      if (header.encodedBytes > budget.maxEncodedBytes - budget.encodedBytes
        || header.plainBytes > budget.maxPlainBytes - budget.plainBytes)
        throw new RangeError('Checkpoint job allowance exceeded');
      const disk = await statfs(options.directory);
      if (disk.bavail * disk.bsize < budget.minFreeBytes + header.encodedBytes + header.plainBytes)
        throw new Error('Checkpoint disk reserve unavailable');
      budget.encodedBytes += header.encodedBytes; budget.plainBytes += header.plainBytes;
      const index = options.startIndex + assetIndex;
      const file = await open(checkpointAssetPath(options.directory, index, 'body'), 'wx', 0o600);
      return { write: bytes => file.writeFile(bytes), verified: () => file.sync(), close: () => file.close() };
    },
    complete: async (assetIndex, header) => {
      const index = options.startIndex + assetIndex;
      const bytes = header.encodedBytes;
      const metadata = Buffer.from(header.metadata, 'base64');
      await writeCheckpointFile(checkpointAssetPath(options.directory, index, 'meta'), metadata);
      await syncCheckpointDirectory(options.directory);
      session.signal.throwIfAborted(); options.assertCurrent();
      entries.push({ index, ual: request.assetUals[assetIndex]!, encodedBytes: bytes,
        plainBytes: header.plainBytes, bodySha256: header.digest, metadataSha256: checkpointSha256(metadata) });
      await session.send({ kind: K.CREDIT, index: assetIndex, sequence: bytes, payload: new Uint8Array() });
      await session.send({ kind: K.PERSISTED, index: assetIndex, sequence: bytes, payload: new Uint8Array() });
    },
  });
  return entries;
}
