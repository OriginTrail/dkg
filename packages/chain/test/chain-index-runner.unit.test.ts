// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE background loop's scheduling.
 *
 * This file exists because the runner had no tests at all, and its defaults are
 * not neutral: `backfillEveryTicks` decides how often a commit lands between
 * two head passes, which is what turned a latent tail defect and a latent
 * two-pass-rule defect into permanent ones. The timer is injected, so nothing
 * here waits on real time.
 */

import { describe, expect, it, vi } from 'vitest';

import { ChainIndexRunner } from '../src/chain-index/chain-index-runner.js';
import type { ChainIndexTick, ChainIndexTickResult } from '../src/chain-index/chain-index-tick.js';

const ADVANCED: ChainIndexTickResult = Object.freeze({
  outcome: 'advanced',
  logRequests: 1,
  blockRequests: 2,
});

/** A pass that advanced the head AND stored something. */
const PRODUCTIVE: ChainIndexTickResult = Object.freeze({
  outcome: 'advanced',
  fetchedRows: 1,
  logRequests: 1,
  blockRequests: 2,
});

/** An empty bounded page that left more of its lane to walk. */
const PENDING: ChainIndexTickResult = Object.freeze({
  outcome: 'advanced',
  fetchedRows: 0,
  pendingWork: true,
  logRequests: 1,
  blockRequests: 2,
});

interface RigOptions {
  readonly backfillEveryTicks?: number;
  readonly onError?: (error: unknown) => void;
  /** Throw from every `runOnce`, to drive the backoff. */
  readonly failing?: boolean;
  /** The readers' freshness contract; omitted keeps the flat period. */
  readonly idleHeadAgeBudgetMs?: number;
  /** Consumed in order by successive `runOnce` calls; then {@link ADVANCED}. */
  readonly results?: readonly ChainIndexTickResult[];
  /** What `backfillOnce` returns; defaults to {@link ADVANCED}. */
  readonly backfillResult?: ChainIndexTickResult;
  /** Monotonic milliseconds consumed by successive `runOnce` calls. */
  readonly runOnceDurationsMs?: readonly number[];
  /** Monotonic milliseconds consumed by every `backfillOnce` call. */
  readonly backfillDurationMs?: number;
  /** Overrides the 1,000 ms default period. */
  readonly intervalMs?: number;
}

interface Rig {
  readonly runner: ChainIndexRunner;
  /** `tick` / `backfill`, in the order the runner asked for them. */
  readonly calls: string[];
  /** Every delay the runner scheduled, in order. */
  readonly delays: number[];
  /** Run the timer the runner is waiting on and let the pass settle. */
  fire(): Promise<void>;
}

