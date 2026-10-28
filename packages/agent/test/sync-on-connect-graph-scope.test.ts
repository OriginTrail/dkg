import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AuthorityAcceptedCatchupBatch,
  graphScopedSyncOnConnectPeerOutcome,
  syncOnConnectGraphScopeCovers,
  widenSyncOnConnectGraphScope,
} from '../src/sync/on-connect/graph-scope.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('sync-on-connect graph scope', () => {
  it('treats the whole scope as covering every request and no graph set as covering it', () => {
    expect(syncOnConnectGraphScopeCovers(null, null)).toBe(true);
    expect(syncOnConnectGraphScopeCovers(null, new Set(['cg-a']))).toBe(true);
    expect(syncOnConnectGraphScopeCovers(new Set(['cg-a']), null)).toBe(false);
    expect(syncOnConnectGraphScopeCovers(new Set(['cg-a', 'cg-b']), new Set(['cg-b']))).toBe(true);
    expect(syncOnConnectGraphScopeCovers(new Set(['cg-a']), new Set(['cg-a', 'cg-b']))).toBe(false);
    expect(syncOnConnectGraphScopeCovers(new Set(), new Set())).toBe(true);
  });

  it('widens to the union, to the whole scope, or keeps a covering scope as is', () => {
    const current = new Set(['cg-a']);
    expect(widenSyncOnConnectGraphScope(current, new Set(['cg-a']))).toBe(current);
    expect(widenSyncOnConnectGraphScope(null, new Set(['cg-a']))).toBeNull();
    expect(widenSyncOnConnectGraphScope(current, null)).toBeNull();
    const union = widenSyncOnConnectGraphScope(current, new Set(['cg-b']));
    expect(union).toEqual(new Set(['cg-a', 'cg-b']));
    expect(current).toEqual(new Set(['cg-a']));
  });

  it('keeps a graph-scoped pass from marking the peer fresh or recording peer progress', () => {
    expect(graphScopedSyncOnConnectPeerOutcome({
      reconcilerDisposition: 'clear',
      fresh: true,
      progress: true,
    })).toEqual({ reconcilerDisposition: 'clear', fresh: false, progress: false });
    expect(graphScopedSyncOnConnectPeerOutcome({
      reconcilerDisposition: 'retry',
      fresh: false,
      progress: true,
    })).toEqual({ reconcilerDisposition: 'retry', fresh: false, progress: false });
    expect(graphScopedSyncOnConnectPeerOutcome({
      reconcilerDisposition: 'defer',
      fresh: false,
      progress: true,
    })).toEqual({ reconcilerDisposition: 'defer', fresh: false, progress: false });
  });

  it('runs one catch-up for the graphs added in one quiet window and starts a new batch after it', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const batch = new AuthorityAcceptedCatchupBatch(3_000, (contextGraphIds) => {
      batches.push([...contextGraphIds].sort());
    });

    batch.add('cg-b');
    await vi.advanceTimersByTimeAsync(2_000);
    // A second graph restarts the window.
    batch.add('cg-a');
    batch.add('cg-b');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(batches).toEqual([['cg-a', 'cg-b']]);

    batch.add('cg-c');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(batches).toEqual([['cg-a', 'cg-b'], ['cg-c']]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(batches).toHaveLength(2);
  });
});
