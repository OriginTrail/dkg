/**
 * GH#3081 — a recurring task whose requested pass starts one turn of the event loop after the
 * request: nothing of the pass runs on the requester's stack, the pending start is waited for by
 * `whenIdle` and cancelled by `close`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoalescingRecurringTask } from '../src/coalescing-recurring-task.js';
import { NextTurnRecurringTaskV1 } from '../src/internal/next-turn-recurring-task.js';

const tasks: NextTurnRecurringTaskV1[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tasks.splice(0).map((task) => task.close()));
});

/** A task whose pass records that it started and parks until the row lets it go. */
function harness() {
  const order: string[] = [];
  const parked: Array<() => void> = [];
  let hold = false;
  const task = new NextTurnRecurringTaskV1(new CoalescingRecurringTask({
    runPass: async () => {
      order.push('pass-started');
      if (hold) await new Promise<void>((resolve) => { parked.push(resolve); });
      order.push('pass-ended');
      return 'idle';
    },
    onError: (error) => { order.push(`error:${String(error)}`); },
    closingMessage: 'test task closing',
  }));
  tasks.push(task);
  return {
    task,
    order,
    holdPasses: () => { hold = true; },
    release: () => { hold = false; for (const next of parked.splice(0)) next(); },
    parked: () => parked.length,
  };
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('a recurring task that starts one turn later', () => {
  it('runs nothing of the pass inside the request, nor in the microtasks that follow it', async () => {
    const { task, order } = harness();
    expect(task.requestNextTurn()).toBe(true);
    order.push('request-returned');
    await Promise.resolve();
    await Promise.resolve();
    order.push('microtasks-ran');
    expect(task.running).toBe(false);

    await task.whenIdle();
    expect(order).toEqual(['request-returned', 'microtasks-ran', 'pass-started', 'pass-ended']);
  });

  it('starts a plain request inside the call, as the task it wraps does', async () => {
    const { task, order, holdPasses, release } = harness();
    holdPasses();
    expect(task.request()).toBe(true);
    order.push('request-returned');
    release();
    await task.whenIdle();
    expect(order).toEqual(['pass-started', 'request-returned', 'pass-ended']);
  });

  it('runs one pass for requests made before it starts, and one more for a request made while it runs', async () => {
    const { task, order, holdPasses, release, parked } = harness();
    holdPasses();
    task.requestNextTurn();
    task.requestNextTurn();
    task.requestNextTurn();
    await turn();
    expect(order).toEqual(['pass-started']);
    expect(task.running).toBe(true);

    // A pass is active: the request coalesces at once and starts nothing on this stack.
    expect(task.requestNextTurn()).toBe(true);
    expect(order).toEqual(['pass-started']);
    expect(parked()).toBe(1);

    release();
    await task.whenIdle();
    expect(order).toEqual(['pass-started', 'pass-ended', 'pass-started', 'pass-ended']);
  });

  it('is idle only once a pending start has run and its pass has ended', async () => {
    const { task, order, holdPasses, release } = harness();
    holdPasses();
    task.requestNextTurn();
    let idle = false;
    const whenIdle = task.whenIdle().then(() => { idle = true; });
    await turn();
    await turn();
    expect(order).toEqual(['pass-started']);
    expect(idle).toBe(false);

    release();
    await whenIdle;
    expect(order).toEqual(['pass-started', 'pass-ended']);
  });

  it('cancels a pending start on close, settles who waits for it, and refuses requests afterwards', async () => {
    const { task, order } = harness();
    task.requestNextTurn();
    const whenIdle = task.whenIdle();
    await task.close();
    await whenIdle;
    await turn();
    await turn();
    expect(order).toEqual([]);
    expect(task.closed).toBe(true);
    expect(task.requestNextTurn()).toBe(false);
    expect(task.request()).toBe(false);
  });

  it('arms a delayed pass through the task it wraps', async () => {
    const { task, order } = harness();
    expect(task.schedule(5)).toBe(true);
    // A deadline is armed: a second one is not.
    expect(task.schedule(5)).toBe(false);
    expect(order).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await task.whenIdle();
    expect(order).toEqual(['pass-started', 'pass-ended']);
  });

  it('is not held by a fake clock: the start is a turn of the loop, not a timer', async () => {
    const { task, order } = harness();
    vi.useFakeTimers();
    task.requestNextTurn();
    await task.whenIdle();
    expect(order).toEqual(['pass-started', 'pass-ended']);
  });
});
