import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorePriorityScheduler, StoreSchedulerBusyError, isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { exactAssetExportFixture as fixture } from './fixtures/exact-asset-export.js';
import { EXACT_EXPORT_METADATA_OPERATION, retryExactMetadataAdmission } from '../src/sync/responder/exact-metadata-admission.js';
import { createBoundedExactAssetExportCache } from '../src/sync/responder/exact-asset-export-cache.js';

afterEach(() => vi.restoreAllMocks());

describe('exact export metadata under background store contention', () => {
  it.each(['initial', 'source-fence'] as const)('recovers a warm %s admission timeout without another DATA export', async stage => {
    const f = fixture(3);
    const cold = (await f.cache.acquireEncoded(f))!;
    await cold.assertCurrent(); cold.release();
    const warm = stage === 'source-fence' ? (await f.cache.acquireEncoded(f))! : undefined;
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, ackReservedSlots: 0,
      healthReservedSlots: 0, backgroundReservedSlots: 0, queueWaitTimeoutMs: 20 });
    let release!: () => void;
    const blocker = scheduler.run('background', 'api.query', () => new Promise<void>(resolve => { release = resolve; }));
    const original = f.query.getMockImplementation()!;
    let rejections = 0;
    f.query.mockImplementation(async (query, options) => {
      try { return await scheduler.run(options?.priority, options?.source ?? 'unknown', () => original(query, options), options?.signal); }
      catch (error) { if (isStoreSchedulerBusyError(error)) { rejections++; release(); } throw error; }
    });
    const controller = new AbortController();
    let lease = warm;
    try {
      lease ??= (await f.cache.acquireEncoded({ ...f, signal: controller.signal }))!;
      await lease.assertCurrent();
      expect(lease.wholePayloadExports).toBe(0);
      expect(rejections).toBe(1);
      expect(f.cache.stats().exports).toBe(1);
      expect(f.reads.every(read => read.options?.signal === undefined || read.options.signal === controller.signal)).toBe(true);
    } finally { lease?.release(); release(); await blocker; }
    await vi.waitFor(() => expect(scheduler.snapshot).toMatchObject({ backgroundInflight: 0, backgroundQueued: 0 }));
  });

  it.each(['private', 'identity', 'revision'] as const)('still rejects a %s transition while the final metadata fence is waiting', async kind => {
    const f = fixture(3); let revision = 1;
    Object.assign(f.store, { getWriteRevision: () => ({ generation: revision, stable: true }) });
    f.cache = createBoundedExactAssetExportCache({ store: f.store, budget: f.budget });
    const cold = (await f.cache.acquireEncoded(f))!;
    await cold.assertCurrent(); cold.release();
    const warm = (await f.cache.acquireEncoded(f))!;
    const original = f.query.getMockImplementation()!;
    let rejected = false;
    f.query.mockImplementation(async (query, options) => {
      if (!rejected) {
        rejected = true;
        if (kind === 'private') f.meta.find(q => q.predicate.endsWith('/accessPolicy'))!.object = '"private"';
        if (kind === 'identity') f.meta.push({ subject: f.assetUal, predicate: 'urn:changed', object: '"changed"', graph: '' });
        if (kind === 'revision') revision++;
        throw new StoreSchedulerBusyError('queue_wait_timeout', 'background', EXACT_EXPORT_METADATA_OPERATION);
      }
      return original(query, options);
    });
    try { await expect(warm.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' }); }
    finally { warm.release(); }
    expect(f.cache.stats().exports).toBe(1);
  });

  it('cancels a queued final fence and releases its response reservation', async () => {
    const f = fixture(3), controller = new AbortController();
    const cold = (await f.cache.acquireEncoded(f))!;
    await cold.assertCurrent(); cold.release();
    const before = f.budget.stats();
    const warm = (await f.cache.acquireEncoded({ ...f, signal: controller.signal }))!;
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, ackReservedSlots: 0,
      healthReservedSlots: 0, backgroundReservedSlots: 0, queueWaitTimeoutMs: 10000 });
    let release!: () => void;
    const blocker = scheduler.run('background', 'api.query', () => new Promise<void>(done => { release = done; }));
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation((query, options) => scheduler.run(options?.priority, options?.source ?? '', () => original(query, options), options?.signal));
    const reason = new Error('session stopped'), pending = warm.assertCurrent();
    const rejected = expect(pending).rejects.toBe(reason);
    expect(scheduler.snapshot.backgroundQueued).toBe(1);
    controller.abort(reason);
    try { await rejected; }
    finally { warm.release(); release(); await blocker; }
    await vi.waitFor(() => expect(scheduler.snapshot).toMatchObject({ backgroundInflight: 0, backgroundQueued: 0 }));
    expect(f.budget.stats()).toEqual(before);
  });
});

describe('bounded exact metadata admission retries', () => {
  const busy = () => new StoreSchedulerBusyError('queue_wait_timeout', 'background', EXACT_EXPORT_METADATA_OPERATION);
  it('propagates persistent pressure after two re-admissions', async () => {
    const error = busy(), read = vi.fn(async () => { throw error; });
    await expect(retryExactMetadataAdmission(read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('stops during backoff with the original caller cancellation and no further read', async () => {
    const controller = new AbortController(), reason = new Error('original session deadline');
    const read = vi.fn(async () => { setTimeout(() => controller.abort(reason), 10); throw busy(); });
    await expect(retryExactMetadataAdmission(read, controller.signal)).rejects.toBe(reason);
    expect(read).toHaveBeenCalledOnce();
  });
  it.each([
    new Error('integrity failure'),
    Object.assign(new Error('query timeout'), { code: 'QUERY_DEADLINE_EXCEEDED' }),
    Object.assign(new Error('not a canonical scheduler rejection'), { code: 'STORE_SCHEDULER_BUSY', retryable: true }),
    new StoreSchedulerBusyError('queue_full', 'normal', EXACT_EXPORT_METADATA_OPERATION),
    new StoreSchedulerBusyError('queue_full', 'background', 'other.operation'),
  ])('does not retry non-admission or unrelated errors: %s', async error => {
    const read = vi.fn(async () => { throw error; });
    await expect(retryExactMetadataAdmission(read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledOnce();
  });
  it('re-enters the same read after a typed queue-full refusal', async () => {
    const read = vi.fn().mockRejectedValueOnce(new StoreSchedulerBusyError('queue_full', 'background', EXACT_EXPORT_METADATA_OPERATION)).mockResolvedValue('fresh result');
    await expect(retryExactMetadataAdmission(read)).resolves.toBe('fresh result');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
