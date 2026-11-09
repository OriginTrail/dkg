/**
 * OT-RFC-73 P10a/P11: the parts of a retention sweep that do not depend on the queue (retention-sweep-core.ts), tested on their own. Both sweeps are built on them; their
 * own tests (async-promote-retention*.test.ts, async-lift-retention*.test.ts) pin the behavior through each queue, these pin the primitives' boundaries.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  HoldBudget, RETENTION_MODES, RETENTION_SKIPS, RETENTION_SWEEP_DEFAULTS, RETENTION_WINDOW_MS, RetentionClockGuard, ageWindowMs, boundedInteger, claimBatch, errorMessage,
  lazyRetentionLogger, positiveFinite, sumInto,
} from '../src/retention-sweep-core.js';
import { SHARE_RETENTION_DEFAULTS, SHARE_RETENTION_MODES, SHARE_RETENTION_WINDOW_MS } from '../src/async-promote-retention.js';

const DAY = 24 * 60 * 60 * 1000;

describe('tunables', () => {
  it('keeps the D-6 window at 7 days, the floor at 24 hours and the hold budget at 50 ms', () => {
    expect(RETENTION_WINDOW_MS).toBe(7 * DAY);
    expect(RETENTION_SWEEP_DEFAULTS).toMatchObject({ minWindowMs: DAY, holdBudgetMs: 50, maxHoldBudgetMs: 50, sliceSize: 10, maxSliceSize: 100, batchSize: 100, maxBatchSize: 1000, clockGuardFactor: 3 });
    expect(Object.isFrozen(RETENTION_SWEEP_DEFAULTS)).toBe(true);
    expect([...RETENTION_MODES]).toEqual(['off', 'report', 'delete']);
    expect(RETENTION_SKIPS).toEqual(['off', 'overlap', 'clock_invalid', 'clock_backwards', 'clock_jump']);
  });

  it('is the one set of values the share sweep exports under its own names', () => {
    expect(SHARE_RETENTION_DEFAULTS).toBe(RETENTION_SWEEP_DEFAULTS);
    expect(SHARE_RETENTION_MODES).toBe(RETENTION_MODES);
    expect(SHARE_RETENTION_WINDOW_MS).toBe(RETENTION_WINDOW_MS);
  });
});

describe('validators', () => {
  it('positiveFinite takes a positive finite number and says so otherwise', () => {
    expect(positiveFinite(1, 'x')).toBe(1);
    expect(positiveFinite(0.5, 'x')).toBe(0.5);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5', undefined, null]) expect(() => positiveFinite(bad, 'x'), String(bad)).toThrow('x must be a positive finite number');
  });

  it('boundedInteger takes 1..max and says so otherwise', () => {
    expect(boundedInteger(1, 'n', 5)).toBe(1);
    expect(boundedInteger(5, 'n', 5)).toBe(5);
    for (const bad of [0, 6, 1.5, -2, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '3']) expect(() => boundedInteger(bad, 'n', 5), String(bad)).toThrow('n must be a positive integer of at most 5');
  });

  it('ageWindowMs floors a window at 24 hours', () => {
    expect(ageWindowMs(DAY, 'w')).toBe(DAY);
    expect(ageWindowMs(7 * DAY, 'w')).toBe(7 * DAY);
    expect(() => ageWindowMs(DAY - 1, 'w')).toThrow('w must be at least 86400000 ms (24 hours)');
    expect(() => ageWindowMs(0, 'w')).toThrow('w must be a positive finite number');
  });

  it('reduces an error to a bounded message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(new Error('x'.repeat(500)))).toHaveLength(200);
  });

  it('adds counts per key', () => {
    const into = { a: 1, b: 0 };
    sumInto(into, { a: 2 });
    sumInto(into, { b: 3, a: 0 });
    expect(into).toEqual({ a: 3, b: 3 });
  });
});

describe('RetentionClockGuard', () => {
  const INTERVAL = 60_000;
  const guard = () => new RetentionClockGuard(INTERVAL, 3);

  it('trusts the first tick of a process (it has no baseline) unless a clock is not a number', () => {
    expect(guard().verdict(1_000, 10)).toBeUndefined();
    expect(guard().verdict(Number.NaN, 10)).toBe('clock_invalid');
    expect(guard().verdict(1_000, Number.POSITIVE_INFINITY)).toBe('clock_invalid');
  });

  it('skips a tick earlier than the start of the last tick that ran, and resumes once the clock has caught up', () => {
    const g = guard();
    g.started(10_000, 100);
    expect(g.verdict(9_999, 109)).toBe('clock_backwards');
    expect(g.verdict(10_000, 110)).toBeUndefined();
  });

  it('skips a wall clock that ran ahead of the monotonic clock by more than factor x interval, and not a late timer', () => {
    const g = guard();
    g.started(1_000_000, 500);
    // an hour later by both clocks (a late timer, a long batch): fine
    expect(g.verdict(1_000_000 + 3_600_000, 500 + 3_600_000)).toBeUndefined();
    // exactly factor x interval of drift: still fine; one ms more: a jump
    expect(g.verdict(1_000_000 + 180_000 + 1_000, 500 + 1_000)).toBeUndefined();
    expect(g.verdict(1_000_000 + 180_001 + 1_000, 500 + 1_000)).toBe('clock_jump');
  });

  it('moves the baseline only when a tick runs: a leapt clock stays skipped on every later tick', () => {
    const g = guard();
    g.started(1_000_000, 0);
    const leapt = 1_000_000 + 365 * DAY;
    for (let tick = 1; tick <= 3; tick++) expect(g.verdict(leapt + tick * INTERVAL, tick * INTERVAL)).toBe('clock_jump');
    // the clock comes back
    expect(g.verdict(1_000_000 + 4 * INTERVAL, 4 * INTERVAL)).toBeUndefined();
    // and a tick that runs re-baselines: the next tick is judged against it
    g.started(leapt, 4 * INTERVAL);
    expect(g.verdict(leapt + INTERVAL, 5 * INTERVAL)).toBeUndefined();
  });
});

describe('HoldBudget', () => {
  it('starts at the configured slice and predicts a delete from the last one', () => {
    const budget = new HoldBudget(10, 50);
    expect(budget.sliceNow).toBe(10);
    expect(budget.wouldExceed(40, 10)).toBe(false);
    expect(budget.wouldExceed(40, 11)).toBe(true);
    expect(budget.exceeded(50)).toBe(false);
    expect(budget.exceeded(50.1)).toBe(true);
  });

  it('halves after a hold past the budget that deferred nothing, never below one', () => {
    const budget = new HoldBudget(10, 50);
    budget.adapt(80, 10, undefined);
    expect(budget.sliceNow).toBe(5);
    budget.adapt(80, 5, undefined);
    expect(budget.sliceNow).toBe(2);
    budget.adapt(80, 2, undefined);
    budget.adapt(80, 1, undefined);
    expect(budget.sliceNow).toBe(1);
  });

  it('fits the budget after a deferral, but only ever downwards, and never below one', () => {
    const budget = new HoldBudget(10, 50);
    budget.adapt(49, 10, 4);
    expect(budget.sliceNow).toBe(4);
    budget.adapt(49, 4, 8);
    expect(budget.sliceNow).toBe(4);
    budget.adapt(49, 4, 0);
    expect(budget.sliceNow).toBe(1);
  });

  it('creeps back up by one while holds are cheap and full, up to the configured size and not past it', () => {
    const budget = new HoldBudget(4, 50);
    budget.adapt(80, 4, undefined);
    expect(budget.sliceNow).toBe(2);
    budget.adapt(25, 2, undefined);
    expect(budget.sliceNow).toBe(3);
    budget.adapt(25, 3, undefined);
    expect(budget.sliceNow).toBe(4);
    budget.adapt(25, 4, undefined);
    expect(budget.sliceNow).toBe(4);
    // not cheap enough (more than half the budget), or the slice was not full: no growth
    budget.adapt(80, 4, undefined);
    budget.adapt(30, 2, undefined);
    expect(budget.sliceNow).toBe(2);
    budget.adapt(25, 1, undefined);
    expect(budget.sliceNow).toBe(2);
  });
});

describe('claimBatch', () => {
  it('lets one batch per store and graph run at a time, and releases it', async () => {
    const store = new OxigraphStore();
    const other = new OxigraphStore();
    try {
      const release = claimBatch(store, 'urn:g:1');
      expect(release).toBeTypeOf('function');
      expect(claimBatch(store, 'urn:g:1')).toBeUndefined();
      expect(claimBatch(store, 'urn:g:2')).toBeTypeOf('function');      // another graph of the same store
      expect(claimBatch(other, 'urn:g:1')).toBeTypeOf('function');      // the same graph of another store object
      release!();
      expect(claimBatch(store, 'urn:g:1')).toBeTypeOf('function');
    } finally {
      await store.close();
      await other.close();
    }
  });
});

describe('lazyRetentionLogger', () => {
  it('creates its logger on first use and keeps it', () => {
    const logger = lazyRetentionLogger('RetentionCoreTest');
    const first = logger();
    expect(logger()).toBe(first);
    expect(() => first.info('async_retention_core_test info')).not.toThrow();
    expect(() => first.warn('async_retention_core_test warn')).not.toThrow();
  });
});
