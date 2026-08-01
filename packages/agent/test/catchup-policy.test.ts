import { describe, expect, it, vi } from 'vitest';
import {
  CATCHUP_BACKPRESSURE_BASE_DELAY_MS,
  CATCHUP_BACKPRESSURE_MAX_DELAY_MS,
  FOREGROUND_CATCHUP_SYNC_PRIORITY,
  nextCatchupBackpressureDelayMs,
  runCatchupPlaneWithPolicy,
  runCatchupPlanesWithPolicy,
} from '../src/sync/catchup-policy.js';

/**
 * A virtual clock whose `wait` advances the clock by exactly the requested
 * delay. This makes the wall-clock retry budget deterministic: the number of
 * attempts is a pure function of the injected budget and the backoff curve.
 */
function virtualClock(startMs = 1_000) {
  let nowMs = startMs;
  const waits: number[] = [];
  return {
    waits,
    now: () => nowMs,
    wait: async (delayMs: number) => {
      waits.push(delayMs);
      nowMs += delayMs;
    },
    elapsed: () => nowMs - startMs,
  };
}

describe('runCatchupPlanesWithPolicy', () => {
  it('derives foreground priority and source and retries durable before starting SWM', async () => {
    const order: string[] = [];
    const priorities: Array<number | undefined> = [];
    const sources: Array<string | undefined> = [];
    const clock = virtualClock();
    const syncDurable = vi.fn(async ({ priority, source }: { priority?: number; source?: string }) => {
      priorities.push(priority);
      sources.push(source);
      order.push(`durable-${syncDurable.mock.calls.length}`);
      return { deferredBackpressure: syncDurable.mock.calls.length === 1 ? 1 : 0 };
    });
    const syncSharedMemory = vi.fn(async ({ priority, source }: { priority?: number; source?: string }) => {
      priorities.push(priority);
      sources.push(source);
      order.push('shared');
      return { deferredBackpressure: 0 };
    });

    const result = await runCatchupPlanesWithPolicy({
      mode: 'foreground',
      includeSharedMemory: true,
      syncDurable,
      syncSharedMemory,
      now: clock.now,
      wait: clock.wait,
      random: () => 0,
    });

    expect(result).toEqual({
      durable: { deferredBackpressure: 0 },
      shared: { deferredBackpressure: 0 },
    });
    expect(order).toEqual(['durable-1', 'durable-2', 'shared']);
    expect(priorities).toEqual([
      FOREGROUND_CATCHUP_SYNC_PRIORITY,
      FOREGROUND_CATCHUP_SYNC_PRIORITY,
      FOREGROUND_CATCHUP_SYNC_PRIORITY,
    ]);
    expect(sources).toEqual([
      'catchup-foreground',
      'catchup-foreground',
      'catchup-foreground',
    ]);
    expect(clock.waits).toEqual([CATCHUP_BACKPRESSURE_BASE_DELAY_MS]);
  });

  it('retries only SWM when durable already completed', async () => {
    const clock = virtualClock();
    const syncDurable = vi.fn(async () => ({ deferredBackpressure: 0 }));
    const syncSharedMemory = vi.fn()
      .mockResolvedValueOnce({ deferredBackpressure: 1 })
      .mockResolvedValueOnce({ deferredBackpressure: 0 });

    const result = await runCatchupPlanesWithPolicy({
      mode: 'foreground',
      includeSharedMemory: true,
      syncDurable,
      syncSharedMemory,
      now: clock.now,
      wait: clock.wait,
    });

    expect(result.shared?.deferredBackpressure).toBe(0);
    expect(syncDurable).toHaveBeenCalledTimes(1);
    expect(syncSharedMemory).toHaveBeenCalledTimes(2);
  });

  it('retries a deferred plane on a wall-clock budget, not a fixed attempt count', async () => {
    // Before #2006 the budget was the fixed ladder [100, 250, 500] — exactly
    // four attempts totalling 850 ms — against measured sync-global queue waits
    // of 87-109 s, so a refused foreground admission could never outlast the
    // head of the queue. The budget is now wall-clock.
    const clock = virtualClock();
    const syncDurable = vi.fn(async () => ({ deferredBackpressure: 1 }));
    const syncSharedMemory = vi.fn(async () => ({ deferredBackpressure: 0 }));

    const result = await runCatchupPlanesWithPolicy({
      mode: 'foreground',
      includeSharedMemory: true,
      syncDurable,
      syncSharedMemory,
      retry: { maxWaitMs: 90_000 },
      now: clock.now,
      wait: clock.wait,
      random: () => 0,
    });

    expect(result.durable.deferredBackpressure).toBe(1);
    expect(result.shared).toBeNull();
    expect(syncSharedMemory).not.toHaveBeenCalled();
    // Far past the four attempts the fixed ladder allowed.
    expect(syncDurable.mock.calls.length).toBeGreaterThan(4);
    // …and bounded by the budget rather than running forever.
    expect(clock.elapsed()).toBeLessThanOrEqual(90_000);
    expect(clock.waits.reduce((sum, value) => sum + value, 0)).toBe(clock.elapsed());
  });

  it('never sleeps past the retry deadline', async () => {
    const clock = virtualClock();
    const deadlineMs = 1_000;
    const syncDurable = vi.fn(async () => ({ deferredBackpressure: 1 }));
    const startedAt = clock.now();

    await runCatchupPlaneWithPolicy('foreground', syncDurable, {
      retry: { maxWaitMs: deadlineMs },
      now: clock.now,
      wait: clock.wait,
      random: () => 1,
    });

    expect(clock.elapsed()).toBeLessThanOrEqual(deadlineMs);
    expect(clock.now() - startedAt).toBeLessThanOrEqual(deadlineMs);
    expect(syncDurable.mock.calls.length).toBeGreaterThan(1);
  });

  it('gives up immediately when no retry budget remains', async () => {
    const clock = virtualClock();
    const syncDurable = vi.fn(async () => ({ deferredBackpressure: 1 }));

    const result = await runCatchupPlaneWithPolicy('foreground', syncDurable, {
      retry: { maxWaitMs: 0 },
      now: clock.now,
      wait: clock.wait,
    });

    expect(result.deferredBackpressure).toBe(1);
    expect(syncDurable).toHaveBeenCalledTimes(1);
    expect(clock.waits).toEqual([]);
  });

  it('retries only planes deferred by local admission backpressure', async () => {
    // A timeout or transport failure is not scheduler pressure: retrying it
    // here would multiply exactly the traffic issue #2006 is about.
    const clock = virtualClock();
    const syncDurable = vi.fn(async () => ({
      deferredBackpressure: 0,
      timedOutPhases: 1,
      failedPeers: 1,
    }));

    await runCatchupPlaneWithPolicy('foreground', syncDurable, {
      retry: { maxWaitMs: 600_000 },
      now: clock.now,
      wait: clock.wait,
    });

    expect(syncDurable).toHaveBeenCalledTimes(1);
    expect(clock.waits).toEqual([]);
  });

  it('keeps background catch-up best-effort without retries, priority, or a foreground source', async () => {
    const priorities: Array<number | undefined> = [];
    const sources: Array<string | undefined> = [];
    const syncDurable = vi.fn(async ({ priority, source }: { priority?: number; source?: string }) => {
      priorities.push(priority);
      sources.push(source);
      return { deferredBackpressure: 1 };
    });
    const syncSharedMemory = vi.fn(async () => ({ deferredBackpressure: 0 }));

    const result = await runCatchupPlanesWithPolicy({
      mode: 'background',
      includeSharedMemory: true,
      syncDurable,
      syncSharedMemory,
      retry: { maxWaitMs: 600_000 },
      wait: async () => { throw new Error('background mode must not wait'); },
    });

    expect(result.durable.deferredBackpressure).toBe(1);
    expect(result.shared).toBeNull();
    expect(syncDurable).toHaveBeenCalledTimes(1);
    expect(syncSharedMemory).not.toHaveBeenCalled();
    expect(priorities).toEqual([undefined]);
    expect(sources).toEqual(['catchup-background']);
  });
});

