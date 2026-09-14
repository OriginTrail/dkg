import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoalescingRecurringTask } from '../src/coalescing-recurring-task.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('CoalescingRecurringTask', () => {
  it('drops overlapping requests when the workload selects fixed-cadence semantics', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let passes = 0;
    const runner = new CoalescingRecurringTask({
      requestWhileRunning: 'drop',
      runPass: async () => {
        passes += 1;
        markStarted();
        await gate;
      },
      onError: () => undefined,
      closingMessage: 'test closing',
    });

    expect(runner.request()).toBe(true);
    await started;
    expect(runner.running).toBe(true);
    expect(runner.scheduled).toBe(false);
    expect(runner.request()).toBe(false);
    release();
    await runner.whenIdle();
    expect(passes).toBe(1);
    await runner.close();
    expect(runner.closed).toBe(true);
    expect(runner.running).toBe(false);
    expect(runner.scheduled).toBe(false);
    expect(runner.request()).toBe(false);
  });

  it('does not let frequent live work postpone a periodic retry', async () => {
    vi.useFakeTimers();
    const dirty = new Set(['failed-scope', 'live-scope']);
    const attempts = new Map<string, number>();
    const runner = new CoalescingRecurringTask({
      retryIntervalMs: 1_000,
      runPass: async () => {
        for (const scope of dirty) {
          dirty.delete(scope);
          attempts.set(scope, (attempts.get(scope) ?? 0) + 1);
        }
      },
      onError: () => undefined,
      beforePeriodicPass: () => {
        dirty.add('failed-scope');
        dirty.add('live-scope');
      },
      closingMessage: 'test closing',
    });

    runner.request();
    await runner.whenIdle();
    expect(attempts.get('failed-scope')).toBe(1);
    expect(runner.scheduled).toBe(true);

    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(250);
      dirty.add('live-scope');
      runner.request();
      await runner.whenIdle();
    }
    expect(attempts.get('failed-scope')).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    await runner.whenIdle();
    expect(attempts.get('failed-scope')).toBe(2);
    expect(attempts.get('live-scope')).toBeGreaterThanOrEqual(4);
    await runner.close();
  });

  it('lets a pass retire periodic rearming until a new explicit request', async () => {
    vi.useFakeTimers();
    let passes = 0;
    const runner = new CoalescingRecurringTask({
      retryIntervalMs: 1_000,
      runPass: async () => {
        passes += 1;
        return 'idle';
      },
      onError: () => undefined,
      closingMessage: 'test closing',
    });

    expect(runner.schedule()).toBe(true);
    expect(runner.schedule()).toBe(false);
    expect(runner.scheduled).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await runner.whenIdle();
    expect(runner.scheduled).toBe(false);
    expect(passes).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(passes).toBe(1);

    expect(runner.request()).toBe(true);
    await runner.whenIdle();
    expect(passes).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(passes).toBe(2);
    await runner.close();
  });

  it('clears an armed periodic deadline when an explicit pass becomes idle', async () => {
    vi.useFakeTimers();
    let passes = 0;
    const runner = new CoalescingRecurringTask({
      retryIntervalMs: 1_000,
      runPass: async () => {
        passes += 1;
        return passes === 1 ? 'rearm' : 'idle';
      },
      onError: () => undefined,
      closingMessage: 'test closing',
    });

    runner.request();
    await runner.whenIdle();
    expect(runner.scheduled).toBe(true);

    runner.request();
    await runner.whenIdle();
    expect(passes).toBe(2);
    expect(runner.scheduled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(passes).toBe(2);
    await runner.close();
  });

  it('invalidates an active pass and coalesces exactly one fresh pass', async () => {
    let starts = 0;
    const reasons: unknown[] = [];
    const runner = new CoalescingRecurringTask({
      runPass: async (signal) => {
        starts += 1;
        if (starts === 1) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              reasons.push(signal.reason);
              resolve();
            }, { once: true });
          });
        }
      },
      onError: () => undefined,
      closingMessage: 'test closing',
    });

    runner.request();
    await vi.waitFor(() => expect(starts).toBe(1));
    expect(runner.invalidateAndRequest('state changed')).toBe(true);
    await runner.whenIdle();

    expect(starts).toBe(2);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({ message: 'state changed' });
    await runner.close();
    expect(runner.invalidateAndRequest('too late')).toBe(false);
  });

  it('cancels a pass, drains its physical work, and leaves the task idle', async () => {
    let release!: () => void;
    let signal!: AbortSignal;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runner = new CoalescingRecurringTask({
      retryIntervalMs: 1_000,
      runPass: async (activeSignal) => {
        signal = activeSignal;
        await blocked;
        return 'rearm';
      },
      onError: () => undefined,
      closingMessage: 'test closing',
    });

    runner.request();
    await vi.waitFor(() => expect(signal).toBeDefined());
    let retired = false;
    const draining = runner.cancelAndDrain('policy changed').then(() => { retired = true; });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(retired).toBe(false);
    release();
    await draining;
    expect(runner.running).toBe(false);
    expect(runner.scheduled).toBe(false);
    await runner.close();
  });

  it('supports a pass-specific periodic delay', async () => {
    vi.useFakeTimers();
    let passes = 0;
    const runner = new CoalescingRecurringTask({
      retryIntervalMs: 1_000,
      runPass: async () => {
        passes += 1;
        return passes === 1 ? { rearmAfterMs: 10 } : 'idle';
      },
      onError: () => undefined,
      closingMessage: 'test closing',
    });

    runner.request();
    await runner.whenIdle();
    await vi.advanceTimersByTimeAsync(9);
    expect(passes).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await runner.whenIdle();
    expect(passes).toBe(2);
    await runner.close();
  });

  it('drains close-triggered cancellation without reporting a workload failure', async () => {
    const onError = vi.fn();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const runner = new CoalescingRecurringTask({
      runPass: async (signal) => {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
      onError,
      closingMessage: 'test closing',
    });

    runner.request();
    await started;
    await expect(runner.close()).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a genuine workload rejection that settles while close starts', async () => {
    const onError = vi.fn();
    const failure = new Error('persistence failed');
    let rejectPass!: (reason: unknown) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pass = new Promise<void>((_resolve, reject) => { rejectPass = reject; });
    const runner = new CoalescingRecurringTask({
      runPass: async () => {
        markStarted();
        await pass;
      },
      onError,
      closingMessage: 'test closing',
    });

    runner.request();
    await started;
    rejectPass(failure);
    await runner.close();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
