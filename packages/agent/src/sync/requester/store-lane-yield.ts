// SPDX-License-Identifier: Apache-2.0
import type { TripleStore } from '@origintrail-official/dkg-storage';

/** Longest pause between two asset writes of one durable round. */
export const STORE_LANE_YIELD_MAX_MS = 10_000;
const STORE_LANE_YIELD_POLL_MS = 50;

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hand the store's background lane to other work between two asset writes.
 *
 * Each asset of a durable round is written by one atomic replacement, which
 * holds the background lane for its whole duration, and a round writes its
 * assets back to back. While other background work is queued or running,
 * wait for the lane to clear before the next write, but never longer than the
 * previous write took (and at most STORE_LANE_YIELD_MAX_MS): on a busy lane a
 * round gives other work at least as much time as it takes. An idle lane, or
 * a store that does not report its lanes, costs one event-loop turn.
 */
export async function yieldStoreBackgroundLane(input: {
  readonly store: Pick<TripleStore, 'getPressureSnapshot'>;
  readonly previousWriteMs: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? pause;
  await nextTurn();
  const lanePressure = (): boolean => {
    const snapshot = input.store.getPressureSnapshot?.();
    return snapshot !== undefined && (snapshot.backgroundQueued > 0 || snapshot.backgroundInflight > 0);
  };
  const waitUntil = now() + Math.min(Math.max(0, input.previousWriteMs), STORE_LANE_YIELD_MAX_MS);
  while (input.signal?.aborted !== true && lanePressure()) {
    const remainingMs = waitUntil - now();
    if (remainingMs <= 0) return;
    await sleep(Math.min(STORE_LANE_YIELD_POLL_MS, remainingMs));
  }
}