describe('nextCatchupBackpressureDelayMs', () => {
  it('grows exponentially and clamps at the per-step ceiling', () => {
    const delays = Array.from({ length: 8 }, (_, attempt) => nextCatchupBackpressureDelayMs({
      attempt,
      remainingMs: Number.MAX_SAFE_INTEGER,
      random: () => 0,
    }));

    expect(delays[0]).toBe(CATCHUP_BACKPRESSURE_BASE_DELAY_MS);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
    expect(delays.at(-1)).toBe(CATCHUP_BACKPRESSURE_MAX_DELAY_MS);
  });

  it('applies jitter so parallel receivers do not retry in lockstep', () => {
    const low = nextCatchupBackpressureDelayMs({ attempt: 3, remainingMs: 1e9, random: () => 0 });
    const high = nextCatchupBackpressureDelayMs({ attempt: 3, remainingMs: 1e9, random: () => 1 });

    expect(low).toBeLessThan(high!);
    expect(low).toBeGreaterThanOrEqual(CATCHUP_BACKPRESSURE_BASE_DELAY_MS);
  });

  it('never returns a delay that overshoots the remaining budget', () => {
    expect(nextCatchupBackpressureDelayMs({ attempt: 10, remainingMs: 40, random: () => 1 })).toBe(40);
    expect(nextCatchupBackpressureDelayMs({ attempt: 0, remainingMs: 0 })).toBeUndefined();
    expect(nextCatchupBackpressureDelayMs({ attempt: 0, remainingMs: -5 })).toBeUndefined();
  });
});
