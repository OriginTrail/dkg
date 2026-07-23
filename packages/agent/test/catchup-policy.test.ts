import { describe, expect, it, vi } from 'vitest';
import {
  CATCHUP_BACKPRESSURE_RETRY_DELAYS_MS,
  FOREGROUND_CATCHUP_SYNC_PRIORITY,
  runCatchupPlanesWithPolicy,
} from '../src/sync/catchup-policy.js';

describe('runCatchupPlanesWithPolicy', () => {
  it('derives foreground priority and retries durable before starting SWM', async () => {
    const order: string[] = [];
    const priorities: Array<number | undefined> = [];
    const waits: number[] = [];
    const syncDurable = vi.fn(async ({ priority }: { priority?: number }) => {
      priorities.push(priority);
      order.push(`durable-${syncDurable.mock.calls.length}`);
      return { deferredBackpressure: syncDurable.mock.calls.length === 1 ? 1 : 0 };
    });
    const syncSharedMemory = vi.fn(async ({ priority }: { priority?: number }) => {
      priorities.push(priority);
      order.push('shared');
      return { deferredBackpressure: 0 };
    });

    const result = await runCatchupPlanesWithPolicy({
      mode: 'foreground',
      includeSharedMemory: true,
      syncDurable,
      syncSharedMemory,
      retryDelaysMs: [3, 5],
      wait: async (delayMs) => { waits.push(delayMs); },
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
    expect(waits).toEqual([3]);
  });

  it('retries only SWM when durable already completed', async () => {
    const syncDurable = vi.fn(async () => ({ deferredBackpressure: 0 }));
    const syncSharedMemory = vi.fn()
      .mockResolvedValueOnce({ deferredBackpressure: 1 })
      .mockResolvedValueOnce({ deferredBackpressure: 0 });

    const result = await runCatchupPlanesWithPolicy({
      mode: 'foreground',
      includeSharedMemory: true,
      syncDurable,
      syncSharedMemory,
      retryDelaysMs: [1],
      wait: async () => {},
    });

    expect(result.shared?.deferredBackpressure).toBe(0);
    expect(syncDurable).toHaveBeenCalledTimes(1);
    expect(syncSharedMemory).toHaveBeenCalledTimes(2);
  });

  it('returns the final durable deferral without starting dependent SWM', async () => {
    const syncDurable = vi.fn(async () => ({ deferredBackpressure: 1 }));
    const syncSharedMemory = vi.fn(async () => ({ deferredBackpressure: 0 }));

    const result = await runCatchupPlanesWithPolicy({
      mode: 'foreground',
      includeSharedMemory: true,
      syncDurable,
      syncSharedMemory,
      wait: async () => {},
    });

    expect(result.durable.deferredBackpressure).toBe(1);
    expect(result.shared).toBeNull();
    expect(syncDurable).toHaveBeenCalledTimes(
      CATCHUP_BACKPRESSURE_RETRY_DELAYS_MS.length + 1,
    );
    expect(syncSharedMemory).not.toHaveBeenCalled();
  });

  it('keeps background catch-up best-effort without retries or priority', async () => {
    const priorities: Array<number | undefined> = [];
    const syncDurable = vi.fn(async ({ priority }: { priority?: number }) => {
      priorities.push(priority);
      return { deferredBackpressure: 1 };
    });
    const syncSharedMemory = vi.fn(async () => ({ deferredBackpressure: 0 }));

    const result = await runCatchupPlanesWithPolicy({
      mode: 'background',
      includeSharedMemory: true,
      syncDurable,
      syncSharedMemory,
      wait: async () => { throw new Error('background mode must not wait'); },
    });

    expect(result.durable.deferredBackpressure).toBe(1);
    expect(result.shared).toBeNull();
    expect(syncDurable).toHaveBeenCalledTimes(1);
    expect(syncSharedMemory).not.toHaveBeenCalled();
    expect(priorities).toEqual([undefined]);
  });
});
