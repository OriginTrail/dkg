// SPDX-License-Identifier: Apache-2.0

import { ReadGraphLocks, type ReadGraphBackendRuntime } from './runtime.js';

const SLOTS = new WeakMap<ReadGraphBackendRuntime, ReadGraphLocks>();

/**
 * Run heavy background work on a backend's read graphs one job at a time, in
 * the order asked. Build, repair and removal take this slot themselves, and
 * the scheduled checks and the checks run on request take it for each read
 * graph they check.
 */
export function withReadGraphBackgroundSlot<T>(runtime: ReadGraphBackendRuntime, work: () => Promise<T>): Promise<T> {
  let slot = SLOTS.get(runtime);
  if (!slot) {
    slot = new ReadGraphLocks();
    SLOTS.set(runtime, slot);
  }
  return slot.withLocks(['background'], work);
}
