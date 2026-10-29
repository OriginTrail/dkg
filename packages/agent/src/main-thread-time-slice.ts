// SPDX-License-Identifier: Apache-2.0

import { setImmediate as nextMacrotask } from 'node:timers/promises';

/** Main-thread CPU a sliced loop may use before timers and I/O get a turn. */
export const MAIN_THREAD_TIME_SLICE_MS = 25;

/**
 * One full turn of the event loop: due timers and ready I/O both run before
 * the caller continues. One immediate is not enough for a caller that was
 * resumed by an I/O callback: it runs in the same loop iteration, ahead of the
 * next timers phase. The second one cannot. Use it between two phases that
 * each walk a whole set.
 */
export async function yieldMainThread(): Promise<void> {
  await nextMacrotask();
  await nextMacrotask();
}

/**
 * Checkpoint for a CPU-bound loop that runs on the daemon's main thread.
 * Await it between iterations: once the work since the last turn has used
 * `sliceMs`, it gives the event loop one full turn before the loop continues.
 * A resolved promise does not do that: its continuation runs before the
 * event loop moves on. The total CPU is unchanged.
 */
export function createMainThreadTimeSlice(sliceMs?: number): () => Promise<void>;
/** Skip promise allocation and awaiting while both caller-chosen budgets remain. */
export function createMainThreadTimeSlice(options: {
  readonly sliceMs: number;
  readonly maxIterations: number;
}): () => Promise<void> | undefined;
export function createMainThreadTimeSlice(
  budget: number | { readonly sliceMs: number; readonly maxIterations: number } = MAIN_THREAD_TIME_SLICE_MS,
): () => Promise<void> | undefined {
  const sliceMs = typeof budget === 'number' ? budget : budget.sliceMs;
  const maxIterations = typeof budget === 'number' ? Infinity : budget.maxIterations;
  let sliceStartedAt = performance.now();
  let iterations = 0;
  const checkpoint = (): Promise<void> | undefined => {
    if (++iterations < maxIterations && performance.now() - sliceStartedAt < sliceMs) return;
    return yieldMainThread().then(() => {
      iterations = 0;
      sliceStartedAt = performance.now();
    });
  };
  // Preserve the existing promise-returning API for time-only callers.
  return typeof budget === 'number' ? () => checkpoint() ?? Promise.resolve() : checkpoint;
}
