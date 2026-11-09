/**
 * OT-RFC-73 P10b: the one retention timer. Fake timers: each sweep runs on its own interval, never overlaps itself, a failing sweep neither stops its own chain nor
 * its neighbour nor the daemon, and `stop()` ends the chain without leaving a batch behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RETENTION_FAILURE_LOG_EVERY, startRetentionTimer,
  type RetentionSweep, type RetentionSweepCounters, type RetentionTickResult,
} from '../src/daemon/retention-timer.js';

const EMPTY: RetentionSweepCounters = { deleted: {}, kept: {}, skipped: {}, errors: {}, lastCompletePass: null };

interface FakeSweep extends RetentionSweep {
  calls: number;
  running: number;
  maxRunning: number;
  /** What the next batches do; the default resolves cleanly at once. */
  behaviour: () => Promise<RetentionTickResult>;
}

function fakeSweep(over: { queue?: 'share' | 'publisher'; intervalMs?: number; counters?: RetentionSweepCounters } = {}): FakeSweep {
  const sweep: FakeSweep = {
    queue: over.queue ?? 'share', mode: 'report', intervalMs: over.intervalMs ?? 60_000,
    calls: 0, running: 0, maxRunning: 0,
    behaviour: async () => ({}),
    async runBatch() {
      sweep.calls += 1; sweep.running += 1; sweep.maxRunning = Math.max(sweep.maxRunning, sweep.running);
      try { return await sweep.behaviour(); } finally { sweep.running -= 1; }
    },
    counters: () => over.counters ?? EMPTY,
  };
  return sweep;
}

/** A batch that stays running until `finish()`. */
function hanging(): { behaviour: () => Promise<RetentionTickResult>; finish: (result?: RetentionTickResult) => void } {
  let finish!: (result?: RetentionTickResult) => void;
  return { behaviour: () => new Promise<RetentionTickResult>(resolve => { finish = (result = {}) => resolve(result); }), finish: (result) => finish(result) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the interval', () => {
  it('first runs one interval after the start, then once per interval', async () => {
    const sweep = fakeSweep();
    const timer = startRetentionTimer([sweep], () => undefined);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sweep.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(sweep.calls).toBe(4);
    await timer.stop();
  });

  it('gives every sweep its own interval', async () => {
    const share = fakeSweep({ queue: 'share', intervalMs: 1_000 });
    const publisher = fakeSweep({ queue: 'publisher', intervalMs: 3_000 });
    const timer = startRetentionTimer([share, publisher], () => undefined);
    await vi.advanceTimersByTimeAsync(9_000);
    expect([share.calls, publisher.calls]).toEqual([9, 3]);
    await timer.stop();
  });

  it('starts nothing for an empty registry', async () => {
    const timer = startRetentionTimer([], () => undefined);
    expect(timer.usage()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(timer.stop()).resolves.toBeUndefined();
  });
});

describe('a sweep never overlaps itself', () => {
  it('a batch that outlasts several intervals is not started again, and the next tick is one interval after it ends', async () => {
    const sweep = fakeSweep({ intervalMs: 1_000 });
    const batch = hanging();
    sweep.behaviour = batch.behaviour;
    const timer = startRetentionTimer([sweep], () => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);                       // ten more intervals while the batch is still running
    expect(sweep.calls).toBe(1);
    expect(sweep.maxRunning).toBe(1);
    sweep.behaviour = async () => ({});
    batch.finish();
    await vi.advanceTimersByTimeAsync(999);
    expect(sweep.calls).toBe(1);                                     // the next tick is a full interval after the end, not at once
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep.calls).toBe(2);
    expect(sweep.maxRunning).toBe(1);
    await timer.stop();
  });

  it('a hanging sweep delays only itself', async () => {
    const slow = fakeSweep({ queue: 'share', intervalMs: 1_000 });
    const fast = fakeSweep({ queue: 'publisher', intervalMs: 1_000 });
    slow.behaviour = hanging().behaviour;
    const timer = startRetentionTimer([slow, fast], () => undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect([slow.calls, fast.calls]).toEqual([1, 5]);
    const stopping = timer.stop(1);                                   // the hanging batch never ends: the bounded wait gives up
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
  });
});

describe('failures are isolated', () => {
  it('a batch that throws is counted and logged, keeps ticking, and does not touch the neighbouring sweep', async () => {
    const bad = fakeSweep({ queue: 'share', intervalMs: 1_000 });
    const good = fakeSweep({ queue: 'publisher', intervalMs: 1_000 });
    bad.behaviour = async () => { throw new Error('store went away'); };
    const log = vi.fn();
    const timer = startRetentionTimer([bad, good], log);
    await vi.advanceTimersByTimeAsync(3_000);
    expect([bad.calls, good.calls]).toEqual([3, 3]);
    const [badView, goodView] = timer.usage();
    expect(badView).toMatchObject({ queue: 'share', ticks: 3, errors: { tick: 3 } });
    expect(goodView).toMatchObject({ queue: 'publisher', ticks: 3 });
    expect(goodView!.errors).toEqual({});
    expect(log).toHaveBeenCalledTimes(1);                             // the streak is logged at its first failure, not on every tick
    expect(log.mock.calls[0]![0]).toMatch(/\[warn\] \[retention\] share retention \(report\) tick failed \(1 in a row\): store went away/);
    await timer.stop();
  });

  it('a store failure the sweep returns (and already counted) is logged with its phase and keeps the sweep ticking, without a timer-side count', async () => {
    const sweep = fakeSweep({ intervalMs: 1_000, counters: { ...EMPTY, errors: { scan: 2 } } });
    sweep.behaviour = async () => ({ error: { phase: 'scan', message: 'blazegraph timed out' } });
    const log = vi.fn();
    const timer = startRetentionTimer([sweep], log);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sweep.calls).toBe(2);
    expect(log.mock.calls[0]![0]).toMatch(/tick failed \(1 in a row\): scan phase: blazegraph timed out/);
    expect(timer.usage()[0]!.errors).toEqual({ scan: 2 });            // the sweep's own count, not doubled by the timer
    await timer.stop();
  });

  it('logs a failing streak at its first failure and every tenth, and says once when it recovers', async () => {
    const sweep = fakeSweep({ intervalMs: 1_000 });
    let failing = true;
    sweep.behaviour = async () => { if (failing) throw new Error('down'); return {}; };
    const log = vi.fn();
    const timer = startRetentionTimer([sweep], log);
    await vi.advanceTimersByTimeAsync(1_000 * 25);
    const warns = log.mock.calls.map(call => String(call[0])).filter(line => line.includes('tick failed'));
    expect(warns.map(line => /\((\d+) in a row\)/.exec(line)![1])).toEqual(['1', String(RETENTION_FAILURE_LOG_EVERY), String(RETENTION_FAILURE_LOG_EVERY * 2)]);
    failing = false;
    await vi.advanceTimersByTimeAsync(1_000 * 3);
    const recovered = log.mock.calls.map(call => String(call[0])).filter(line => line.includes('succeeded again'));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toContain('after 25 failed tick(s)');
    await timer.stop();
  });

  it('a logger that throws never alters the sweep', async () => {
    const sweep = fakeSweep({ intervalMs: 1_000 });
    sweep.behaviour = async () => { throw new Error('boom'); };
    const timer = startRetentionTimer([sweep], () => { throw new Error('log sink is gone'); });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sweep.calls).toBe(3);
    await timer.stop();
  });

  it('a batch that rejects with a non-error value is handled', async () => {
    const sweep = fakeSweep({ intervalMs: 1_000 });
    sweep.behaviour = () => Promise.reject('plain string');
    const log = vi.fn();
    const timer = startRetentionTimer([sweep], log);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log.mock.calls[0]![0]).toContain('plain string');
    await timer.stop();
  });
});

