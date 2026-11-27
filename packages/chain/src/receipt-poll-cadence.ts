// SPDX-License-Identifier: Apache-2.0

import { performance } from 'node:perf_hooks';
import { RPC_RECEIPT_POLL_INTERVAL_MS } from './evm-adapter-constants.js';

/**
 * Shortest pause between receipt lookups. A waiting transaction then makes at
 * most two lookups a second, a fifth of the default 10 requests a second the
 * node's RPC request governor allows (`DEFAULT_RPC_REQUEST_GOVERNOR_POLICY`),
 * however fast the chain makes blocks.
 */
export const MIN_RECEIPT_POLL_INTERVAL_MS = 500;

/** Shortest span of head observations a block-time estimate is taken over. */
export const BLOCK_TIME_MIN_SPAN_MS = 30_000;

/** Head observations older than this no longer count. */
export const BLOCK_TIME_MAX_AGE_MS = 10 * 60_000;

const MAX_HEAD_OBSERVATIONS = 64;

/**
 * Receipt poll interval for a chain's block time: one block, never faster than
 * {@link MIN_RECEIPT_POLL_INTERVAL_MS} and never slower than the previous fixed
 * {@link RPC_RECEIPT_POLL_INTERVAL_MS}. An unknown block time keeps the fixed one.
 */
export function receiptPollIntervalMs(blockTimeMs: number | undefined): number {
  if (blockTimeMs === undefined || !Number.isFinite(blockTimeMs) || blockTimeMs < 0) {
    return RPC_RECEIPT_POLL_INTERVAL_MS;
  }
  return Math.round(Math.min(RPC_RECEIPT_POLL_INTERVAL_MS, Math.max(MIN_RECEIPT_POLL_INTERVAL_MS, blockTimeMs)));
}

/**
 * The chain's block time, measured from the head reads the node already makes
 * (`getBlockNumber`, which its chain-event poller calls on every poll):
 * the time between the oldest and newest observation of the last
 * {@link BLOCK_TIME_MAX_AGE_MS}, over the blocks the head advanced in it, once
 * they span {@link BLOCK_TIME_MIN_SPAN_MS}. It makes no reads of its own.
 *
 * A head below the newest one seen (a lagging endpoint, a shallow reorg) is
 * skipped. A chain that stops making blocks reads as ever slower, which keeps
 * the poll interval at its 2 s ceiling.
 */
export class BlockTimeEstimator {
  readonly #heads: Array<{ readonly block: number; readonly atMs: number }> = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  observeHead(block: number): void {
    if (!Number.isSafeInteger(block) || block < 0) return;
    const newest = this.#heads[this.#heads.length - 1];
    if (newest && block < newest.block) return;
    this.#heads.push({ block, atMs: this.now() });
    if (this.#heads.length > MAX_HEAD_OBSERVATIONS) this.#heads.shift();
  }

  /** Average block time in ms, or undefined until the observations span enough time. */
  blockTimeMs(): number | undefined {
    const now = this.now();
    while (this.#heads.length > 0 && now - this.#heads[0]!.atMs > BLOCK_TIME_MAX_AGE_MS) this.#heads.shift();
    const oldest = this.#heads[0];
    const newest = this.#heads[this.#heads.length - 1];
    if (!oldest || !newest) return undefined;
    const spanMs = newest.atMs - oldest.atMs;
    const blocks = newest.block - oldest.block;
    if (spanMs < BLOCK_TIME_MIN_SPAN_MS) return undefined;
    // No block in the whole span: slower than any interval we would pick.
    if (blocks <= 0) return Number.POSITIVE_INFINITY;
    return spanMs / blocks;
  }

  /** The pause before the next receipt lookup. */
  receiptPollIntervalMs(): number {
    return receiptPollIntervalMs(this.blockTimeMs());
  }
}
