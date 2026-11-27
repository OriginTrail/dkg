/**
 * Wait for a store read to settle on an expected value, without mistaking a
 * stale read for the final state.
 *
 * Why this is not "poll until the read equals `expected`": the persist-turn
 * route awaits the store write before it answers, so every write the daemon
 * made (including a duplicate that a broken resend path would make) is already
 * durable when the HTTP responses come back. Only the READ side can lag, and
 * the suite deliberately tolerates that for external SPARQL stores. A read that
 * lags can serve a snapshot from before the duplicates. When that snapshot
 * equals the expected one-exchange footprint, returning at the first match
 * passes the test while the duplication is still on its way to becoming
 * visible.
 *
 * So the helper has two phases:
 *   1. converge: poll until a read equals `expected`, for at most `deadlineMs`;
 *   2. quiet: keep reading and require every read to stay equal to `expected`
 *      for at least `quietMs` AND at least `quietReads` further reads. The quiet
 *      phase always runs in full, even when the first match came right before
 *      the deadline: the deadline only bounds phase 1.
 *
 * A read that differs after the first match ends the wait at once and is the
 * result, so the caller's assertion fails with the late footprint.
 *
 * The quiet window narrows the false green, it cannot remove it: a store that
 * stays behind for longer than `quietMs` after the first match is still not
 * caught. `quietMs` is also a floor on the time every settled read costs, so it
 * is kept small (see FOOTPRINT_SETTLE).
 *
 * The module is pure (no imports): the clock, the sleep and the equality are
 * injectable, so `settle.test.ts` runs it without a devnet.
 */

export interface SettleOptions<T> {
  /** Pause between two reads. */
  pollMs: number;
  /** How long the expected value may take to show up, counted from the first read. */
  deadlineMs: number;
  /**
   * After the first match, every read must keep matching for at least this
   * long: the last confirming read is issued at least `quietMs` after the
   * first matching read returned.
   */
  quietMs: number;
  /** ...and for at least this many further reads. */
  quietReads: number;
  /** Injectable for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock in milliseconds; defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to comparing the JSON forms (footprints have a stable key order). */
  equals?: (a: T, b: T) => boolean;
}

export interface SettleResult<T> {
  /**
   * `settled`: the read matched and stayed matching for the whole quiet window.
   * `changed`: the read matched, then differed; `value` is the first read that differed.
   * `timeout`: the read never matched within the deadline; `value` is the last read.
   */
  outcome: 'settled' | 'changed' | 'timeout';
  value: T;
  /** Reads issued, the first one included. */
  reads: number;
}

/**
 * Tuning for the chat-turn footprint reads of the devnet suite.
 *
 * - `pollMs` and `deadlineMs` keep the previous convergence behavior (500 ms,
 *   15 s).
 * - A footprint read is six concurrent SELECTs through `POST /api/query`; on
 *   the devnet one takes a fraction of a second on every store backend, so 3
 *   further reads fit in the window with room to spare. 2 s is four poll
 *   intervals: long enough for a read that lags behind writes that are already
 *   durable to catch up and show the duplicates, short enough to keep the cost
 *   down. Every settled footprint pays the window once (the suite settles a
 *   couple of dozen of them, so it adds about a minute to a run that took
 *   under half a minute), and a test settles at most two, far from the 120 s
 *   test timeout.
 */
export const FOOTPRINT_SETTLE = {
  pollMs: 500,
  deadlineMs: 15_000,
  quietMs: 2_000,
  quietReads: 3,
} as const;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function settleOnExpected<T>(
  read: () => Promise<T>,
  expected: T,
  options: SettleOptions<T>,
): Promise<SettleResult<T>> {
  const { pollMs, deadlineMs, quietMs, quietReads } = options;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const equals = options.equals ?? sameJson;

  const startedAt = now();
  let reads = 1;
  let last = await read();

  // Phase 1: converge on the expected value.
  while (!equals(last, expected)) {
    if (now() - startedAt >= deadlineMs) return { outcome: 'timeout', value: last, reads };
    await sleep(pollMs);
    last = await read();
    reads += 1;
  }

  // Phase 2: it must stay there. Not bounded by the deadline.
  const matchedAt = now();
  let confirming = 0;
  for (;;) {
    await sleep(pollMs);
    const readStartedAt = now();
    const value = await read();
    reads += 1;
    if (!equals(value, expected)) return { outcome: 'changed', value, reads };
    confirming += 1;
    if (confirming >= quietReads && readStartedAt - matchedAt >= quietMs) {
      return { outcome: 'settled', value, reads };
    }
  }
}
