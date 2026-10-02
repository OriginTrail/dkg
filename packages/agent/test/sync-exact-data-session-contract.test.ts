import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  createResponderExactGraphPagePlanMemo,
  readDurableDataPageWithLease,
  type ExactGraphPagePlanMemo,
} from '../src/sync/responder/graph-plan.js';
import {
  createResponderPageOnlyExactDataSessionMemo,
  type ExactDataPageParams,
  type ExactDataSession,
  type ExactDataSessionMemo,
} from '../src/sync/responder/exact-data-session.js';
import { exactGraphPlanScalarBytes } from '../src/sync/responder/exact-graph-reader.js';
import { createGraphMembershipSnapshot } from '../src/sync/graph-membership-snapshot.js';
import { createSyncResponderSnapshotBudget } from '../src/sync/responder/snapshot-budget.js';

const row = { s: 'urn:session:subject', p: 'urn:predicate', o: '"value"', g: 'urn:session:graph' };
function session(): ExactDataSession {
  return {
    graphPlan: { entries: [{ graph: row.g, rowCount: 1 }], totalRows: 1,
      pagedGraphs: new Set([row.g]), cursors: new Map([[0, null]]) },
    assertCurrent: vi.fn(),
    read: vi.fn(async offset => ({ rows: offset === 0 ? [row] : [] })),
    snapshot: vi.fn(async () => [row]),
  };
}

describe('typed exact DATA session memo contract', () => {
  it('accepts a structural session provider through the compatible DATA property', async () => {
    expectTypeOf<ExactGraphPagePlanMemo>().not.toExtend<ExactDataSessionMemo>();
    expectTypeOf<ReturnType<typeof createResponderExactGraphPagePlanMemo>>().toEqualTypeOf<ExactGraphPagePlanMemo>();
    const value = session();
    const get = vi.fn<ExactDataSessionMemo['get']>(async () => value);
    const store = new OxigraphStore();
    const query = vi.spyOn(store, 'query');
    const params: ExactDataPageParams = { store,
      graphMembership: createGraphMembershipSnapshot([]), contextGraphId: 'structural-session',
      assetUals: ['urn:asset'], sinceBatchId: null, offset: 0, limit: 64, maxPageBytes: 4096,
      exactGraphPlanMemo: { get }, exactGraphPlanCacheKey: 'retained-session' };
    try {
      expect((await readDurableDataPageWithLease(params)).rows).toEqual([row]);
      expect((await readDurableDataPageWithLease({ ...params, offset: 1 })).rows).toEqual([]);
      expect(value.read).toHaveBeenNthCalledWith(1, 0, 64, 4096, undefined);
      expect(value.read).toHaveBeenNthCalledWith(2, 1, 64, 4096, undefined);
      expect(get.mock.calls[1]![2]).toMatchObject({ requireExisting: true });
      expect(query).not.toHaveBeenCalled();
    } finally { query.mockRestore(); await store.close(); }
  });

  it('drains cancelled typed loads and charges the composed graph plan with the unchanged cursor reserve', async () => {
    const budget = createSyncResponderSnapshotBudget({ maxRows: 1, maxBytesEstimate: 2 * 1024 * 1024,
      maxSnapshotRows: 1, maxSnapshotBytesEstimate: 1 });
    const memo = createResponderPageOnlyExactDataSessionMemo(60_000, 2, budget);
    const value = session();
    let resolve!: (value: ExactDataSession) => void;
    const pending = new Promise<ExactDataSession>(settle => { resolve = settle; });
    const controller = new AbortController();
    let settled = false;
    const aborted = memo.get('request-scope', () => pending, { signal: controller.signal });
    const observed = aborted.catch((error: Error) => error).finally(() => { settled = true; });
    controller.abort(new Error('cancelled response'));
    await Promise.resolve();
    expect(settled).toBe(false);
    resolve(value);
    expect(await observed).toMatchObject({ message: 'cancelled response' });
    expect(budget.stats().snapshots).toBe(0);
    expect(await memo.get('request-scope', async () => value, { requireExisting: true })).toBeNull();
    expect(await memo.get('request-scope', async () => value)).toBe(value);
    expect(budget.stats().bytesEstimate).toBe(exactGraphPlanScalarBytes(value.graphPlan) + 256 * 1024);
    const cursors = value.graphPlan.cursors;
    cursors.set(1, { graph: row.g, graphOffset: 1, s: row.s, p: row.p, o: row.o });
    const retained = await memo.get('request-scope', async () => { throw new Error('must retain'); }, { requireExisting: true });
    expect(retained!.graphPlan).toBe(value.graphPlan);
    expect(retained!.graphPlan.cursors).toBe(cursors);
    expect(retained!.graphPlan.cursors.has(1)).toBe(true);
  });
});
