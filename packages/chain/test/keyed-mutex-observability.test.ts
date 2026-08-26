import { describe, expect, it, vi } from 'vitest';
import { KeyedSerializer, type KeyedSerializerObservation } from '../src/keyed-mutex.js';

// GH#1574 — acquisition was structurally invisible: a bare promise-chain link
// with no timer, counter or log. Three mainnet publishes logged "Submitting
// V10 on-chain publish tx" and then produced nothing for two hours, because
// every downstream bound (populate, broadcast, receipt) applies AFTER
// acquisition. These pin the diagnostics that make such a wedge visible.

/**
 * `run()` chains its wrapper off the lane tail, so acquisition happens on a
 * microtask. Tests must let that settle before advancing the clock, or they
 * measure from before the holder existed.
 */
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

/** Deferred promise, so a test can hold a lane open deterministically. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<{ stallAfterMs: number }> = {}) {
  const seen: KeyedSerializerObservation[] = [];
  let clock = 0;
  const s = new KeyedSerializer({
    observeAfterMs: 1_000,
    observeIntervalMs: 1_000,
    stallAfterMs: overrides.stallAfterMs ?? 10_000,
    now: () => clock,
    onObserve: (o) => seen.push(o),
  });
  return { s, seen, tick: (ms: number) => { clock += ms; }, clockNow: () => clock };
}

describe('KeyedSerializer observability (GH#1574)', () => {
  it('says nothing while a lane is uncontended', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness();
      const d = deferred();
      const p = s.run('0xwallet', () => d.promise, 'publish');
      tick(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      // A single holder under the observe threshold is ordinary.
      d.resolve();
      await p;
      expect(seen.filter((o) => o.kind === 'wait')).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('reports a waiter that is queued behind a long holder', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness();
      const holder = deferred();
      const first = s.run('0xwallet', () => holder.promise, 'approve');
      const second = s.run('0xwallet', async () => 'ok', 'publish');
      await settle();

      tick(3_000);
      await vi.advanceTimersByTimeAsync(3_000);

      const waits = seen.filter((o) => o.kind === 'wait');
      expect(waits.length).toBeGreaterThan(0);
      const w = waits[0]!;
      expect(w.key).toBe('0xwallet');
      expect(w.label).toBe('publish');
      expect(w.positionsAhead).toBe(1);
      // Names WHAT is holding the lane — the thing an operator needs.
      expect(w.holderLabel).toBe('approve');
      expect(w.stalled).toBe(false);

      holder.resolve();
      await first; await second;
    } finally { vi.useRealTimers(); }
  });

  it('marks a wait as stalled only past the stall threshold', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness({ stallAfterMs: 10_000 });
      const holder = deferred();
      const first = s.run('0xw', () => holder.promise, 'approve');
      const second = s.run('0xw', async () => 'ok', 'publish');
      await settle();

      tick(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(seen.filter((o) => o.kind === 'wait' && o.stalled)).toHaveLength(0);

      tick(8_000);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(seen.filter((o) => o.kind === 'wait' && o.stalled).length).toBeGreaterThan(0);

      holder.resolve();
      await first; await second;
    } finally { vi.useRealTimers(); }
  });

  it('reports a HOLDER that never settles, even with nothing queued behind it', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness();
      const holder = deferred();
      const p = s.run('0xw', () => holder.promise, 'publish');
      await settle();

      tick(4_000);
      await vi.advanceTimersByTimeAsync(4_000);

      const holds = seen.filter((o) => o.kind === 'hold');
      expect(holds.length).toBeGreaterThan(0);
      expect(holds[0]!.label).toBe('publish');

      holder.resolve();
      await p;
    } finally { vi.useRealTimers(); }
  });

  it('stops reporting a waiter the moment it acquires, mid-flight', async () => {
    // The discriminating shape: the waiter must ALREADY be past the observe
    // threshold (so its interval is armed and firing) and then acquire. A test
    // that hands over before the threshold never arms the timer and cannot
    // catch a clear that happens after the await instead of synchronously.
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness();
      const holder = deferred();
      const inner = deferred();
      const first = s.run('0xw', () => holder.promise, 'approve');
      const second = s.run('0xw', () => inner.promise, 'publish');
      await settle();

      // Wait long enough that 'publish' is being reported as waiting.
      tick(4_000);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(seen.filter((o) => o.kind === 'wait' && o.label === 'publish').length)
        .toBeGreaterThan(0);
      const waitLinesAtHandover = seen.filter((o) => o.kind === 'wait' && o.label === 'publish').length;

      // Hand the lane over. 'publish' now HOLDS it and keeps holding.
      holder.resolve();
      await first;
      await settle();

      tick(30_000);
      await vi.advanceTimersByTimeAsync(30_000);

      // Not one further WAIT line for a caller that is holding the lane.
      expect(seen.filter((o) => o.kind === 'wait' && o.label === 'publish'))
        .toHaveLength(waitLinesAtHandover);
      // It is reported as a HOLDER instead, which is the accurate state.
      expect(seen.filter((o) => o.kind === 'hold' && o.label === 'publish').length)
        .toBeGreaterThan(0);

      inner.resolve();
      await second;
    } finally { vi.useRealTimers(); }
  });

  // The critique's gap: a single Lane.timer slot only misbehaves at depth >= 3,
  // where each new arrival would overwrite the previous waiter's handle —
  // leaking it and emitting false reports attributed to the wrong caller.
  it('tracks three waiters on ONE key independently', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness();
      const holder = deferred();
      const first = s.run('0xw', () => holder.promise, 'holder');
      const a = s.run('0xw', async () => 'a', 'waiter-a');
      const b = s.run('0xw', async () => 'b', 'waiter-b');
      const c = s.run('0xw', async () => 'c', 'waiter-c');

      expect(s.depth('0xw')).toBe(4);
      await settle();

      tick(3_000);
      await vi.advanceTimersByTimeAsync(3_000);

      const labels = new Set(seen.filter((o) => o.kind === 'wait').map((o) => o.label));
      expect(labels).toEqual(new Set(['waiter-a', 'waiter-b', 'waiter-c']));

      // Each reports its OWN position, not the last arrival's.
      const posFor = (l: string) => seen.find((o) => o.kind === 'wait' && o.label === l)!.positionsAhead;
      expect(posFor('waiter-a')).toBe(1);
      expect(posFor('waiter-b')).toBe(2);
      expect(posFor('waiter-c')).toBe(3);

      holder.resolve();
      await Promise.all([first, a, b, c]);
    } finally { vi.useRealTimers(); }
  });

  it('goes quiet once a wedged lane finally settles', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness();
      const holder = deferred();
      const first = s.run('0xw', () => holder.promise, 'holder');
      const second = s.run('0xw', async () => 'ok', 'publish');
      await settle();

      tick(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(seen.length).toBeGreaterThan(0);

      holder.resolve();
      await first; await second;
      const countAfterSettle = seen.length;

      // An orphaned interval would keep reporting a lane that no longer exists.
      tick(120_000);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(seen.length).toBe(countAfterSettle);
      expect(s.isActive('0xw')).toBe(false);
      expect(s.activeKeyCount).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('KeyedSerializer preserves its existing guarantees (GH#953)', () => {
  it('runs same-key operations strictly in submission order', async () => {
    const s = new KeyedSerializer();
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) =>
      s.run('k', async () => { order.push(n); })));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('a rejecting operation does not wedge or skip its successor', async () => {
    const s = new KeyedSerializer();
    const boom = s.run('k', async () => { throw new Error('boom'); });
    await expect(boom).rejects.toThrow('boom');
    await expect(s.run('k', async () => 'after')).resolves.toBe('after');
  });

  it('runs different keys concurrently', async () => {
    const s = new KeyedSerializer();
    const a = deferred();
    const started: string[] = [];
    const pa = s.run('a', async () => { started.push('a'); await a.promise; });
    const pb = s.run('b', async () => { started.push('b'); });
    await pb;
    expect(started).toContain('b');
    a.resolve();
    await pa;
  });

  it('keeps the lane map bounded by in-flight keys, not history', async () => {
    const s = new KeyedSerializer();
    for (const k of ['a', 'b', 'c']) await s.run(k, async () => k);
    // Lane teardown is chained off the tail, so it lands a microtask later.
    await settle();
    // isActive is load-bearing for idle-wallet selection (GH#953): a leaked
    // entry makes every wallet read busy forever and silently disables it.
    expect(s.activeKeyCount).toBe(0);
    expect(s.isActive('a')).toBe(false);
  });

  it('reports depth and hold elapsed for a live lane', async () => {
    const { s, tick } = harness();
    const holder = deferred();
    const p = s.run('k', () => holder.promise, 'holder');
    // depth increments synchronously at submission...
    expect(s.depth('k')).toBe(1);
    // ...but the holder is only recorded once the wrapper runs.
    await settle();
    tick(2_500);
    expect(s.holdElapsedMs('k')).toBe(2_500);
    holder.resolve();
    await p;
    await settle();
    expect(s.depth('k')).toBe(0);
    expect(s.holdElapsedMs('k')).toBeUndefined();
  });
});
