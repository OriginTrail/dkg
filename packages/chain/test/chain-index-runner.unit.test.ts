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

interface RigOptions {
  readonly backfillEveryTicks?: number;
  readonly onError?: (error: unknown) => void;
  /** Throw from every `runOnce`, to drive the backoff. */
  readonly failing?: boolean;
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

  const tick = {
    runOnce: async () => {
      calls.push('tick');
      if (options.failing === true) throw new Error('endpoint down');
      return ADVANCED;
    },
    backfillOnce: async () => {
      calls.push('backfill');
      return ADVANCED;
    },
  } as unknown as ChainIndexTick;

  const runner = new ChainIndexRunner(tick, {
    intervalMs: 1_000,
    ...(options.backfillEveryTicks === undefined
      ? {}
      : { backfillEveryTicks: options.backfillEveryTicks }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    setTimer: (fn, ms) => {
      delays.push(ms);
      pending = fn;
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
