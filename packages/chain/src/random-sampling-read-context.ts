// SPDX-License-Identifier: Apache-2.0

/** Evidence that makes one solved-period observation reusable across ticks. */
export interface RandomSamplingReadContext {
  readonly bindingId: string;
  readonly chronosEpoch: bigint;
}

/**
 * A current chain-tip snapshot whose epoch is derived from that exact block.
 * EVM adapters can supply this from one `eth_getBlockByNumber` after learning
 * the immutable Chronos schedule for the currently-bound Chronos contract.
 */
export interface RandomSamplingBlockContext extends RandomSamplingReadContext {
  readonly headBlockNumber: bigint;
}

/**
 * Cohesive Random Sampling capability, separate from the broad ChainAdapter.
 * Implementations supply both the RPC-backed epoch snapshot and the cheap
 * binding guard; consumers either receive the whole capability or none of it.
 */
export interface RandomSamplingReadContextReader {
  getRandomSamplingBindingId(): string | undefined;
  readRandomSamplingContext(): Promise<RandomSamplingReadContext | undefined>;
  /** Optional one-RPC head + epoch snapshot used by the solved-period guard. */
  readRandomSamplingBlockContext?(): Promise<RandomSamplingBlockContext | undefined>;
  isRandomSamplingBindingCurrent(bindingId: string): boolean;
}
