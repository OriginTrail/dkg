import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoalescingRecurringTask } from '../src/coalescing-recurring-task.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('CoalescingRecurringTask', () => {
  it('owns one joinable job and retires only the completed generation', async () => {
    type Job = { cutoff: number; waiters: number };
    const seen: Job[] = [];
    const runner = new CoalescingRecurringTask<Job>({
      runPass: async (_signal, job) => {
        if (job) seen.push(job);
        return 'idle';
      },
      onError: () => undefined,
      closingMessage: 'test closing',
    });
    const first = runner.updateJob(() => ({ cutoff: 10, waiters: 1 }))!;
    const joined = runner.updateJob((current) => {
      if (!current) throw new Error('expected current job');
      current.cutoff = 20;
      current.waiters += 1;
      return current;
    });

    expect(joined).toBe(first);
    runner.requestNow();
    await runner.whenIdle();
    expect(seen).toEqual([first]);
    expect(first).toEqual({ cutoff: 20, waiters: 2 });
    expect(runner.retireJob({ cutoff: 20, waiters: 2 })).toBe(false);
    expect(runner.retireJob(first)).toBe(true);
    expect(runner.currentJob).toBeUndefined();
    await runner.close();
    expect(runner.updateJob(() => first)).toBeUndefined();
  });

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

  it('replaces an armed deadline with an immediate explicit request', async () => {
    vi.useFakeTimers();
    let passes = 0;
    const runner = new CoalescingRecurringTask({
      runPass: async () => { passes += 1; return 'idle'; },
      onError: () => undefined,
      closingMessage: 'test closing',
    });
    expect(runner.schedule(1_000)).toBe(true);
    expect(runner.requestNow()).toBe(true);
    await runner.whenIdle();
    expect(passes).toBe(1);
    expect(runner.scheduled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(passes).toBe(1);
    await runner.close();
  });

  it('gives cancel-and-drain an AbortError reason and waits for physical retirement', async () => {
    let observed!: AbortSignal;
    let release!: () => void;
    const physical = new Promise<void>(resolve => { release = resolve; });
    const runner = new CoalescingRecurringTask({
      runPass: async signal => { observed = signal; await physical; },
      onError: () => undefined,
      closingMessage: 'test closing',
    });
    runner.request();
    await vi.waitFor(() => expect(observed).toBeDefined());
    let drained = false;
    const draining = runner.cancelAndDrain('policy changed').then(() => { drained = true; });
    expect(observed.aborted).toBe(true);
    expect(observed.reason).toMatchObject({ name: 'AbortError', message: 'policy changed' });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await draining;
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

  it('drains an invalidated pass without rearming and preserves a newer explicit request', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let passes = 0;
    const runner = new CoalescingRecurringTask({
      retryIntervalMs: 1,
      runPass: async () => {
        passes += 1;
        if (passes === 1) await gate;
        return passes === 1 ? { rearmAfterMs: 1 } : 'idle';
      },
      onError: () => undefined,
      closingMessage: 'test closing',
    });
    runner.requestNow();
    await vi.waitFor(() => expect(passes).toBe(1));
    const draining = runner.cancelAndDrain('policy changed');
    runner.requestNow();
    release();
    await draining;
    await runner.whenIdle();
    expect(passes).toBe(2);
    expect(runner.scheduled).toBe(false);
    await runner.close();
  });
});
