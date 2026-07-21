import { describe, expect, it, vi } from 'vitest';
import {
  CATCHUP_BACKPRESSURE_RETRY_DELAYS_MS,
  retryCatchupPlaneOnBackpressure,
} from '../src/sync/catchup-backpressure-retry.js';

describe('retryCatchupPlaneOnBackpressure', () => {
  it('retries only the local scheduler deferral result', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ deferredBackpressure: 1, marker: 'deferred' })
      .mockResolvedValueOnce({ deferredBackpressure: 0, marker: 'complete' });
    const waits: number[] = [];

    const result = await retryCatchupPlaneOnBackpressure(run, {
      delaysMs: [3, 5],
      wait: async (delayMs) => { waits.push(delayMs); },
    });

    expect(result).toEqual({ deferredBackpressure: 0, marker: 'complete' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([3]);
  });

  it('returns the final deferred result after the bounded retry budget', async () => {
    const run = vi.fn(async () => ({ deferredBackpressure: 1 }));

    const result = await retryCatchupPlaneOnBackpressure(run, {
      wait: async () => {},
    });

    expect(result.deferredBackpressure).toBe(1);
    expect(run).toHaveBeenCalledTimes(CATCHUP_BACKPRESSURE_RETRY_DELAYS_MS.length + 1);
  });

  it('does not retry a clean result', async () => {
    const run = vi.fn(async () => ({ deferredBackpressure: 0 }));

    await retryCatchupPlaneOnBackpressure(run, {
      wait: async () => { throw new Error('must not wait'); },
    });

    expect(run).toHaveBeenCalledTimes(1);
  });
});
