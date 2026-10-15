import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorePriorityScheduler, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { withPublicSnapshotStoreReads, exactExportStorePriority } from '../src/sync/responder/public-snapshot-store-admission.js';
import { EXACT_EXPORT_METADATA_OPERATION, retryExactMetadataAdmission } from '../src/sync/responder/exact-metadata-admission.js';
import { exactAssetExportFixture } from './fixtures/exact-asset-export.js';

afterEach(() => vi.restoreAllMocks());

describe('public snapshot store admission', () => {
  it('keeps the existing two metadata re-admissions and rejects errors from another lane', async () => {
    const busy = new StoreSchedulerBusyError('queue_full', 'normal', EXACT_EXPORT_METADATA_OPERATION);
    const read = vi.fn(async () => { throw busy; });
    await expect(withPublicSnapshotStoreReads(() => retryExactMetadataAdmission(read))).rejects.toBe(busy);
    expect(read).toHaveBeenCalledTimes(3);
    const other = new StoreSchedulerBusyError('queue_full', 'background', EXACT_EXPORT_METADATA_OPERATION);
    read.mockReset().mockRejectedValue(other);
    await expect(withPublicSnapshotStoreReads(() => retryExactMetadataAdmission(read))).rejects.toBe(other);
    expect(read).toHaveBeenCalledOnce();
  });

  it('cancels a queued source fence without leaking the lease or promoting concurrent background work', async () => {
    const f = exactAssetExportFixture(3), signal = new AbortController();
    const cold = (await f.cache.acquireEncoded(f))!;
    await cold.assertCurrent(); cold.release();
    const before = f.budget.stats();
    const warm = await withPublicSnapshotStoreReads(() => f.cache.acquireEncoded({ ...f, signal: signal.signal }));
    const scheduler = new StorePriorityScheduler();
    let releaseRepair!: () => void, releaseQuery!: () => void;
    const repair = scheduler.run('background', 'repair', () => new Promise<void>(r => { releaseRepair = r; }));
    const query = scheduler.run('normal', 'api.query', () => new Promise<void>(r => { releaseQuery = r; }));
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation((text, options) => scheduler.run(options?.priority, options?.source ?? '',
      () => original(text, options), options?.signal));
    const reason = new Error('original caller deadline');
    const pending = withPublicSnapshotStoreReads(() => warm!.assertCurrent());
    const rejected = expect(pending).rejects.toBe(reason);
    try {
      await vi.waitFor(() => expect(scheduler.snapshot.normalQueued).toBe(1));
      expect(exactExportStorePriority()).toBe('background');
      expect(scheduler.snapshot).toMatchObject({ maxConcurrent: 4, backgroundInflight: 1, normalInflight: 1,
        ackReservedSlots: 1, healthReservedSlots: 1, backgroundReservedSlots: 1, normalReservedSlots: 1 });
      await expect(scheduler.run('health', 'health', async () => true)).resolves.toBe(true);
      await expect(scheduler.run('ack', 'ack', async () => true)).resolves.toBe(true);
      signal.abort(reason); await rejected;
      expect(scheduler.snapshot.normalQueued).toBe(0);
    } finally {
      signal.abort(reason); releaseQuery(); releaseRepair(); await Promise.all([query, repair]);
      await rejected; warm!.release();
    }
    expect(f.budget.stats()).toEqual(before);
  });
});
