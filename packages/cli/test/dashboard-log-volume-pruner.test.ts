import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogVolumePruneResult } from '@origintrail-official/dkg-node-ui';
import { startDashboardLogVolumePruner } from '../src/daemon/dashboard-log-volume-pruner.js';

describe('startDashboardLogVolumePruner', () => {
  afterEach(() => vi.useRealTimers());

  it('starts after the boot delay, catches up quickly, logs compaction, and stops cleanly', () => {
    vi.useFakeTimers();
    const results: LogVolumePruneResult[] = [
      { deleted: 25_000, status: 'more' },
      { deleted: 0, status: 'done-compacted' },
    ];
    const calls: number[] = [];
    const logs: string[] = [];
    const handle = startDashboardLogVolumePruner({
      dashDb: {
        pruneLogVolumeBatch: () => {
          calls.push(Date.now());
          return results.shift() ?? { deleted: 0, status: 'done' };
        },
      },
      log: (message) => logs.push(message),
      intervals: {
        initialDelayMs: 100,
        catchupIntervalMs: 20,
        reclaimRetryMs: 50,
        steadyIntervalMs: 1_000,
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
      'Dashboard log-volume cleanup removed 25000 old routine row(s) and compacted node-ui.db',
    ]);

    handle.stop();
    vi.advanceTimersByTime(5_000);
    expect(calls).toHaveLength(2);
  });

  it('retries reclaim-pending and thrown maintenance steps on the retry cadence', () => {
    vi.useFakeTimers();
    const steps: Array<LogVolumePruneResult | Error> = [
      { deleted: 12, status: 'reclaim-pending' },
      new Error('database is locked'),
      { deleted: 0, status: 'done-compacted' },
    ];
    const logs: string[] = [];
    let calls = 0;
    const handle = startDashboardLogVolumePruner({
      dashDb: {
        pruneLogVolumeBatch: () => {
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
      'Dashboard log-volume cleanup deferred: database is locked',
      'Dashboard log-volume cleanup removed 12 old routine row(s) and compacted node-ui.db',
    ]);
    handle.stop();
  });
});
