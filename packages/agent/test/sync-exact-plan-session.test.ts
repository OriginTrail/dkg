import { describe, expect, it, vi } from 'vitest';
import { createResponderPageOnlyExactGraphPlanMemo } from '../src/sync/responder/graph-plan.js';
import { createSyncResponderSnapshotBudget } from '../src/sync/responder/snapshot-budget.js';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { SYNC_REQUEST_PAGE_SIZE } from '../src/dkg-agent-constants.js';

function budget(maxBytesEstimate = 2 * 1024 * 1024) {
  return createSyncResponderSnapshotBudget({
    maxRows: 1, maxBytesEstimate, maxSnapshotRows: 1, maxSnapshotBytesEstimate: 1,
  });
}

function plan(graph = 'urn:exact:one') {
  return {
    entries: [{ graph, rowCount: 2 }], totalRows: 2,
    pagedGraphs: new Set([graph]), cursors: new Map([[0, null]]),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('page-only exact plan ownership and bounds', () => {
  it('lets existing requesters immediately rotate a retained token after revision expiry', async () => {
    const tokens: string[] = [];
    let round = 0;
    const params: Parameters<typeof fetchSyncPages>[0] = {
      ctx: { kind: 'system', id: 'exact-expiry', startedAt: Date.now() } as never,
      remotePeerId: 'exact-expiry-peer', contextGraphId: 'exact-expiry-cg',
      includeSharedMemory: false, phase: 'data', graphUri: 'urn:exact-expiry',
      assetUals: ['did:dkg:hardhat:31337/0x0000000000000000000000000000000000000001/1'],
      deadline: Date.now() + 5000, syncPageTimeoutMs: 1000,
      syncRouterAttempts: 1, syncPageRetryAttempts: 1, syncPageSize: SYNC_REQUEST_PAGE_SIZE,
      syncDeniedResponse: '#DENIED', debugSyncProgress: false, protocolSync: '/test/sync',
      checkpointStore: new MemorySyncCheckpointStore(), forceFreshSession: false,
      buildSyncRequest: async (_cg, _offset, _limit, _swm, _peer, _phase, _ref, _batch, token) => {
        tokens.push(token!);
        return new Uint8Array();
      },
      parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
      send: async () => {
        if (round === 0) throw new Error('stream reset');
        if (round === 1) {
          throw new Error('Sync session exact-graph plan expired: store revision changed before page completion');
        }
        return new Uint8Array();
      },
      logWarn: () => {}, logInfo: () => {}, logDebug: () => {},
    };
    await expect(fetchSyncPages(params)).rejects.toThrow('stream reset');
    round = 1;
    await expect(fetchSyncPages(params)).rejects.toThrow('store revision changed');
    round = 2;
    await fetchSyncPages(params);
    expect(tokens).toHaveLength(3);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it('physically drains an aborted load and never admits its late result', async () => {
    const retained = budget();
    const memo = createResponderPageOnlyExactGraphPlanMemo(1000, 2, retained);
    const load = deferred<ReturnType<typeof plan>>();
    const controller = new AbortController();
    let settled = false;
    const result = memo.get('peer/cg/selection/token', () => load.promise, { signal: controller.signal });
    const observed = result.catch((error: Error) => error).finally(() => { settled = true; });
    controller.abort(new Error('owned cancellation'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(retained.stats().snapshots).toBe(0);
    load.resolve(plan());
    expect((await observed as Error).message).toBe('owned cancellation');
    expect(retained.stats().snapshots).toBe(0);
    expect(await memo.get('peer/cg/selection/token', () => Promise.resolve(plan()), {
      requireExisting: true,
    })).toBeNull();
  });

  it('drains an older pending refresh before loading a replacement plan', async () => {
    const memo = createResponderPageOnlyExactGraphPlanMemo(1000, 2, budget());
    const oldLoad = deferred<ReturnType<typeof plan>>();
    const old = memo.get('same-scope', () => oldLoad.promise);
    const replacementLoader = vi.fn(async () => plan('urn:exact:new'));
    const fresh = memo.get('same-scope', replacementLoader, { refresh: true });
    await Promise.resolve();
    expect(replacementLoader).not.toHaveBeenCalled();
    oldLoad.resolve(plan('urn:exact:old'));
    expect((await old)?.entries[0].graph).toBe('urn:exact:old');
    expect((await fresh)?.entries[0].graph).toBe('urn:exact:new');
    expect(replacementLoader).toHaveBeenCalledOnce();
  });

  it('reserves cursor bytes globally and enforces entry bounds at concurrent settlement', async () => {
    const retained = budget();
    const memo = createResponderPageOnlyExactGraphPlanMemo(1000, 1, retained);
    const a = deferred<ReturnType<typeof plan>>();
    const b = deferred<ReturnType<typeof plan>>();
    const first = memo.get('a', () => a.promise);
    const second = memo.get('b', () => b.promise);
    a.resolve(plan('urn:a'));
    await first;
    b.resolve(plan('urn:b'));
    await second;
    expect(retained.stats().snapshots).toBe(1);
    expect(retained.stats().bytesEstimate).toBeGreaterThanOrEqual(256 * 1024);
    expect(await memo.get('a', () => Promise.resolve(plan()), { requireExisting: true })).toBeNull();
    expect((await memo.get('b', () => Promise.resolve(plan()), { requireExisting: true }))?.entries[0].graph)
      .toBe('urn:b');
  });

  it('rejects oversized plan scalars without retaining them', async () => {
    const retained = budget();
    const memo = createResponderPageOnlyExactGraphPlanMemo(1000, 2, retained);
    await expect(memo.get('large', async () => plan(`urn:${'x'.repeat(300_000)}`)))
      .rejects.toThrow('snapshot');
    expect(retained.stats().snapshots).toBe(0);
  });
});
