import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAIN_THREAD_TIME_SLICE_MS,
  createMainThreadTimeSlice,
  yieldMainThread,
} from '../src/main-thread-time-slice.js';

/** True once the event loop has reached its next macrotask. */
function macrotaskProbe(): { readonly reached: boolean } {
  const probe = { reached: false };
  setImmediate(() => {
    probe.reached = true;
  });
  return probe;
}

/** Occupy the main thread, as a verification loop does. */
function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* busy */ }
}

describe('main-thread turn', () => {
  it('lets a due timer run when the caller was resumed by an I/O callback', async () => {
    // The continuation of a file read runs in the loop's I/O phase. An
    // immediate scheduled there fires before the next timers phase, so a
    // single one would return with the timer still waiting.
    await readFile(new URL(import.meta.url));
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 1);
    spin(5);

    await yieldMainThread();

    expect(timerRan).toBe(true);
  });

  it('lets ready I/O complete when the caller was resumed by a timer', async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    let read = false;
    void readFile(new URL(import.meta.url)).then(() => {
      read = true;
    });
    // Long enough for the read to be ready; nothing can deliver it meanwhile.
    spin(50);
    expect(read).toBe(false);

    for (let turn = 0; turn < 50 && !read; turn += 1) await yieldMainThread();

    expect(read).toBe(true);
  });
});

describe('main-thread time slice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('continues in the same turn while the slice is not used up', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const timeSlice = createMainThreadTimeSlice();
    const probe = macrotaskProbe();

    now.mockReturnValue(1_000 + MAIN_THREAD_TIME_SLICE_MS - 0.001);
    await timeSlice();

    expect(probe.reached).toBe(false);
  });

  it('gives the event loop one turn once the slice is used up, then starts a new slice', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const timeSlice = createMainThreadTimeSlice();
    const first = macrotaskProbe();

    now.mockReturnValue(1_000 + MAIN_THREAD_TIME_SLICE_MS);
    await timeSlice();
    expect(first.reached).toBe(true);

    // The new slice is measured from the end of the turn, not from the start
    // of the previous slice.
    const second = macrotaskProbe();
    now.mockReturnValue(1_000 + 2 * MAIN_THREAD_TIME_SLICE_MS - 0.001);
    await timeSlice();
    expect(second.reached).toBe(false);

    now.mockReturnValue(1_000 + 2 * MAIN_THREAD_TIME_SLICE_MS);
    await timeSlice();
    expect(second.reached).toBe(true);
  });

  it('lets a due timer run between two slices of one CPU-bound loop', async () => {
    const timeSlice = createMainThreadTimeSlice(2);
    let timerRanAtIteration = -1;
    let iteration = 0;
    setTimeout(() => {
      timerRanAtIteration = iteration;
    }, 1);

    const until = performance.now() + 40;
    while (performance.now() < until) {
      iteration += 1;
      await timeSlice();
    }

    // Nothing is awaited after the loop, so the timer can only have run in a
    // turn the loop gave up.
    expect(timerRanAtIteration).toBeGreaterThan(0);
  });

  it('honours a caller-chosen slice length', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const timeSlice = createMainThreadTimeSlice(5);
    const probe = macrotaskProbe();

    now.mockReturnValue(4.9);
    await timeSlice();
    expect(probe.reached).toBe(false);

    now.mockReturnValue(5);
    await timeSlice();
    expect(probe.reached).toBe(true);
  });
});
