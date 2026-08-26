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
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function harness(overrides: Partial<{
  observeAfterMs: number;
  observeIntervalMs: number;
  stallAfterMs: number;
}> = {}) {
  const seen: KeyedSerializerObservation[] = [];
  let clock = 0;
  const s = new KeyedSerializer({
    observeAfterMs: overrides.observeAfterMs ?? 1_000,
    observeIntervalMs: overrides.observeIntervalMs ?? 1_000,
    stallAfterMs: overrides.stallAfterMs ?? 10_000,
    now: () => clock,
    onObserve: (o) => seen.push(o),
  });
  return { s, seen, tick: (ms: number) => { clock += ms; } };
}

describe('KeyedSerializer observability (GH#1574)', () => {
  it('says nothing while a lane settles quickly', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen } = harness();
      await s.run('0xw', async () => 'ok', 'publish');
      await settle();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(seen).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('reports the holder, the depth and the longest waiter', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness();
      const holder = deferred();
      const first = s.run('0xw', () => holder.promise, 'approve');
      const second = s.run('0xw', async () => 'ok', 'publish');
      await settle();

      tick(3_000);
      await vi.advanceTimersByTimeAsync(3_000);

      expect(seen.length).toBeGreaterThan(0);
      const o = seen[0]!;
      expect(o.key).toBe('0xw');
      // Names WHAT holds the lane — the thing an operator needs.
      expect(o.holderLabel).toBe('approve');
      expect(o.depth).toBe(2);
      expect(o.waiting).toBe(1);
      expect(o.oldestWaiterLabel).toBe('publish');
      expect(o.stalled).toBe(false);

      holder.resolve();
      await first; await second;
    } finally { vi.useRealTimers(); }
  });

  it('reports a holder with nothing queued behind it', async () => {
    // No depth-based signal would surface this — and it is the shape the issue
    // actually reported.
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness();
      const holder = deferred();
      const p = s.run('0xw', () => holder.promise, 'publish');
      await settle();

      tick(3_000);
      await vi.advanceTimersByTimeAsync(3_000);

      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]!.holderLabel).toBe('publish');
      expect(seen[0]!.waiting).toBe(0);

      holder.resolve();
      await p;
    } finally { vi.useRealTimers(); }
  });

  it('marks a hold stalled only past the stall threshold', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness({ stallAfterMs: 10_000 });
      const holder = deferred();
      const p = s.run('0xw', () => holder.promise, 'publish');
      await settle();

      tick(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(seen.some((o) => o.stalled)).toBe(false);

      tick(8_000);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(seen.some((o) => o.stalled)).toBe(true);

      holder.resolve();
      await p;
    } finally { vi.useRealTimers(); }
  });

  // Review: reusing the smaller of the two settings for a repeating timer
  // ignores the configured cadence and logs twice as often as intended.
  it('waits observeAfterMs for the first report, then repeats at observeIntervalMs', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness({ observeAfterMs: 1_000, observeIntervalMs: 5_000 });
      const holder = deferred();
      const p = s.run('0xw', () => holder.promise, 'publish');
      await settle();

      tick(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(seen).toHaveLength(1);

      // The repeat interval starts when the first report fires, so the second
      // is due 5s LATER (t=6000), not 5s after t=0. One millisecond short of
      // that, there must still be exactly one — this is the assertion that
      // fails if the cadence collapses to the 1s initial delay.
      tick(4_999);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(seen).toHaveLength(1);

      tick(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toHaveLength(2);

      holder.resolve();
      await p;
    } finally { vi.useRealTimers(); }
  });

  // Review: one timer per queued call makes diagnostic work grow with backlog.
  it('emits ONE observation per cadence however deep the queue', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness();
      const holder = deferred();
      const ops = [s.run('0xw', () => holder.promise, 'holder')];
      for (let i = 0; i < 20; i++) ops.push(s.run('0xw', async () => 'x', `waiter-${i}`));
      await settle();

      expect(s.depth('0xw')).toBe(21);
      tick(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      // 21 queued operations, ONE line describing the lane.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.waiting).toBe(20);
      expect(seen[0]!.oldestWaiterLabel).toBe('waiter-0');

      holder.resolve();
      await Promise.all(ops);
    } finally { vi.useRealTimers(); }
  });

  it('stops counting a waiter the moment it acquires', async () => {
    vi.useFakeTimers();
    try {
      const { s, seen, tick } = harness();
      const holder = deferred();
      const inner = deferred();
      const first = s.run('0xw', () => holder.promise, 'approve');
      const second = s.run('0xw', () => inner.promise, 'publish');
      await settle();

      tick(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(seen.at(-1)!.oldestWaiterLabel).toBe('publish');

      holder.resolve();
      await first;
      await settle();

      tick(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      const latest = seen.at(-1)!;
      // 'publish' now HOLDS the lane; it must not also be counted as waiting.
      expect(latest.holderLabel).toBe('publish');
      expect(latest.waiting).toBe(0);
      expect(latest.oldestWaiterLabel).toBeUndefined();

      inner.resolve();
      await second;
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
      await settle();
      const afterSettle = seen.length;

      tick(120_000);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(seen).toHaveLength(afterSettle);
      expect(s.isActive('0xw')).toBe(false);
      expect(s.activeKeyCount).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

// Review RED — every test above injects `onObserve`, so the PRODUCTION output
// path was never exercised. The whole point of the change is an actionable
// operator warning; this drives the real default logger.
describe('KeyedSerializer default logger (GH#1574)', () => {
  it('warns through console.warn with the operator-facing detail', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let clock = 0;
      // No onObserve — the real defaultObserve must run.
      const s = new KeyedSerializer({
        observeAfterMs: 1_000,
        observeIntervalMs: 1_000,
        stallAfterMs: 10_000,
        now: () => clock,
      });
      const holder = deferred();
      const first = s.run('0xWALLET', () => holder.promise, 'V10 publish');
      const second = s.run('0xWALLET', async () => 'ok', 'V10 update');
      await settle();

      clock += 3_000;
      await vi.advanceTimersByTimeAsync(3_000);

      expect(warn).toHaveBeenCalled();
      const line = warn.mock.calls.at(-1)!.join(' ');
      expect(line).toContain('tx serializer');
      expect(line).toContain('0xWALLET');
      expect(line).toContain('V10 publish');   // what holds it
      expect(line).toContain('V10 update');    // what is waiting
      expect(line).toContain('3s');
      expect(line).not.toContain('STALL');

      clock += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(warn.mock.calls.at(-1)!.join(' ')).toContain('STALL');

      holder.resolve();
      await first; await second;
    } finally { warn.mockRestore(); vi.useRealTimers(); }
  });
});

describe('KeyedSerializer lane state (GH#1574)', () => {
  it('reports idle, busy and stalled from ONE definition', async () => {
    const { s, tick } = harness({ stallAfterMs: 10_000 });
    expect(s.state('0xw')).toBe('idle');
    expect(s.isStalled('0xw')).toBe(false);

    const holder = deferred();
    const p = s.run('0xw', () => holder.promise, 'publish');
    await settle();
    expect(s.state('0xw')).toBe('busy');

    tick(10_000);
    expect(s.state('0xw')).toBe('stalled');
    expect(s.isStalled('0xw')).toBe(true);

    holder.resolve();
    await p;
    await settle();
    expect(s.state('0xw')).toBe('idle');
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
    await expect(s.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
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
    await settle();
    // isActive is load-bearing for idle-wallet selection (GH#953): a leaked
    // entry makes every wallet read busy forever and silently disables it.
    expect(s.activeKeyCount).toBe(0);
    expect(s.isActive('a')).toBe(false);
  });
});
