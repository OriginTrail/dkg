import { describe, it, expect } from 'vitest';
import { ttlMemo, METRIC_COUNT_TTL_MS, parseRdfInt } from '../src/daemon/metrics-queries.js';

// R6-B: the metric COUNT getters are wrapped in ttlMemo so the daemon's 30s
// metrics tick (and on-demand /api/status reads) re-run each data-proportional
// full-scan COUNT at most once per TTL window, instead of every tick.
describe('ttlMemo (R6-B)', () => {
  it('serves the cached value within the TTL window (one underlying call)', async () => {
    let now = 1000;
    let calls = 0;
    const memo = ttlMemo(async () => { calls++; return 42; }, 100, () => now);

    expect(await memo()).toBe(42);
    now = 1050; // still inside the 100ms window
    expect(await memo()).toBe(42);
    expect(calls).toBe(1); // second call hit the cache
  });

  it('re-queries after the TTL expires', async () => {
    let now = 1000;
    let calls = 0;
    let value = 1;
    const memo = ttlMemo(async () => { calls++; return value; }, 100, () => now);

    expect(await memo()).toBe(1);
    value = 2;
    now = 1100; // at the expiry boundary (>= ttl) -> re-query
    expect(await memo()).toBe(2);
    expect(calls).toBe(2);
  });

  it('coalesces concurrent calls onto a single in-flight call', async () => {
    let now = 1000;
    let calls = 0;
    let release!: (v: number) => void;
    const memo = ttlMemo(
      () => { calls++; return new Promise<number>((r) => { release = r; }); },
      100,
      () => now,
    );

    const p1 = memo();
    const p2 = memo();
    expect(calls).toBe(1); // second call joined the in-flight promise
    release(7);
    expect(await p1).toBe(7);
    expect(await p2).toBe(7);
  });

  it('does not cache a rejection — the next call retries', async () => {
    let now = 1000;
    let calls = 0;
    const memo = ttlMemo(
      async () => { calls++; if (calls === 1) throw new Error('boom'); return 99; },
      100,
      () => now,
    );

    await expect(memo()).rejects.toThrow('boom');
    expect(await memo()).toBe(99); // retried, not a cached error
    expect(calls).toBe(2);
  });

  it('keeps the count TTL below the 30s collector cadence so snapshots are not masked', () => {
    // R6-B (review round 1): a TTL >= the 30s tick would let stale "healthy"
    // counts hide a store outage across multiple snapshots. Staying under it
    // means every periodic snapshot re-reads the store.
    expect(METRIC_COUNT_TTL_MS).toBeGreaterThan(0);
    expect(METRIC_COUNT_TTL_MS).toBeLessThan(30_000);
  });
});

// Guard the shared COUNT parser the memoized getters depend on.
describe('parseRdfInt', () => {
  it('parses RDF typed-integer literals and bare numbers, defaulting to 0', () => {
    expect(parseRdfInt('"1000"^^<http://www.w3.org/2001/XMLSchema#integer>')).toBe(1000);
    expect(parseRdfInt('42')).toBe(42);
    expect(parseRdfInt(undefined)).toBe(0);
    expect(parseRdfInt('not-a-number')).toBe(0);
  });
});
