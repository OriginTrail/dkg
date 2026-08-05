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

  /**
   * Coalescing has two halves and they need separate evidence.
   *
   * The re-wake half — a wake arriving during a sweep is not lost — is already
   * covered by the yielded-slice test below. The half asserted here is that
   * SEVERAL wakes during one sweep collapse to exactly ONE follow-up, which is
   * what stops repeated wake-ups creating overlapping store scans.
   *
   * The previous version of this test closed the worker immediately after
   * releasing the sweep, so the follow-up was cancelled before it could be
   * observed and the whole in-flight branch could be reduced to a bare `return`
   * with this test still green. It now lets the follow-up schedule and fire.
   */
  it('collapses several wakes during one sweep into exactly one follow-up sweep', async () => {
    const timers: Array<{ fn: () => void; delayMs: number }> = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    const sweep = vi.fn(async () => {
      started += 1;
      // Only the first pass blocks; the follow-up must be free to complete.
      if (started === 1) await pending;
      return {
        backlogDepth: 0,
        oldestMarkerAt: null,
        deletedItems: 0,
        pressureSkipped: false,
      };
    });
    const worker = new FinalizedSwmCleanupWorker({
      sweep,
      setTimer: ((fn: () => void, delayMs: number) => {
        timers.push({ fn, delayMs });
        return { unref() {} };
      }) as never,
      clearTimer: () => {},
    });

    expect(worker.wake()).toBeUndefined();
    expect(sweep).not.toHaveBeenCalled();
    timers.shift()!.fn();
    await Promise.resolve();
    expect(sweep).toHaveBeenCalledTimes(1);

    // Three wakes while one sweep is in flight. None may start a sweep, and
    // none may schedule a timer of its own.
    expect(worker.wake()).toBeUndefined();
    expect(worker.wake()).toBeUndefined();
    expect(worker.wake()).toBeUndefined();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0);

    release();
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    // Exactly one follow-up was scheduled for the three coalesced wakes.
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);

    timers.shift()!.fn();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(sweep).toHaveBeenCalledTimes(2);
    // A clean second pass asks for nothing further.
    expect(timers).toHaveLength(0);

    await worker.close();
    expect(sweep).toHaveBeenCalledTimes(2);
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
