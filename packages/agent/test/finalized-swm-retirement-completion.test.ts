import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeFinalizedSwmRetirement, completeVerifiedVmMarkerRetirement } from '../src/sync/requester/finalized-swm-retirement-completion.js';

const evidence = Object.freeze({ contextGraphId: 'cg', subGraphName: 'code', kaUal: 'ka', assertionVersion: 4n,
  swmGraph: 'graph', agentAddress: 'author', kaNumber: 1n });
afterEach(() => vi.useRealTimers());

describe('finalized SWM retirement completion', () => {
  it.each(['retired', 'already-retired-finalized'] as const)('keeps %s terminal after a marker failure, then retries its exact namespace outside the lock', async (outcome) => {
    vi.useFakeTimers();
    let locked = false;
    let retry!: (signal: AbortSignal) => Promise<void>;
    const marker = vi.fn(async () => { expect(locked).toBe(false); });
    marker.mockImplementationOnce(async () => { expect(locked).toBe(false); throw new Error('store unavailable'); });
    const warn = vi.fn();
    const result = await completeFinalizedSwmRetirement({
      reconcile: async () => { locked = true; await Promise.resolve(); locked = false; return { outcome, retirement: evidence }; },
      retireMarker: marker,
      warn,
      scheduleRetry: (_key, work) => { retry = work; return true; },
    });
    expect(result).toEqual({ outcome, retirement: evidence });
    expect(warn).toHaveBeenCalledOnce();
    const background = retry(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(250);
    await background;
    expect(marker).toHaveBeenCalledTimes(2);
    expect(marker.mock.calls.every(([input]) => input.subGraphName === 'code' && input.assertionVersion === 4n)).toBe(true);
  });

  it('gives a confirmed local publish the same failure and retry rule', async () => {
    vi.useFakeTimers();
    const marker = vi.fn().mockRejectedValueOnce(new Error('store unavailable')).mockResolvedValue(undefined);
    let retry!: (signal: AbortSignal) => Promise<void>;
    await completeVerifiedVmMarkerRetirement({ evidence, retireMarker: marker, warn: vi.fn(),
      scheduleRetry: (_key, work) => { retry = work; return true; } });
    const background = retry(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(250); await background;
    expect(marker).toHaveBeenCalledTimes(2);
  });

  it('keeps successful cleanup terminal even when its warning logger throws', async () => {
    const scheduled = vi.fn(() => true);
    await expect(completeFinalizedSwmRetirement({
      reconcile: async () => ({ outcome: 'retired', retirement: evidence }),
      retireMarker: async () => { throw new Error('marker store unavailable'); },
      warn: () => { throw new Error('logger unavailable'); }, scheduleRetry: scheduled,
    })).resolves.toEqual({ outcome: 'retired', retirement: evidence });
    expect(scheduled).toHaveBeenCalledOnce();
  });

  it('preserves unresolved physical outcomes without attempting the marker', async () => {
    const marker = vi.fn(); const schedule = vi.fn();
    await expect(completeFinalizedSwmRetirement({ reconcile: async () => ({ outcome: 'head-version-mismatch' }),
      retireMarker: marker, warn: vi.fn(), scheduleRetry: schedule })).resolves.toEqual({ outcome: 'head-version-mismatch' });
    expect(marker).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled();
  });

  it('cancels a pending marker retry on shutdown', async () => {
    vi.useFakeTimers();
    const marker = vi.fn().mockRejectedValue(new Error('unavailable'));
    let retry!: (signal: AbortSignal) => Promise<void>;
    await completeVerifiedVmMarkerRetirement({ evidence, retireMarker: marker, warn: vi.fn(),
      scheduleRetry: (_key, work) => { retry = work; return true; } });
    const controller = new AbortController();
    const background = retry(controller.signal).catch((cause: unknown) => cause);
    controller.abort(); await background;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(marker).toHaveBeenCalledOnce();
  });
});
