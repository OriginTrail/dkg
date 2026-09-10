// SPDX-License-Identifier: Apache-2.0

import { collectEvmErrorText } from './evm-adapter-errors.js';

/** Provider-declared eth_getLogs range caps that are safe to retry by splitting. */
export function isEvmLogRangeLimitError(err: unknown): boolean {
  return /(?:block range too large|exceeds? (?:the )?(?:max(?:imum)? )?block range|maximum allowed is \d+ blocks|limited to (?:a )?\d+ blocks?)/i
    .test(collectEvmErrorText(err));
}

/**
 * Read one inclusive eth_getLogs range, recursively splitting only explicit
 * provider range-limit failures. Halves are read sequentially to avoid turning
 * a compatibility retry into a request burst, and their results retain chain
 * order.
 */
export async function readAdaptiveEvmLogRange<T>(params: Readonly<{
  read: (fromBlock: number, toBlock: number) => Promise<readonly T[]>;
  fromBlock: number;
  toBlock: number;
  signal?: AbortSignal;
}>): Promise<T[]> {
  params.signal?.throwIfAborted();
  try {
    return [...await params.read(params.fromBlock, params.toBlock)];
  } catch (err) {
    if (params.fromBlock >= params.toBlock || !isEvmLogRangeLimitError(err)) throw err;
    const midpoint = params.fromBlock
      + Math.floor((params.toBlock - params.fromBlock) / 2);
    const left = await readAdaptiveEvmLogRange({
      ...params,
      toBlock: midpoint,
    });
    const right = await readAdaptiveEvmLogRange({
      ...params,
      fromBlock: midpoint + 1,
    });
    return [...left, ...right];
  }
}
