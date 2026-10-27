// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { retryStoreAdmission } from '../src/store-admission-retry.js';

function refusal(
  reason: 'queue_full' | 'queue_wait_timeout' = 'queue_full',
): StoreSchedulerBusyError {
  return new StoreSchedulerBusyError(reason, 'normal', 'test.step');
}

/** A clock the waits advance, so budgets are exact and no test sleeps. */
function manualClock() {
  let nowMs = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => nowMs,
    sleep: async (ms: number) => {
      waits.push(ms);
      nowMs += ms;
    },
  };
}

describe('retryStoreAdmission', () => {
  it('repeats a step the scheduler refused before it started, waiting longer each time', async () => {
    const clock = manualClock();
    const step = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(refusal())
      .mockRejectedValueOnce(refusal('queue_wait_timeout'))
      .mockRejectedValueOnce(refusal())
      .mockResolvedValue('admitted');
    const retries: Array<[string, number]> = [];

    await expect(retryStoreAdmission(step, {
      now: clock.now,
      sleep: clock.sleep,
      onRetry: (operation, delayMs) => { retries.push([operation, delayMs]); },
    })).resolves.toBe('admitted');

    expect(step).toHaveBeenCalledTimes(4);
    expect(clock.waits).toEqual([250, 500, 1_000]);
    expect(retries).toEqual([['test.step', 250], ['test.step', 500], ['test.step', 1_000]]);
  });

  it('caps the wait between attempts', async () => {
    const clock = manualClock();
    const step = vi.fn<() => Promise<string>>();
    for (let i = 0; i < 6; i += 1) step.mockRejectedValueOnce(refusal());
    step.mockResolvedValue('admitted');

    await expect(retryStoreAdmission(step, { now: clock.now, sleep: clock.sleep }))
      .resolves.toBe('admitted');

    expect(clock.waits).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000]);
  });

  it('never repeats a step that failed for any other reason', async () => {
    const clock = manualClock();
    const failure = new Error('store unavailable');
    const step = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    await expect(retryStoreAdmission(step, { now: clock.now, sleep: clock.sleep }))
      .rejects.toBe(failure);

    expect(step).toHaveBeenCalledOnce();
    expect(clock.waits).toEqual([]);
  });

  it('gives up with the last refusal once the budget is spent', async () => {
    const clock = manualClock();
    const busy = refusal();
    const step = vi.fn<() => Promise<string>>().mockRejectedValue(busy);

    await expect(retryStoreAdmission(step, {
      budgetMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    })).rejects.toBe(busy);

    // The last wait is trimmed to what is left of the budget.
    expect(clock.waits).toEqual([250, 500, 250]);
    expect(step).toHaveBeenCalledTimes(4);
  });

  it('surfaces the caller abort reason instead of waiting on', async () => {
    const controller = new AbortController();
    const reason = new Error('request closed');
    const step = vi.fn<() => Promise<string>>().mockRejectedValue(refusal());

    const attempt = retryStoreAdmission(step, { signal: controller.signal });
    controller.abort(reason);

    await expect(attempt).rejects.toBe(reason);
    expect(step).toHaveBeenCalledOnce();
  });

  it('propagates a wait that fails on its own', async () => {
    const timerFailure = new Error('timer unavailable');
    const step = vi.fn<() => Promise<string>>().mockRejectedValue(refusal());

    await expect(retryStoreAdmission(step, {
      sleep: async () => { throw timerFailure; },
    })).rejects.toBe(timerFailure);

    expect(step).toHaveBeenCalledOnce();
  });

  it('does not start a step for an already aborted caller', async () => {
    const reason = new Error('request closed');
    const step = vi.fn<() => Promise<string>>();

    await expect(retryStoreAdmission(step, { signal: AbortSignal.abort(reason) }))
      .rejects.toBe(reason);

    expect(step).not.toHaveBeenCalled();
  });
});
