import { describe, expect, it, vi } from 'vitest';
import { FinalizedSwmCleanupWorker } from '../src/finalized-swm-cleanup-worker.js';

describe('FinalizedSwmCleanupWorker', () => {
  it('records backlog, marker age, pressure skips and deleted items', async () => {
    let now = 20_000;
    const sweep = vi.fn().mockResolvedValue({
      backlogDepth: 7,
      oldestMarkerAt: 5_000,
      deletedItems: 2,
      pressureSkipped: true,
    });
    const worker = new FinalizedSwmCleanupWorker({
      sweep,
      now: () => now,
      // Keep retry scheduling observable without running another pass.
      setTimer: (() => ({ unref() {} })) as never,
      clearTimer: () => {},
    });

    await worker.runNow();
    expect(worker.snapshot()).toMatchObject({
      backlogDepth: 7,
      oldestMarkerAgeMs: 15_000,
      pressureSkips: 1,
      deletedItems: 2,
      runs: 1,
      lastError: null,
    });
    now += 1_000;
    expect(worker.snapshot().oldestMarkerAgeMs).toBe(16_000);
    await worker.close();
  });

  it('wake is non-blocking and coalesces work while one sweep is in flight', async () => {
    const timers: Array<() => void> = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const sweep = vi.fn(async () => {
      await pending;
      return {
        backlogDepth: 0,
        oldestMarkerAt: null,
        deletedItems: 0,
        pressureSkipped: false,
      };
    });
    const worker = new FinalizedSwmCleanupWorker({
      sweep,
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return { unref() {} };
      }) as never,
      clearTimer: () => {},
    });

    expect(worker.wake()).toBeUndefined();
    expect(sweep).not.toHaveBeenCalled();
    timers.shift()!();
    await Promise.resolve();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(worker.wake()).toBeUndefined();
    expect(worker.wake()).toBeUndefined();
    release();
    await worker.close();
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('contains sweep errors and exposes the last failure', async () => {
    const onError = vi.fn();
    const worker = new FinalizedSwmCleanupWorker({
      sweep: async () => { throw new Error('store unavailable'); },
      onError,
    });

    await expect(worker.runNow()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(worker.snapshot()).toMatchObject({
      runs: 1,
      lastError: 'store unavailable',
    });
    await worker.close();
  });

  it('reschedules a yielded wall-clock slice without counting it as pressure', async () => {
    const timers: Array<{ fn: () => void; delayMs: number }> = [];
    const worker = new FinalizedSwmCleanupWorker({
      sweep: async () => ({
        backlogDepth: 0,
        oldestMarkerAt: null,
        deletedItems: 0,
        pressureSkipped: false,
        budgetExhausted: true,
      }),
      retryDelayMs: 123,
      setTimer: ((fn: () => void, delayMs: number) => {
        timers.push({ fn, delayMs });
        return { unref() {} };
      }) as never,
      clearTimer: () => {},
    });

    await worker.runNow();
    expect(worker.snapshot().pressureSkips).toBe(0);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.delayMs).toBe(123);
    await worker.close();
  });
});
