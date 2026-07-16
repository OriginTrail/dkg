import { afterEach, describe, it, expect, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  createResponderSyncRowListMemo,
  readDurableMetaPage,
  SyncRowSnapshotLimitError,
  type SyncRowListMemo,
} from '../src/sync/responder/graph-plan.js';
import {
  SYNC_RESPONDER_DURABLE_DATA_SNAPSHOT_LIMIT,
  SYNC_RESPONDER_DURABLE_META_SNAPSHOT_LIMIT,
  SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
  SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT,
  SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
  SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT,
  SYNC_RESPONDER_SHARED_MEMORY_SNAPSHOT_LIMIT,
  resolveSyncResponderSnapshotBudgetOptions,
  resolveSyncResponderSnapshotPolicy,
} from '../src/sync/responder/sync-handler.js';
import {
  createSyncResponderSnapshotBudget,
  SyncRowSnapshotBudgetError,
} from '../src/sync/responder/snapshot-budget.js';
import { estimateStringRowHeapBytes } from '../src/sync/memory-telemetry.js';
import { DKG_NS } from './_helpers/sync-responder.js';

// Unit tests for the responder snapshot memo + shared retention budget. Split
// out of sync-responder-concurrent-interleaving.test.ts (which now holds only
// handler-level pagination/interleaving scenarios) so cache/budget behaviour
// lives next to its abstraction.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sync responder snapshot budget defaults', () => {
  it('keeps responder snapshot defaults above the generic memo fallback', () => {
    expect(SYNC_RESPONDER_DURABLE_DATA_SNAPSHOT_LIMIT).toBe(128);
    expect(SYNC_RESPONDER_DURABLE_META_SNAPSHOT_LIMIT).toBe(64);
    expect(SYNC_RESPONDER_SHARED_MEMORY_SNAPSHOT_LIMIT).toBe(64);
    expect(SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT).toBe(750_000);
    expect(SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT).toBe(384 * 1024 * 1024);
    expect(SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT).toBe(250_000);
    expect(SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT).toBe(128 * 1024 * 1024);
    expect(resolveSyncResponderSnapshotBudgetOptions(undefined, {})).toEqual({
      maxRows: SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT,
      maxBytesEstimate: SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
      maxSnapshotRows: SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT,
      maxSnapshotBytesEstimate: SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
    });
  });

  it('allows operators to override every responder snapshot budget limit', () => {
    expect(resolveSyncResponderSnapshotBudgetOptions(undefined, {
      DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT: '101',
      DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT: '202',
      DKG_SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT: '99',
      DKG_SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT: '199',
    })).toEqual({
      maxRows: 101,
      maxBytesEstimate: 202,
      maxSnapshotRows: 99,
      maxSnapshotBytesEstimate: 199,
    });
  });

  it('resolves config per leaf and lets valid environment leaves override it', () => {
    expect(resolveSyncResponderSnapshotBudgetOptions({
      global: { rows: 500, bytesEstimate: 600 },
      local: { rows: 300, bytesEstimate: 400 },
    }, {
      DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT: '450',
      DKG_SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT: '350',
    })).toEqual({
      maxRows: 450,
      maxBytesEstimate: 600,
      maxSnapshotRows: 300,
      maxSnapshotBytesEstimate: 350,
    });
  });

  it('warns for invalid env leaves, falls through to config, and clamps local to global', () => {
    const warnings: string[] = [];
    const resolved = resolveSyncResponderSnapshotPolicy({
      global: { rows: 100, bytesEstimate: 200 },
      local: { rows: 150, bytesEstimate: 250 },
    }, {
      DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT: 'invalid',
      DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT: '',
    }, (message) => warnings.push(message));
    expect(resolved).toEqual({
      budget: {
        maxRows: 100,
        maxBytesEstimate: 200,
        maxSnapshotRows: 100,
        maxSnapshotBytesEstimate: 200,
      },
      localRowsClamped: true,
      localBytesEstimateClamped: true,
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT');
  });
});

