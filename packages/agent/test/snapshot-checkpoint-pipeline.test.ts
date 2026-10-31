import { expect, it, vi } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PUBLIC_CHECKPOINT_KIND as K } from '@origintrail-official/dkg-core';
import { SnapshotCheckpointQueue } from '../src/snapshot-checkpoint-queue.js';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { BULK_STAGING_ASSETS, BULK_STAGING_BYTES } from '../src/sync/bulk-graph-contract.js';
import { checkpointFixture } from './helpers/public-checkpoint-fixture.js';

const entry = (index: number, encodedBytes = 1) => ({ index, encodedBytes, plainBytes: encodedBytes,
  ual: `asset:${index}`, bodySha256: 'a'.repeat(64), metadataSha256: 'b'.repeat(64) });

it.each(['count', 'bytes'] as const)('holds staging %s until verification releases the in-flight entry', async bound => {
  const queue = new SnapshotCheckpointQueue(new AbortController().signal);
  const size = bound === 'bytes' ? BULK_STAGING_BYTES : 1;
  const count = bound === 'count' ? BULK_STAGING_ASSETS : 1;
  for (let i = 0; i < count; i++) { await queue.reserve(size); queue.publish(entry(i, size)); }
  const first = await queue.next(queue.signal);
  let reserved = false;
  const blocked = queue.reserve(1).then(() => { reserved = true; });
  await Promise.resolve();
  expect(reserved).toBe(false); // Taking an entry is not completing verification.
  queue.consumed(first!);
  await blocked;
  expect(reserved).toBe(true);
});

it('wakes all waiting verification lanes on failure and preserves the stream deadline while staging is full', async () => {
  const queue = new SnapshotCheckpointQueue(new AbortController().signal);
  const waiting = Array.from({ length: 4 }, () => queue.next(queue.signal));
  const outcomes = Promise.allSettled(waiting);
  const failure = new Error('integrity failure');
  queue.fail(failure);
  expect(await outcomes).toEqual(Array.from({ length: 4 }, () => ({ status: 'rejected', reason: failure })));
  const full = new SnapshotCheckpointQueue(new AbortController().signal);
  await full.reserve(BULK_STAGING_BYTES);
  const lifetime = new AbortController();
  const blocked = full.reserve(1, lifetime.signal);
  const rejected = expect(blocked).rejects.toThrow('original deadline');
  lifetime.abort(new Error('original deadline'));
  await rejected;
});

it.each([false, true])('verifies the first durable asset before the next asset arrives; bad chunk=%s never seals', async badChunk => {
  let verified!: () => void;
  const firstVerified = new Promise<void>(resolve => { verified = resolve; });
  const original = SyncVerifyWorker.prototype.processDurableBatch;
  const worker = vi.spyOn(SyncVerifyWorker.prototype, 'processDurableBatch').mockImplementation(async function (...args) {
    const result = await original.apply(this, args);
    verified();
    return result;
  });
  const f = await checkpointFixture({ beforeSend: async frame => {
    if (frame.kind === K.META && frame.index === 1) await firstVerified;
    if (badChunk && frame.kind === K.CHUNK_END) {
      const payload = JSON.parse(Buffer.from(frame.payload).toString());
      frame.payload = Buffer.from(JSON.stringify({ ...payload, digest: '0'.repeat(64) }));
    }
  } });
  const close = vi.spyOn(SyncVerifyWorker.prototype, 'close');
  try {
    if (badChunk) {
      await expect(f.run()).rejects.toThrow();
      const [attempt] = await readdir(join(f.directory, 'public-snapshot-checkpoints'));
      expect(await readdir(join(f.directory, 'public-snapshot-checkpoints', attempt!))).not.toContain('manifest.json');
    } else {
      const result = await f.run();
      expect(result.manifest.assets.map(asset => asset.ual)).toEqual(f.uals);
    }
    expect(worker).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    for (const result of close.mock.results) if (result.type === 'return') await expect(result.value).resolves.toBeUndefined();
  } finally { worker.mockRestore(); close.mockRestore(); }
}, 15_000);
