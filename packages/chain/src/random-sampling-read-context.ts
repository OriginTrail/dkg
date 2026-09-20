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
  readRandomSamplingContext(): Promise<RandomSamplingReadContext | undefined>;
  isRandomSamplingReadContextCurrent(context: RandomSamplingReadContext): boolean;
}

/** Bind the all-or-nothing capability without widening ChainAdapter. */
export function bindRandomSamplingReadContextReader(
  value: unknown,
): RandomSamplingReadContextReader | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  const candidate = value as Partial<RandomSamplingReadContextReader>;
  if (
    typeof candidate.readRandomSamplingContext !== 'function'
    || typeof candidate.isRandomSamplingReadContextCurrent !== 'function'
  ) return undefined;
  return Object.freeze({
    readRandomSamplingContext: () => candidate.readRandomSamplingContext!.call(value),
    isRandomSamplingReadContextCurrent: (context: RandomSamplingReadContext) =>
      candidate.isRandomSamplingReadContextCurrent!.call(value, context),
  });
}