describe('sync responder snapshot cache and budget', () => {
  it('reloads a new session after an older snapshot load is already in flight', async () => {
    const memo = createResponderSyncRowListMemo(10_000);
    const oldLoad = deferred<readonly {
      s: string;
      p: string;
      o: string;
      g: string;
    }[]>();
    let freshLoads = 0;

    const oldSession = memo.get('durable-meta:peer:cg', () => oldLoad.promise, {
      refresh: true,
      refreshGeneration: 'session-before-approval',
    });
    const freshSession = memo.get('durable-meta:peer:cg', async () => {
      freshLoads++;
      return [{
        s: 'urn:memo:fresh',
        p: `${DKG_NS}label`,
        o: '"fresh-after-approval"',
        g: 'urn:memo:graph',
      }];
    }, {
      refresh: true,
      refreshGeneration: 'session-after-approval',
    });

    // The new session must wait for the old store read rather than coalescing
    // onto it, and must perform its own read afterwards.
    await Promise.resolve();
    expect(freshLoads).toBe(0);
    oldLoad.resolve([{
      s: 'urn:memo:stale',
      p: `${DKG_NS}label`,
      o: '"stale-before-approval"',
      g: 'urn:memo:graph',
    }]);

    await expect(oldSession).resolves.toMatchObject([
      { o: '"stale-before-approval"' },
    ]);
    await expect(freshSession).resolves.toMatchObject([
      { o: '"fresh-after-approval"' },
    ]);
    expect(freshLoads).toBe(1);

    await expect(memo.get(
      'durable-meta:peer:cg',
      async () => { throw new Error('cached snapshot should be reused'); },
    )).resolves.toMatchObject([{ o: '"fresh-after-approval"' }]);
  });

  it('does not reuse an older generation when a refresh load fails', async () => {
    const memo = createResponderSyncRowListMemo(10_000);
    const stale = [{
      s: 'urn:memo:stale',
      p: `${DKG_NS}label`,
      o: '"stale-before-approval"',
      g: 'urn:memo:graph',
    }];
    const fresh = [{
      s: 'urn:memo:fresh',
      p: `${DKG_NS}label`,
      o: '"fresh-after-retry"',
      g: 'urn:memo:graph',
    }];

    await expect(memo.get('durable-meta:peer:cg', async () => stale, {
      refresh: true,
      refreshGeneration: 'session-before-approval',
    })).resolves.toBe(stale);
    await expect(memo.get('durable-meta:peer:cg', async () => {
      throw new Error('transient store failure');
    }, {
      refresh: true,
      refreshGeneration: 'session-after-approval',
    })).rejects.toThrow('transient store failure');

    // prepareResponderSession already installed this token, so the transport
    // retry arrives with refresh=false. It must miss the stale generation.
    await expect(memo.get('durable-meta:peer:cg', async () => fresh, {
      refreshGeneration: 'session-after-approval',
    })).resolves.toBe(fresh);
  });

  it('does not reuse an older generation when the refresh waiter aborts', async () => {
    const memo = createResponderSyncRowListMemo(10_000);
    const oldLoad = deferred<readonly {
      s: string;
      p: string;
      o: string;
      g: string;
    }[]>();
    const controller = new AbortController();
    let retryLoads = 0;

    const oldSession = memo.get('durable-meta:peer:cg', () => oldLoad.promise, {
      refresh: true,
      refreshGeneration: 'session-before-approval',
    });
    const abortedRefresh = memo.get('durable-meta:peer:cg', async () => {
      throw new Error('aborted refresh must not start its store load');
    }, {
      refresh: true,
      refreshGeneration: 'session-after-approval',
      signal: controller.signal,
    });
    controller.abort(new Error('request timed out'));
    await expect(abortedRefresh).rejects.toThrow('request timed out');
    // Retry while the old generation is STILL loading. Because the token was
    // already installed, this arrives with refresh=false; generation mismatch
    // must nevertheless wait for and supersede the old in-flight snapshot.
    const retry = memo.get('durable-meta:peer:cg', async () => {
      retryLoads += 1;
      return [{
      s: 'urn:memo:fresh',
      p: `${DKG_NS}label`,
      o: '"fresh-after-retry"',
      g: 'urn:memo:graph',
      }];
    }, {
      refreshGeneration: 'session-after-approval',
    });
    await Promise.resolve();
    expect(retryLoads).toBe(0);

    oldLoad.resolve([{
      s: 'urn:memo:stale',
      p: `${DKG_NS}label`,
      o: '"stale-before-approval"',
      g: 'urn:memo:graph',
    }]);
    await expect(oldSession).resolves.toHaveLength(1);
    await expect(retry).resolves.toMatchObject([{ o: '"fresh-after-retry"' }]);
    expect(retryLoads).toBe(1);
  });

  it('keeps active durable row snapshots alive while pages are still being read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const memo = createResponderSyncRowListMemo(10);
    let loads = 0;
    const loadRows = async () => {
      loads++;
      return [{
        s: 'urn:memo:row',
        p: `${DKG_NS}label`,
        o: `"snapshot-${loads}"`,
        g: 'urn:memo:graph',
      }];
    };

    await expect(memo.get('durable', loadRows)).resolves.toMatchObject([
      { o: '"snapshot-1"' },
    ]);

    vi.setSystemTime(9);
    await expect(memo.get('durable', loadRows)).resolves.toMatchObject([
      { o: '"snapshot-1"' },
    ]);

    vi.setSystemTime(18);
    await expect(memo.get('durable', loadRows)).resolves.toMatchObject([
      { o: '"snapshot-1"' },
    ]);
    expect(loads).toBe(1);
  });

  it('does not rebuild an expired durable row snapshot for the same session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const memo = createResponderSyncRowListMemo(10);
    let loads = 0;
    const loadRows = async () => {
      loads++;
      return [{
        s: 'urn:memo:row',
        p: `${DKG_NS}label`,
        o: `"snapshot-${loads}"`,
        g: 'urn:memo:graph',
      }];
    };

    await expect(memo.get('durable', loadRows)).resolves.toHaveLength(1);

    vi.setSystemTime(11);
    await expect(memo.get('durable', loadRows)).rejects.toThrow(
      'Durable data sync session snapshot expired before page completion',
    );
    expect(loads).toBe(1);
  });

  it('does not retain empty durable row snapshots against the active cap', async () => {
    const memo = createResponderSyncRowListMemo(10_000, 1);
    let emptyLoads = 0;
    let nonEmptyLoads = 0;

    await expect(memo.get('durable:empty', async () => {
      emptyLoads++;
      return [];
    })).resolves.toHaveLength(0);

    await expect(memo.get('durable:non-empty', async () => {
      nonEmptyLoads++;
      return [{
        s: 'urn:memo:row',
        p: `${DKG_NS}label`,
        o: '"snapshot"',
        g: 'urn:memo:graph',
      }];
    })).resolves.toHaveLength(1);

    expect(emptyLoads).toBe(1);
    expect(nonEmptyLoads).toBe(1);
  });

  it('rejects new durable row snapshots at the active cap without evicting existing sessions', async () => {
    const memo = createResponderSyncRowListMemo(10_000, 2);
    let loads = 0;
    const loadRows = async () => {
      loads++;
      return [{
        s: 'urn:memo:row',
        p: `${DKG_NS}label`,
        o: `"snapshot-${loads}"`,
        g: 'urn:memo:graph',
      }];
    };

    await expect(memo.get('durable:session-1', loadRows)).resolves.toHaveLength(1);
    await expect(memo.get('durable:session-2', loadRows)).resolves.toHaveLength(1);
    await expect(memo.get('durable:session-3', loadRows)).rejects.toThrow(
      SyncRowSnapshotLimitError,
    );
    await expect(memo.get('durable:session-3', loadRows)).rejects.toMatchObject({
      key: 'durable:session-3',
      maxEntries: 2,
      cachedEntries: 2,
      inflightEntries: 0,
      activeEntries: 2,
    });

    await expect(
      memo.get('durable:session-1', loadRows, { requireExisting: true }),
    ).resolves.toMatchObject([{ o: '"snapshot-1"' }]);
    expect(loads).toBe(2);
  });

  it('retains the completed snapshot for reuse when the serving request aborts mid-build', async () => {
    // The owner's row load is not abort-aware, so a settled snapshot is the
    // COMPLETE result even if the owner's stream aborted while it was loading.
    // The aborted owner must still reject, but the snapshot it already paid to
    // build must be cached so a later same-session request reuses it instead of
    // issuing a second, redundant store query (regression: PR #1142 discarded it,
    // breaking sync-responder-protection's "keeps row-list cache-miss owners
    // counted until the shared snapshot settles" on the CI ordering).
    const memo = createResponderSyncRowListMemo(10_000, 1);
    const snapshot = deferred<readonly {
      s: string;
      p: string;
      o: string;
      g: string;
    }[]>();
    const controller = new AbortController();
    let loads = 0;
    const loadRows = () => {
      loads += 1;
      return snapshot.promise;
    };

    const first = memo.get('durable:aborted', loadRows, { signal: controller.signal });
    controller.abort(new Error('request aborted'));
    snapshot.resolve([{
      s: 'urn:memo:row',
      p: `${DKG_NS}label`,
      o: '"aborted"',
      g: 'urn:memo:graph',
    }]);

    // The aborting owner still rejects (its stream is gone).
    await expect(first).rejects.toThrow('request aborted');

    // A later same-session reader reuses the cached snapshot — no second load.
    await expect(
      memo.get('durable:aborted', () => {
        throw new Error('snapshot must be reused, not re-loaded');
      }, { requireExisting: true }),
    ).resolves.toHaveLength(1);
    expect(loads).toBe(1);
  });

  it('evicts a released durable row snapshot before blocking new work', async () => {
    const memo = createResponderSyncRowListMemo(10_000, 1);
    const row = {
      s: 'urn:memo:row',
      p: `${DKG_NS}label`,
      o: '"snapshot"',
      g: 'urn:memo:graph',
    };

    await expect(memo.get('durable:complete', async () => [row])).resolves.toHaveLength(1);
    memo.release('durable:complete', { graceMs: 10 });

    await expect(memo.get('durable:blocked', async () => [row])).resolves.toHaveLength(1);
    await expect(
      memo.get('durable:complete', async () => [], { requireExisting: true }),
    ).resolves.toBeNull();
  });

  it('coalesces concurrent durable row snapshot refreshes', async () => {
    const memo = createResponderSyncRowListMemo();
    const snapshot = deferred<readonly {
      s: string;
      p: string;
      o: string;
      g: string;
    }[]>();
    let loads = 0;
    const loadRows = () => {
      loads++;
      return snapshot.promise;
    };

    const first = memo.get('durable', loadRows, { refresh: true });
    const second = memo.get('durable', loadRows, { refresh: true });
    snapshot.resolve([{
      s: 'urn:memo:row',
      p: `${DKG_NS}label`,
      o: '"snapshot"',
      g: 'urn:memo:graph',
    }]);

    await expect(first).resolves.toHaveLength(1);
    await expect(second).resolves.toHaveLength(1);
    expect(loads).toBe(1);
  });

  it('shares one row budget across durable-data, durable-meta, and shared-memory snapshots', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 4,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 4,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const durableData = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });
    const durableMeta = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_meta',
      budget,
    });
    const sharedMemory = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'shared_memory',
      budget,
    });
    const rows = (label: string) => [0, 1].map((index) => ({
      s: `urn:${label}:${index}`,
      p: `${DKG_NS}label`,
      o: `"${label}-${index}"`,
      g: `urn:${label}:graph`,
    }));

    const dataRows = rows('data');
    await expect(durableData.get('data', async () => dataRows)).resolves.toBe(dataRows);
    await expect(durableMeta.get('meta', async () => rows('meta'))).resolves.toHaveLength(2);
    // A hit makes durable-data most recently used; durable-meta is now the LRU.
    await expect(durableData.get('data', async () => [])).resolves.toBe(dataRows);
    durableMeta.release('meta', { graceMs: 10_000 });

    await expect(sharedMemory.get('swm', async () => rows('swm'))).resolves.toHaveLength(2);

    expect(budget.stats()).toEqual({
      snapshots: 2,
      rows: 4,
      bytesEstimate: expect.any(Number),
    });
    await expect(
      durableMeta.get('meta', async () => rows('must-not-reload'), { requireExisting: true }),
    ).resolves.toBeNull();
    await expect(
      durableData.get('data', async () => rows('must-not-reload'), { requireExisting: true }),
    ).resolves.toBe(dataRows);
  });

  it('rejects one oversized snapshot without retaining it or evicting unrelated data', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 10,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 2,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const memo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });
    const makeRows = (count: number) => Array.from({ length: count }, (_, index) => ({
      s: `urn:row:${index}`,
      p: `${DKG_NS}label`,
      o: `"row-${index}"`,
      g: 'urn:graph',
    }));
    const retained = makeRows(2);

    await expect(memo.get('retained', async () => retained)).resolves.toBe(retained);
    await expect(memo.get('oversized', async () => makeRows(3))).rejects.toMatchObject({
      name: SyncRowSnapshotBudgetError.name,
      reason: 'snapshot_rows',
      rows: 3,
    });
    expect(budget.stats()).toMatchObject({ snapshots: 1, rows: 2 });
    await expect(memo.get('retained', async () => [], { requireExisting: true })).resolves.toBe(retained);
  });

  it('repeats a typed budget result for the same rejected session instead of reporting expiry', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 10,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 1,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const memo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });
    let loads = 0;
    const loadRows = async () => {
      loads += 1;
      return [0, 1].map((index) => ({
        s: `urn:retry:${index}`,
        p: `${DKG_NS}label`,
        o: `"retry-${index}"`,
        g: 'urn:retry:graph',
      }));
    };

    await expect(memo.get('same-session', loadRows)).rejects.toMatchObject({
      name: 'SyncRowSnapshotBudgetError',
      reason: 'snapshot_rows',
    });
    await expect(memo.get('same-session', loadRows)).rejects.toMatchObject({
      name: 'SyncRowSnapshotBudgetError',
      reason: 'snapshot_rows',
    });
    expect(loads).toBe(1);
  });

  it('does not resume a superseded snapshot after a refresh exceeds the budget', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 4,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 2,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const memo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });
    const rows = (count: number, label: string) => Array.from({ length: count }, (_, index) => ({
      s: `urn:${label}:${index}`,
      p: `${DKG_NS}label`,
      o: `"${label}-${index}"`,
      g: `urn:${label}:graph`,
    }));
    const original = rows(2, 'original');

    await expect(memo.get('refresh', async () => original)).resolves.toBe(original);
    // The superseding session's page 0 materializes an over-cap snapshot: rejected.
    await expect(
      memo.get('refresh', async () => rows(3, 'oversized'), { refresh: true }),
    ).rejects.toMatchObject({ reason: 'snapshot_rows' });
    // A later page of the SAME (superseding) session must NOT resume the stale
    // 2-row snapshot; it takes the same rejection so the responder falls back
    // consistently for every page instead of mixing two snapshots in one session.
    await expect(
      memo.get('refresh', async () => [], { requireExisting: true }),
    ).rejects.toMatchObject({ reason: 'snapshot_rows' });
    // The superseded snapshot is released from the budget, not retained until TTL.
    expect(budget.stats()).toMatchObject({ snapshots: 0, rows: 0 });
  });

  it('does not resume a superseded snapshot after a refresh hits the global budget', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 4,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 4, // per-snapshot allows the grown snapshot; the GLOBAL cap does not
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const memo = createResponderSyncRowListMemo(10_000, 10, { phase: 'durable_data', budget });
    const other = createResponderSyncRowListMemo(10_000, 10, { phase: 'durable_meta', budget });
    const rows = (count: number, label: string) => Array.from({ length: count }, (_, index) => ({
      s: `urn:${label}:${index}`,
      p: `${DKG_NS}label`,
      o: `"${label}-${index}"`,
      g: `urn:${label}:graph`,
    }));

    // A pinned 2-row snapshot on another memo holds half the global budget.
    await expect(other.get('other', async () => rows(2, 'other'))).resolves.toHaveLength(2);
    // 'key' caches 1 row (global now 3/4, both pinned/active).
    const original = rows(1, 'original');
    await expect(memo.get('key', async () => original)).resolves.toBe(original);

    // Refreshing 'key' to 3 rows needs 2+3 > 4 and cannot evict the pinned peer:
    // a GLOBAL (not per-snapshot) rejection.
    await expect(
      memo.get('key', async () => rows(3, 'grown'), { refresh: true }),
    ).rejects.toMatchObject({ reason: 'global_rows' });

    // A same-token retry (refresh=false) must NOT resume the stale 1-row snapshot;
    // it was dropped, so requireExisting sees no snapshot (and offset 0 re-loads).
    await expect(
      memo.get('key', async () => [], { requireExisting: true }),
    ).resolves.toBeNull();
    // Dropping the superseded snapshot also eases the global pressure.
    expect(budget.stats()).toMatchObject({ rows: 2 });
  });

  it('enforces per-snapshot estimated-byte limits independently of row limits', async () => {
    const row = {
      s: 'urn:bytes:s',
      p: `${DKG_NS}label`,
      o: `"${'x'.repeat(256)}"`,
      g: 'urn:bytes:graph',
    };
    const estimate = estimateStringRowHeapBytes(row.s, row.p, row.o, row.g);
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 100,
      maxBytesEstimate: estimate * 10,
      maxSnapshotRows: 100,
      maxSnapshotBytesEstimate: estimate - 1,
    });
    const memo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });

    await expect(memo.get('byte-heavy', async () => [row])).rejects.toMatchObject({
      reason: 'snapshot_bytes',
      bytesEstimate: estimate,
    });
  });

  it('evicts released snapshots under byte pressure while keeping active snapshots pinned', async () => {
    const makeRow = (label: string) => ({
      s: `urn:${label}:s`,
      p: `${DKG_NS}label`,
      o: `"${'x'.repeat(128)}"`,
      g: `urn:${label}:graph`,
    });
    const estimate = estimateStringRowHeapBytes(
      makeRow('a').s,
      makeRow('a').p,
      makeRow('a').o,
      makeRow('a').g,
    );
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 100,
      maxBytesEstimate: estimate + 32,
      maxSnapshotRows: 100,
      maxSnapshotBytesEstimate: estimate + 32,
    });
    const first = createResponderSyncRowListMemo(10_000, 10, { phase: 'durable_data', budget });
    const second = createResponderSyncRowListMemo(10_000, 10, { phase: 'durable_meta', budget });

    await first.get('first', async () => [makeRow('a')]);
    await expect(second.get('second', async () => [makeRow('b')])).rejects.toMatchObject({
      reason: 'global_bytes',
    });
    await expect(first.get('first', async () => [], { requireExisting: true })).resolves.toHaveLength(1);

    first.release('first', { graceMs: 10_000 });
    await expect(second.get('second', async () => [makeRow('b')])).resolves.toHaveLength(1);
    await expect(first.get('first', async () => [], { requireExisting: true })).resolves.toBeNull();
  });

  it('keeps completed loads from aborted owners inside the shared retained-row budget', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 2,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 2,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const memo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });

    for (let session = 0; session < 5; session += 1) {
      const rows = [0, 1].map((index) => ({
        s: `urn:aborted:${session}:${index}`,
        p: `${DKG_NS}label`,
        o: `"row-${index}"`,
        g: 'urn:aborted:graph',
      }));
      const snapshot = deferred<readonly typeof rows[number][]>();
      const controller = new AbortController();
      const request = memo.get(`aborted:${session}`, () => snapshot.promise, {
        signal: controller.signal,
      });
      controller.abort(new Error('owner disconnected'));
      snapshot.resolve(rows);

      await expect(request).rejects.toThrow('owner disconnected');
      // Join the owner-independent load so its cache admission has settled.
      await expect(
        memo.get(`aborted:${session}`, async () => [], { requireExisting: true }),
      ).resolves.toBe(rows);
      memo.release(`aborted:${session}`, { graceMs: 10_000 });
      expect(budget.stats()).toMatchObject({ snapshots: 1, rows: 2 });
    }
  });

  it('releases the shared budget when a cached snapshot expires by TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 2,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 2,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const memo = createResponderSyncRowListMemo(10, 10, { phase: 'durable_data', budget });
    const rows = (label: string) => [0, 1].map((index) => ({
      s: `urn:${label}:${index}`,
      p: `${DKG_NS}label`,
      o: `"${label}-${index}"`,
      g: `urn:${label}:graph`,
    }));

    await expect(memo.get('a', async () => rows('a'))).resolves.toHaveLength(2);
    expect(budget.stats()).toMatchObject({ snapshots: 1, rows: 2 });

    // Advance past the TTL; the next access prunes the expired entry.
    vi.setSystemTime(11);
    await expect(memo.get('b', async () => [], { requireExisting: true })).resolves.toBeNull();

    // TTL expiry must release the snapshot from the shared budget, so a later
    // session cannot hit a global limit for a snapshot the cache no longer holds.
    expect(budget.stats()).toMatchObject({ snapshots: 0, rows: 0, bytesEstimate: 0 });
  });

  it('extracts a cached page without iterating or copying the complete snapshot', async () => {
    const source = Array.from({ length: 2_000 }, (_, index) => ({
      s: `urn:row:${index}`,
      p: `${DKG_NS}label`,
      o: `"row-${index}"`,
      g: 'urn:graph',
    }));
    const pageStart = 1_000;
    const pageEnd = 1_500; // offset 1000 + limit 500
    let wholeSnapshotIterations = 0;
    let outOfPageIndexReads = 0;
    const snapshot = new Proxy(source, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          wholeSnapshotIterations += 1;
          throw new Error('complete snapshot must not be iterated while extracting one page');
        }
        // A correct slice(offset, offset+limit) reads only in-page element
        // indices (plus non-index props like `length`). Reading any index
        // outside the page is a full-array copy (e.g. `rows.slice()` then slice
        // again, or an indexed clone), which the iterator guard alone misses.
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          const index = Number(property);
          if (index < pageStart || index >= pageEnd) {
            outOfPageIndexReads += 1;
            throw new Error(`page extraction must not read out-of-page index ${index}`);
          }
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const memo: SyncRowListMemo = {
      get: async () => snapshot,
      release: () => {},
    };

    const page = await readDurableMetaPage({
      store: {} as OxigraphStore,
      contextGraphId: 'urn:cg',
      registeredSubGraphNames: [],
      offset: 1_000,
      limit: 500,
      rowListMemo: memo,
      rowListCacheKey: 'cached-page',
    });

    expect(page).toHaveLength(500);
    expect(page[0]?.s).toBe('urn:row:1000');
    expect(wholeSnapshotIterations).toBe(0);
    expect(outOfPageIndexReads).toBe(0);
  });
});
