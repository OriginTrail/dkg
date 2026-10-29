// SPDX-License-Identifier: Apache-2.0
import { performance } from 'node:perf_hooks';

// Capture the real event-loop primitive, as NextTurnRecurringTaskV1 does.
const nextTurn = setImmediate;

/** Yield between records even when their promises only schedule microtasks. */
export class CatalogWorkSliceV1 {
  #records = 0;
  #startedAt = performance.now();

  checkpoint(): Promise<void> | undefined {
    if (++this.#records < 32 && performance.now() - this.#startedAt < 8) return;
    return new Promise(resolve => nextTurn(() => {
      this.#records = 0;
      this.#startedAt = performance.now();
      resolve();
    }));
  }
}
