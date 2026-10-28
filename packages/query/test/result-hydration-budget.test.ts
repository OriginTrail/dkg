import { expect, it, vi } from 'vitest';
import { StoreResponseTooLargeError, type TripleStore } from '@origintrail-official/dkg-storage';
import { createQueryStoreReadContext, QUERY_CATALOG_MAX_RESPONSE_BYTES } from '../src/query-store-read-context.js';

it('separates caller-result hydration from bounded metadata reads while preserving lane and cancellation', async () => {
  const query = vi.fn(async () => ({ type: 'bindings' as const, bindings: [] }));
  const controller = new AbortController();
  const reads = createQueryStoreReadContext({ query } as unknown as TripleStore, {
    maxResponseBytes: 256 * 1024, maxLiteralHydrationBytes: 16_384,
    priority: 'background', source: 'entities', signal: controller.signal,
  });
  await reads.query('result');
  await reads.catalog.query('metadata');
  const discovery = await reads.shared.measure(lane => lane.query('shared'));
  expect(reads.shared.replay(discovery)).toEqual({ type: 'bindings', bindings: [] });
  expect(discovery.byteCount).toBe(Buffer.byteLength(JSON.stringify({ type: 'bindings', bindings: [] })));
  const calls = query.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
  expect(calls[0][1]).toMatchObject({ maxResponseBytes: 256 * 1024, maxLiteralHydrationBytes: 16_384, signal: controller.signal });
  expect(calls[1][1]).toMatchObject({ maxResponseBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES,
    maxLiteralHydrationBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES, signal: controller.signal, priority: 'background', source: 'entities' });
  expect(calls[2][1]).toMatchObject({ maxResponseBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES,
    maxLiteralHydrationBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES, priority: 'background', source: 'entities' });
  expect(calls[2][1].signal).toBeUndefined(); // Shared refresh retains its independent lifetime.
});

it('keeps catalog overflow outside the result-error classification', async () => {
  const error = new StoreResponseTooLargeError(QUERY_CATALOG_MAX_RESPONSE_BYTES, QUERY_CATALOG_MAX_RESPONSE_BYTES + 1);
  const reads = createQueryStoreReadContext({ query: vi.fn().mockRejectedValue(error) } as unknown as TripleStore,
    { maxLiteralHydrationBytes: 16_384 });
  await expect(reads.catalog.query('metadata')).rejects.toBe(error);
  expect(error).not.toHaveProperty('queryPhase');
});