describe('usage', () => {
  it('reports the sweep counters next to the ticks the timer ran', async () => {
    const counters: RetentionSweepCounters = {
      deleted: { succeeded: 4 }, kept: { too_recent: 9 }, skipped: { clock_jump: 1 }, errors: { delete: 1 },
      lastCompletePass: { scanned: 14, wouldDelete: { succeeded: 4 }, deleted: { succeeded: 0 } },
    };
    const sweep = fakeSweep({ intervalMs: 1_000, counters });
    const timer = startRetentionTimer([sweep], () => undefined);
    expect(timer.usage()[0]).toMatchObject({ queue: 'share', mode: 'report', ticks: 0 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(timer.usage()[0]).toEqual({ queue: 'share', mode: 'report', ticks: 2, ...counters });
    await timer.stop();
  });
});

describe('stop', () => {
  it('clears the pending tick: nothing runs after it, and a stop before the first tick is clean', async () => {
    const sweep = fakeSweep({ intervalMs: 1_000 });
    const timer = startRetentionTimer([sweep], () => undefined);
    await vi.advanceTimersByTimeAsync(500);
    await timer.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sweep.calls).toBe(0);
  });

  it('waits for a batch that is running, then starts no further tick', async () => {
    const sweep = fakeSweep({ intervalMs: 1_000 });
    const batch = hanging();
    sweep.behaviour = batch.behaviour;
    const timer = startRetentionTimer([sweep], () => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    let stopped = false;
    const stopping = timer.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stopped).toBe(false);                                      // the running batch has not finished
    batch.finish();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sweep.calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up waiting for a batch that never finishes, after the bound, and says so', async () => {
    const sweep = fakeSweep({ intervalMs: 1_000 });
    sweep.behaviour = hanging().behaviour;
    const log = vi.fn();
    const timer = startRetentionTimer([sweep], log);
    await vi.advanceTimersByTimeAsync(1_000);
    let stopped = false;
    void timer.stop(250).then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(249);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    expect(log.mock.calls.map(call => String(call[0])).join('\n')).toMatch(/1 retention batch\(es\) still running 250 ms after the stop request/);
  });

  it('is harmless to call twice, also while a batch runs', async () => {
    const sweep = fakeSweep({ intervalMs: 1_000 });
    const batch = hanging();
    sweep.behaviour = batch.behaviour;
    const timer = startRetentionTimer([sweep], () => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    const first = timer.stop();
    const second = timer.stop();
    batch.finish();
    await Promise.all([first, second]);
    await expect(timer.stop()).resolves.toBeUndefined();
    expect(sweep.calls).toBe(1);
  });
});
