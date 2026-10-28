import { afterEach, expect, it, vi } from 'vitest';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { EXACT_EXPORT_PAYLOAD_OPERATION as operation, retryExactPayloadAdmission } from '../src/sync/responder/exact-metadata-admission.js';
import { exactAssetExportFixture as fixture } from './fixtures/exact-asset-export.js';

afterEach(() => vi.restoreAllMocks());
const busy = (priority: 'normal' | 'background' = 'background') => new StoreSchedulerBusyError('queue_wait_timeout', priority, operation);

it.each(['background', 'normal'] as const)('caps persistent %s payload pressure at two re-admissions and releases the export reservation', async priority => {
  const f = fixture(3), before = f.budget.stats(), error = busy(priority);
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation((query, options) => {
    if (options?.source === operation) return Promise.reject(error);
    return original(query, options);
  });
  await expect(f.cache.acquireEncoded({ ...f, readPriority: priority })).rejects.toBe(error);
  expect(f.query.mock.calls.filter(([, o]) => o?.source === operation)).toHaveLength(3);
  expect(f.budget.stats()).toEqual(before);
  expect(f.cache.stats().exports).toBe(0);
});

it('keeps the original caller deadline during payload admission backoff', async () => {
  const controller = new AbortController(), reason = new Error('original session deadline');
  const read = vi.fn(async () => { setTimeout(() => controller.abort(reason), 10); throw busy(); });
  await expect(retryExactPayloadAdmission(read, controller.signal)).rejects.toBe(reason);
  expect(read).toHaveBeenCalledOnce();
});

it.each([
  new Error('physical HTTP read failed'),
  Object.assign(new Error('physical query timeout'), { code: 'QUERY_DEADLINE_EXCEEDED', outcome: 'unknown' }),
  Object.assign(new Error('copied but not canonical admission error'), { code: 'STORE_SCHEDULER_BUSY', outcome: 'not_started', retryable: true }),
  new StoreSchedulerBusyError('queue_wait_timeout', 'normal', operation),
  new StoreSchedulerBusyError('queue_wait_timeout', 'background', 'sync.responder.exactAssetExport.metadata'),
])('does not replay a physical read or an unrelated rejection: %s', async error => {
  const read = vi.fn(async () => { throw error; });
  await expect(retryExactPayloadAdmission(read)).rejects.toBe(error);
  expect(read).toHaveBeenCalledOnce();
});

it('preserves root verification after payload re-admission', async () => {
  const f = fixture(3), before = f.budget.stats(), original = f.query.getMockImplementation()!;
  let rejected = false;
  f.query.mockImplementation((query, options) => {
    if (options?.source === operation && !rejected) {
      rejected = true;
      f.payload[0]!.object = '"changed while waiting"';
      return Promise.reject(busy());
    }
    return original(query, options);
  });
  await expect(f.cache.acquireEncoded(f)).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
  expect(f.query.mock.calls.filter(([, o]) => o?.source === operation)).toHaveLength(2);
  expect(f.budget.stats()).toEqual(before);
  expect(f.cache.stats().exports).toBe(0);
});
