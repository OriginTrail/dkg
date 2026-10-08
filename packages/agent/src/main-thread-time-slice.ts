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
export function createMainThreadTimeSlice(
  sliceMs: number = MAIN_THREAD_TIME_SLICE_MS,
): () => Promise<void> {
  let sliceStartedAt = performance.now();
  return async (): Promise<void> => {
    if (performance.now() - sliceStartedAt < sliceMs) return;
    await yieldMainThread();
    sliceStartedAt = performance.now();
  };
}
