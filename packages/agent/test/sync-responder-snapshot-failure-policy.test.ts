import { describe, expect, it, vi } from 'vitest';
import {
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  createResponderSyncRowListMemo,
  readDurableMetaPage,
} from '../src/sync/responder/graph-plan.js';

const CONTEXT_GRAPH_ID = 'snapshot-failure-policy';

describe('responder immutable-snapshot failure policy', () => {
  it.each([
    ['backend deadline', () => new StoreOperationTimeoutError({
      backend: 'test',
      operation: 'query',
      storeOperation: 'query',
      timeoutMs: 30_000,
    })],
    ['scheduler queue-wait deadline', () => new StoreSchedulerBusyError(
      'queue_wait_timeout',
      'background',
      'sync.responder.readDurableMetaGraphSnapshot',
      { storeOperation: 'query' },
    )],
  ])('propagates a full-snapshot %s without entering mutable OFFSET paging', async (
    _label,
    deadlineError,
  ) => {
    let snapshotQueries = 0;
    const firstError = deadlineError();
    const secondError = deadlineError();
    const query = vi.fn<TripleStore['query']>(async (_sparql, options) => {
      if (options?.source === 'sync.responder.readDurableMetaGraphSnapshot') {
        snapshotQueries += 1;
        throw snapshotQueries === 1 ? firstError : secondError;
      }
      throw new Error(`unexpected store query: ${options?.source ?? 'unknown'}`);
    });
    const store = { query } as TripleStore;
    const memo = createResponderSyncRowListMemo();
    const cacheKey = 'durable-meta:timeout-propagation';

    await expect(readDurableMetaPage({
      store,
      contextGraphId: CONTEXT_GRAPH_ID,
      registeredSubGraphNames: [],
      offset: 0,
      limit: 1,
      rowListMemo: memo,
      rowListCacheKey: cacheKey,
    })).rejects.toBe(firstError);
    await expect(readDurableMetaPage({
      store,
      contextGraphId: CONTEXT_GRAPH_ID,
      registeredSubGraphNames: [],
      offset: 0,
      limit: 1,
      rowListMemo: memo,
      rowListCacheKey: cacheKey,
    })).rejects.toBe(secondError);

    // A transient deadline is neither memoized as intrinsic size evidence nor
    // converted into a mutable ordered page stream. Retry the immutable
    // snapshot and preserve the original operator-visible cause.
    expect(snapshotQueries).toBe(2);
    expect(query.mock.calls.filter(([, options]) =>
      options?.source === 'sync.responder.readDurableMetaRowsPage')).toHaveLength(0);
  });
});
