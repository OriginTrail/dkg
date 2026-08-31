// map-with-concurrency.test.ts
//
// Pins the catch-up fan-out cap (2026-07-07 sync-storm mitigation): results
// stay in input order and one-per-item (so the downstream aggregation is
// unchanged), and no more than `limit` callbacks are ever in flight (so a
// high-degree node's subscribe round can't flood its own store).
import { describe, it, expect } from 'vitest';
import {
  mapWithConcurrency,
  mapWithConcurrencySettled,
} from '../src/map-with-concurrency.js';
import { CATCHUP_MAX_CONCURRENT_PEER_SYNCS } from '../src/sync/catchup-concurrency.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('mapWithConcurrency', () => {
  it('preserves input order and shape regardless of completion order', async () => {
    const out = await mapWithConcurrency([10, 20, 30, 40], 2, async (n, i) => {
      // Later items resolve FIRST — output must still be in input order.
      await new Promise((r) => setTimeout(r, (4 - i) * 5));
      return n * 2;
    });
    expect(out).toEqual([20, 40, 60, 80]);
  });

  it('never runs more than `limit` callbacks concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually parallel, not accidentally serial
  });

  it('runs every item exactly once', async () => {
    const seen = new Set<number>();
    let calls = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    await mapWithConcurrency(items, 5, async (n) => {
      calls++;
      seen.add(n);
      await tick();
      return n;
    });
    expect(calls).toBe(50);
    expect(seen.size).toBe(50);
  });

  it('degrades to plain Promise.all when limit >= length or <= 0 (unbounded parity)', async () => {
    let peak = 0;
    let inFlight = 0;
    const run = (limit: number) =>
      mapWithConcurrency([1, 2, 3], limit, async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
        return n;
      });
    peak = 0; inFlight = 0;
    expect(await run(10)).toEqual([1, 2, 3]);
    expect(peak).toBe(3); // all at once
    peak = 0; inFlight = 0;
    expect(await run(0)).toEqual([1, 2, 3]);
    expect(peak).toBe(3);
  });

  it('empty input returns empty array without calling fn', async () => {
    let called = false;
    const out = await mapWithConcurrency([], 4, async () => { called = true; return 1; });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('propagates a rejection like Promise.all (callers isolate inside fn)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('settles every bounded callback and preserves fulfillment and rejection order', async () => {
    let inFlight = 0;
    let peak = 0;
    const settled = await mapWithConcurrencySettled([1, 2, 3, 4], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      if (n % 2 === 0) throw new Error(`failed ${n}`);
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(settled).toEqual([
      { status: 'fulfilled', value: 10 },
      { status: 'rejected', reason: new Error('failed 2') },
      { status: 'fulfilled', value: 30 },
      { status: 'rejected', reason: new Error('failed 4') },
    ]);
  });

  it('default concurrency is a small positive cap', () => {
    expect(CATCHUP_MAX_CONCURRENT_PEER_SYNCS).toBeGreaterThan(0);
    expect(CATCHUP_MAX_CONCURRENT_PEER_SYNCS).toBeLessThanOrEqual(16);
  });
});
