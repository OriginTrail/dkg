// SPDX-License-Identifier: Apache-2.0

/** Evidence that makes one solved-period observation reusable across ticks. */
export interface RandomSamplingReadContext {
  readonly bindingId: string;
  readonly chronosEpoch: bigint;
}

/**
 * Cohesive Random Sampling capability, separate from the broad ChainAdapter.
 * Implementations supply both the RPC-backed epoch snapshot and the cheap
 * binding guard; consumers either receive the whole capability or none of it.
 */
export interface RandomSamplingReadContextReader {
  getRandomSamplingBindingId(): string | undefined;
  readRandomSamplingContext(): Promise<RandomSamplingReadContext | undefined>;
  isRandomSamplingReadContextCurrent(context: RandomSamplingReadContext): boolean;
}
