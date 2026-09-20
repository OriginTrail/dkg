// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter } from './chain-adapter.js';

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

/** Bind the optional broad-adapter methods into one all-or-nothing capability. */
export function bindRandomSamplingReadContextReader(
  adapter: ChainAdapter,
): RandomSamplingReadContextReader | undefined {
  const readContext = adapter.readRandomSamplingContext;
  const isCurrent = adapter.isRandomSamplingReadContextCurrent;
  if (
    typeof readContext !== 'function'
    || typeof isCurrent !== 'function'
  ) return undefined;
  return Object.freeze({
    readRandomSamplingContext: () => readContext.call(adapter),
    isRandomSamplingReadContextCurrent: (context: RandomSamplingReadContext) =>
      isCurrent.call(adapter, context),
  });
}