function rig(options: RigOptions = {}): Rig {
  const calls: string[] = [];
  const delays: number[] = [];
  let pending: (() => void) | undefined;
  let pendingDelayMs = 0;
  let nowMs = 0;

  let passes = 0;
  const tick = {
    runOnce: async () => {
      calls.push('tick');
      nowMs += options.runOnceDurationsMs?.[passes] ?? 0;
      if (options.failing === true) throw new Error('endpoint down');
      const scripted = options.results?.[passes];
      passes += 1;
      return scripted ?? ADVANCED;
    },
    backfillOnce: async () => {
      calls.push('backfill');
      nowMs += options.backfillDurationMs ?? 0;
      return options.backfillResult ?? ADVANCED;
    },
  } as unknown as ChainIndexTick;

  const runner = new ChainIndexRunner(tick, {
    intervalMs: options.intervalMs ?? 1_000,
    ...(options.backfillEveryTicks === undefined
      ? {}
      : { backfillEveryTicks: options.backfillEveryTicks }),
    ...(options.idleHeadAgeBudgetMs === undefined
      ? {}
      : { idleHeadAgeBudgetMs: options.idleHeadAgeBudgetMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    now: () => nowMs,
    setTimer: (fn, ms) => {
      delays.push(ms);
      pending = fn;
      pendingDelayMs = ms;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => { pending = undefined; },
  });

  return {
    runner,
    calls,
    delays,
    fire: async () => {
      const fn = pending;
      pending = undefined;
      nowMs += pendingDelayMs;
      pendingDelayMs = 0;
      fn?.();
      // Drain the pass and its `finally` reschedule. Four is comfortably more
      // than the chain of awaits one pass goes through.
      for (let drain = 0; drain < 6; drain += 1) await Promise.resolve();
    },
  };
}

describe('ChainIndexRunner', () => {
  it('runs the first pass immediately and then every interval', async () => {
    const harness = rig();
    harness.runner.start();
    expect(harness.delays[0]).toBe(0);

    await harness.fire();

    expect(harness.calls).toEqual(['tick']);
    expect(harness.delays[1]).toBe(1_000);
    await harness.runner.stop();
  });

  it('does not page history after every single tick', async () => {
    // A page per tick made the steady-state cost two `eth_getLogs` per pass for
    // the whole life of the backfill, and put a commit between every pair of
    // head passes — which is where the S4 two-pass rule goes to die.
    const harness = rig();
    harness.runner.start();

    for (let pass = 0; pass < 5; pass += 1) await harness.fire();

    expect(harness.calls.filter((call) => call === 'tick')).toHaveLength(5);
    expect(harness.calls.filter((call) => call === 'backfill')).toHaveLength(0);
    await harness.runner.stop();
  });

  it('pages history once the configured number of ticks has passed', async () => {
    const harness = rig({ backfillEveryTicks: 3 });
    harness.runner.start();

    for (let pass = 0; pass < 3; pass += 1) await harness.fire();

    expect(harness.calls).toEqual(['tick', 'tick', 'tick', 'backfill']);
    await harness.runner.stop();
  });

  it('ignores a nonsensical backfill interval rather than paging every pass', async () => {
    const harness = rig({ backfillEveryTicks: 0 });
    harness.runner.start();

    for (let pass = 0; pass < 3; pass += 1) await harness.fire();

    expect(harness.calls.filter((call) => call === 'backfill')).toHaveLength(0);
    await harness.runner.stop();
  });

  it('backs off exponentially while passes keep failing', async () => {
    // A cold edge that cannot reach an endpoint must not re-request every T
    // forever.
    const onError = vi.fn();
    const harness = rig({ failing: true, onError });
    harness.runner.start();

    await harness.fire();
    await harness.fire();
    await harness.fire();

    expect(onError).toHaveBeenCalledTimes(3);
    expect(harness.delays).toEqual([0, 1_000, 2_000, 4_000]);
    await harness.runner.stop();
  });

  it('never pages history on a pass that failed', async () => {
    const harness = rig({ failing: true, onError: () => undefined, backfillEveryTicks: 1 });
    harness.runner.start();

    for (let pass = 0; pass < 3; pass += 1) await harness.fire();

    expect(harness.calls.filter((call) => call === 'backfill')).toHaveLength(0);
    await harness.runner.stop();
  });

  describe('idle backoff', () => {
    it('keeps the flat period when no freshness budget is stated', async () => {
      // A caller that cannot say what its readers accept must not be opted
      // into a staler head on its behalf.
      const harness = rig();
      harness.runner.start();

      for (let pass = 0; pass < 5; pass += 1) await harness.fire();

      expect(harness.delays).toEqual([0, 1_000, 1_000, 1_000, 1_000, 1_000]);
      await harness.runner.stop();
    });

    it('widens the period only after consecutive quiet passes', async () => {
      // 9,000 ms of budget, two thirds spendable, 1,000 ms period => 6x.
      const harness = rig({ idleHeadAgeBudgetMs: 9_000 });
      harness.runner.start();

      for (let pass = 0; pass < 4; pass += 1) await harness.fire();

      // One empty pass between two blocks is normal; three is a quiet scope.
      expect(harness.delays).toEqual([0, 1_000, 1_000, 6_000, 6_000]);
      await harness.runner.stop();
    });

    it('returns to the full period on the first pass that stores a row', async () => {
      const harness = rig({
        idleHeadAgeBudgetMs: 9_000,
        results: [ADVANCED, ADVANCED, ADVANCED, PRODUCTIVE],
      });
      harness.runner.start();

      for (let pass = 0; pass < 4; pass += 1) await harness.fire();

      // Widened on the third quiet pass, then straight back to T — not one
      // widened period later.
      expect(harness.delays).toEqual([0, 1_000, 1_000, 6_000, 1_000]);
      await harness.runner.stop();
    });

    it('never widens the period past the readers\' freshness budget', async () => {
      // THE invariant. A head older than the budget is REFUSED, and the reader
      // falls back to the live chain read this loop exists to replace — so
      // over-widening raises physical demand instead of lowering it.
      for (const [intervalMs, budgetMs] of [
        [1_000, 9_000], [1_000, 18_000], [6_000, 18_000], [2_500, 15_000],
      ] as const) {
        const harness = rig({ intervalMs, idleHeadAgeBudgetMs: budgetMs });
        harness.runner.start();
        for (let pass = 0; pass < 6; pass += 1) await harness.fire();

        expect(Math.max(...harness.delays)).toBeLessThanOrEqual(budgetMs);
        await harness.runner.stop();
      }
    });

    it('subtracts completed pass time before spending the freshness budget', async () => {
      // Default production shape: T=6s, budget=18s, 12s spendable. The head is
      // stamped before each 4s pass, so only 8s remain for the idle timer. Two
      // adjacent passes then age the previous head by 4+8+4=16s, below 18s.
      const harness = rig({
        intervalMs: 6_000,
        idleHeadAgeBudgetMs: 18_000,
        runOnceDurationsMs: [4_000, 4_000, 4_000, 4_000],
      });
      harness.runner.start();

      for (let pass = 0; pass < 4; pass += 1) await harness.fire();

      expect(harness.delays).toEqual([0, 6_000, 6_000, 8_000, 8_000]);
      await harness.runner.stop();
    });

    it('adds no idle delay when a successful pass already spent its allowance', async () => {
      // A 13s pass has consumed more than the 12s spendable share. Keep the
      // ordinary T=6s schedule; idle backoff must never make this case worse.
      const harness = rig({
        intervalMs: 6_000,
        idleHeadAgeBudgetMs: 18_000,
        runOnceDurationsMs: [13_000, 13_000, 13_000],
      });
      harness.runner.start();

      for (let pass = 0; pass < 3; pass += 1) await harness.fire();

      expect(harness.delays).toEqual([0, 6_000, 6_000, 6_000]);
      await harness.runner.stop();
    });

    it('does not widen at all when one period already spends the budget', async () => {
      // 6,000 ms of budget leaves 4,000 spendable, which is less than one
      // 5,000 ms period: the only honest multiplier is 1.
      const harness = rig({ intervalMs: 5_000, idleHeadAgeBudgetMs: 6_000 });
      harness.runner.start();

      for (let pass = 0; pass < 4; pass += 1) await harness.fire();

      expect(harness.delays).toEqual([0, 5_000, 5_000, 5_000, 5_000]);
      await harness.runner.stop();
    });

    it('treats a contended or troubled scope as busy, never as quiet', async () => {
      // `cas-lost` and `endpoint-lagging` describe a scope that has not
      // converged. Slowing down while it is trying to converge is the one
      // thing the backoff must not do.
      for (const outcome of ['cas-lost', 'endpoint-lagging', 'fork-suspected', 'tombstoned'] as const) {
        const stalled: ChainIndexTickResult = { outcome, logRequests: 1, blockRequests: 1 };
        const harness = rig({
          idleHeadAgeBudgetMs: 9_000,
          results: [stalled, stalled, stalled, stalled, stalled],
        });
        harness.runner.start();

        for (let pass = 0; pass < 5; pass += 1) await harness.fire();

        expect(harness.delays).toEqual([0, 1_000, 1_000, 1_000, 1_000, 1_000]);
        await harness.runner.stop();
      }
    });

    it('counts an unmoved head as quiet as well as an empty advance', async () => {
      const unmoved: ChainIndexTickResult = {
        outcome: 'idle', logRequests: 1, blockRequests: 1,
      };
      const harness = rig({
        idleHeadAgeBudgetMs: 9_000,
        results: [unmoved, unmoved, unmoved],
      });
      harness.runner.start();

      for (let pass = 0; pass < 3; pass += 1) await harness.fire();

      expect(harness.delays).toEqual([0, 1_000, 1_000, 6_000]);
      await harness.runner.stop();
    });

    it('holds the full period while a backfill is still producing history', async () => {
      // Head passes can look quiet for a scope that has not caught up at all.
      const harness = rig({
        idleHeadAgeBudgetMs: 9_000,
        backfillEveryTicks: 1,
        backfillResult: PRODUCTIVE,
      });
      harness.runner.start();

      for (let pass = 0; pass < 4; pass += 1) await harness.fire();

      expect(harness.delays).toEqual([0, 1_000, 1_000, 1_000, 1_000]);
      await harness.runner.stop();
    });

    it('holds the full period for empty bounded work that has not converged', async () => {
      // An empty forward or backfill page still moved a coverage cursor. It is
      // progress, not evidence that the scope has nothing left to learn.
      const harness = rig({
        idleHeadAgeBudgetMs: 9_000,
        backfillEveryTicks: 1,
        backfillResult: PENDING,
      });
      harness.runner.start();

      for (let pass = 0; pass < 4; pass += 1) await harness.fire();

      expect(harness.delays).toEqual([0, 1_000, 1_000, 1_000, 1_000]);
      await harness.runner.stop();
    });

    it('resets quiet history when an empty forward page has more work', async () => {
      const harness = rig({
        idleHeadAgeBudgetMs: 9_000,
        results: [ADVANCED, ADVANCED, PENDING, ADVANCED, ADVANCED, ADVANCED],
      });
      harness.runner.start();

      for (let pass = 0; pass < 6; pass += 1) await harness.fire();

      expect(harness.delays).toEqual([0, 1_000, 1_000, 1_000, 1_000, 1_000, 6_000]);
      await harness.runner.stop();
    });

    it('lets a failing scope keep the wider backoff of the two', async () => {
      // A pass that threw learned nothing, which is not a chain with nothing
      // to learn: failure owns the period, and the two must not compound.
      const harness = rig({
        failing: true,
        onError: () => undefined,
        idleHeadAgeBudgetMs: 9_000,
      });
      harness.runner.start();

      for (let pass = 0; pass < 4; pass += 1) await harness.fire();

      expect(harness.delays).toEqual([0, 1_000, 2_000, 4_000, 8_000]);
      await harness.runner.stop();
    });
  });

  it('stops scheduling once stopped', async () => {
    const harness = rig();
    harness.runner.start();
    await harness.fire();
    await harness.runner.stop();
    const scheduled = harness.delays.length;

    await harness.fire();

    expect(harness.delays).toHaveLength(scheduled);
  });
});
