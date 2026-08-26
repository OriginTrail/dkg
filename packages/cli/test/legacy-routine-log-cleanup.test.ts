import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LegacyRoutineLogCleanupResult } from '@origintrail-official/dkg-node-ui';
import { startLegacyRoutineLogCleanup } from '../src/daemon/legacy-routine-log-cleanup.js';

describe('startLegacyRoutineLogCleanup', () => {
  afterEach(() => vi.useRealTimers());

  it('starts after the boot delay, catches up quickly, and ends after compaction', () => {
    vi.useFakeTimers();
    const results: LegacyRoutineLogCleanupResult[] = [
      { deleted: 25_000, status: 'more' },
      { deleted: 0, status: 'done-compacted' },
    ];
    const calls: number[] = [];
    const logs: string[] = [];
    const handle = startLegacyRoutineLogCleanup({
      dashDb: {
        runLegacyRoutineLogCleanupBatch: () => {
          calls.push(Date.now());
          return results.shift() ?? { deleted: 0, status: 'done' };
        },
      },
      log: (message) => logs.push(message),
      intervals: {
        initialDelayMs: 100,
        catchupIntervalMs: 20,
        reclaimRetryMs: 50,
      },
    });

    vi.advanceTimersByTime(99);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(19);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(2);
    expect(logs).toEqual([
      'Legacy routine-log migration removed 25000 old row(s) and compacted node-ui.db',
    ]);

    // A completed migration is finite work, not a permanent maintenance loop.
    vi.advanceTimersByTime(5_000);
    expect(calls).toHaveLength(2);
    handle.stop();
  });

  it('stop cancels a pending catch-up batch', () => {
    vi.useFakeTimers();
    let calls = 0;
    const handle = startLegacyRoutineLogCleanup({
      dashDb: {
        runLegacyRoutineLogCleanupBatch: () => {
          calls += 1;
          return { deleted: 10, status: 'more' };
        },
      },
      log: () => {},
      intervals: { initialDelayMs: 10, catchupIntervalMs: 20 },
    });

    vi.advanceTimersByTime(10);
    expect(calls).toBe(1);
    handle.stop();
    vi.advanceTimersByTime(1_000);
    expect(calls).toBe(1);
  });

  it('retries reclaim-pending and thrown maintenance steps on the retry cadence', () => {
    vi.useFakeTimers();
    const steps: Array<LegacyRoutineLogCleanupResult | Error> = [
      { deleted: 12, status: 'reclaim-pending' },
      new Error('database is locked'),
      { deleted: 0, status: 'done-compacted' },
    ];
    const logs: string[] = [];
    let calls = 0;
    const handle = startLegacyRoutineLogCleanup({
      dashDb: {
        runLegacyRoutineLogCleanupBatch: () => {
          calls += 1;
          const step = steps.shift() ?? { deleted: 0, status: 'done' as const };
          if (step instanceof Error) throw step;
          return step;
        },
      },
      log: (message) => logs.push(message),
      intervals: { initialDelayMs: 10, reclaimRetryMs: 30 },
    });

    vi.advanceTimersByTime(10);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(30);
    expect(calls).toBe(2);
    vi.advanceTimersByTime(30);
    expect(calls).toBe(3);
    expect(logs).toEqual([
      'Legacy routine-log migration deferred: database is locked',
      'Legacy routine-log migration removed 12 old row(s) and compacted node-ui.db',
    ]);
    handle.stop();
  });
});
