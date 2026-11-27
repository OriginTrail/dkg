// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_RECEIPT_POLL_INTERVAL_MS } from '../src/evm-adapter-constants.js';
import {
  BLOCK_TIME_MAX_AGE_MS,
  BLOCK_TIME_MIN_SPAN_MS,
  BlockTimeEstimator,
  MIN_RECEIPT_POLL_INTERVAL_MS,
  receiptPollIntervalMs,
} from '../src/receipt-poll-cadence.js';
import { waitForReceiptWithDeadline } from '../src/receipt-wait.js';

describe('receipt poll interval from the block time', () => {
  it('polls once a block, within the floor and the previous fixed interval', () => {
    expect(receiptPollIntervalMs(undefined)).toBe(RPC_RECEIPT_POLL_INTERVAL_MS);
    expect(receiptPollIntervalMs(200)).toBe(MIN_RECEIPT_POLL_INTERVAL_MS);
    expect(receiptPollIntervalMs(0)).toBe(MIN_RECEIPT_POLL_INTERVAL_MS);
    expect(receiptPollIntervalMs(1_000)).toBe(1_000);
    expect(receiptPollIntervalMs(2_000)).toBe(2_000);
    expect(receiptPollIntervalMs(12_000)).toBe(RPC_RECEIPT_POLL_INTERVAL_MS);
    expect(receiptPollIntervalMs(Number.POSITIVE_INFINITY)).toBe(RPC_RECEIPT_POLL_INTERVAL_MS);
    expect(receiptPollIntervalMs(Number.NaN)).toBe(RPC_RECEIPT_POLL_INTERVAL_MS);
  });

  it('keeps a waiting transaction at two lookups a second or fewer', () => {
    expect(1_000 / MIN_RECEIPT_POLL_INTERVAL_MS).toBeLessThanOrEqual(2);
  });
});

describe('BlockTimeEstimator', () => {
  /** A chain making one block every `blockMs`, its head read every `everyMs`. */
  function observe(estimator: BlockTimeEstimator, clock: { now: number }, blockMs: number, everyMs: number, forMs: number) {
    const end = clock.now + forMs;
    for (; clock.now <= end; clock.now += everyMs) estimator.observeHead(60_841_000 + Math.floor(clock.now / blockMs));
    clock.now -= everyMs;
  }

  it('knows nothing until its head reads span 30 s', () => {
    const clock = { now: 0 };
    const estimator = new BlockTimeEstimator(() => clock.now);
    observe(estimator, clock, 200, 12_000, BLOCK_TIME_MIN_SPAN_MS - 12_000);
    expect(estimator.blockTimeMs()).toBeUndefined();
    expect(estimator.receiptPollIntervalMs()).toBe(RPC_RECEIPT_POLL_INTERVAL_MS);
  });

  it('measures 0.2 s blocks from the poller\'s 12 s head reads and polls at the floor', () => {
    const clock = { now: 0 };
    const estimator = new BlockTimeEstimator(() => clock.now);
    observe(estimator, clock, 200, 12_000, 60_000);
    expect(estimator.blockTimeMs()).toBeCloseTo(200, 0);
    expect(estimator.receiptPollIntervalMs()).toBe(MIN_RECEIPT_POLL_INTERVAL_MS);
  });

  it('follows a 1 s chain and keeps 2 s on a 2 s chain', () => {
    const fast = { now: 0 };
    const oneSecond = new BlockTimeEstimator(() => fast.now);
    observe(oneSecond, fast, 1_000, 12_000, 60_000);
    expect(oneSecond.receiptPollIntervalMs()).toBe(1_000);

    const slow = { now: 0 };
    const twoSeconds = new BlockTimeEstimator(() => slow.now);
    observe(twoSeconds, slow, 2_000, 12_000, 60_000);
    expect(twoSeconds.receiptPollIntervalMs()).toBe(2_000);
  });

  it('skips a head below the newest one and treats a stalled chain as slow', () => {
    const clock = { now: 0 };
    const estimator = new BlockTimeEstimator(() => clock.now);
    estimator.observeHead(1_000);
    clock.now = 20_000;
    estimator.observeHead(900); // a lagging endpoint
    clock.now = 40_000;
    estimator.observeHead(1_200);
    expect(estimator.blockTimeMs()).toBe(200);

    const stalled = new BlockTimeEstimator(() => clock.now);
    clock.now = 0;
    stalled.observeHead(5);
    clock.now = 60_000;
    stalled.observeHead(5);
    expect(stalled.receiptPollIntervalMs()).toBe(RPC_RECEIPT_POLL_INTERVAL_MS);
  });

  it('forgets head reads older than ten minutes', () => {
    const clock = { now: 0 };
    const estimator = new BlockTimeEstimator(() => clock.now);
    estimator.observeHead(0);
    clock.now = 60_000;
    estimator.observeHead(300);
    expect(estimator.blockTimeMs()).toBe(200);
    clock.now = 60_000 + BLOCK_TIME_MAX_AGE_MS + 1;
    expect(estimator.blockTimeMs()).toBeUndefined();
  });

  it('ignores heads that are not block numbers', () => {
    const estimator = new BlockTimeEstimator(() => 0);
    for (const head of [-1, 1.5, Number.NaN]) estimator.observeHead(head);
    expect(estimator.blockTimeMs()).toBeUndefined();
  });
});

describe('receipt wait on a chain with 0.2 s blocks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The transaction lands in the block at 300 ms; when does the wait see its receipt? */
  async function receiptSeenAt(pollIntervalMs: number | (() => number)): Promise<{ atMs: number; lookups: number }> {
    vi.useFakeTimers({ now: 0 });
    let lookups = 0;
    const wait = waitForReceiptWithDeadline({
      txHash: '0xabc',
      receiptTimeoutMs: 60_000,
      pollIntervalMs,
      getReceipt: async () => {
        lookups += 1;
        return Date.now() >= 300 ? { status: 1 } : null;
      },
      assertSuccessfulReceipt: () => undefined,
      formatTimeoutMessage: () => 'timed out',
    });
    let atMs = -1;
    void wait.then(() => { atMs = Date.now(); });
    for (let step = 0; step < 100 && atMs < 0; step += 1) await vi.advanceTimersByTimeAsync(50);
    await wait;
    return { atMs, lookups };
  }

  it('sees the receipt at 500 ms instead of 2 s, with the same two lookups', async () => {
    const before = await receiptSeenAt(RPC_RECEIPT_POLL_INTERVAL_MS);
    const clock = { now: 0 };
    const estimator = new BlockTimeEstimator(() => clock.now);
    for (; clock.now <= 60_000; clock.now += 12_000) estimator.observeHead(Math.floor(clock.now / 200));
    const after = await receiptSeenAt(() => estimator.receiptPollIntervalMs());

    expect(before).toEqual({ atMs: 2_000, lookups: 2 });
    expect(after).toEqual({ atMs: 500, lookups: 2 });
  });
});
