// SPDX-License-Identifier: Apache-2.0

import { resolveWithinAbort, withRetry } from '@origintrail-official/dkg-core';
import { classifyRpcRetryDisposition } from './evm-adapter-rpc.js';
import { resolveCapMs } from './rpc-read-timeout-policy.js';
import { runRpcProviderPass } from './rpc-provider-pass.js';
import { withRpcResponseStallScope } from './rpc-read-lifecycle.js';
import {
  activeRpcRequestAbortSignal,
  isRpcRequestTimeout,
  withRpcRequestContext,
} from './rpc-request-transport.js';

/**
 * Resolve a complete read from the primary, then configured fallbacks in order.
 * A null result or failed endpoint advances the pass; the first non-null result
 * is authoritative. Each endpoint gets one transient retry, while physical
 * responses use the existing point-read stall cap after governor admission.
 * A full response stall ends that endpoint without retry. Caller cancellation
 * and local admission pressure end the operation rather than starting another.
 */
export async function readFirstProviderWithTransientRetry<TProvider, TResult>(
  providers: readonly TProvider[],
  readOne: (provider: TProvider, signal?: AbortSignal) => Promise<TResult | null>,
  opts: {
    retryDelayMs: number;
    isRetryable: (err: unknown) => boolean;
    signal?: AbortSignal;
  },
): Promise<TResult | null> {
  return withRpcRequestContext({ signal: opts.signal }, async () => {
    const signal = activeRpcRequestAbortSignal();
    const responseTimeoutMs = resolveCapMs('pointRead', providers.length);
    const result = await resolveWithinAbort(async () => {
      try {
        const pass = await runRpcProviderPass(providers, (provider) => (signal?.aborted ? null : () => (
          withRpcResponseStallScope(responseTimeoutMs, (attemptSignal) => (
            withRetry(() => readOne(provider, attemptSignal), {
              maxAttempts: 2,
              baseDelayMs: opts.retryDelayMs,
              maxDelayMs: opts.retryDelayMs,
              jitter: 0,
              isRetryable: (error) => !attemptSignal?.aborted
                && classifyRpcRetryDisposition(error) !== 'retry-later'
                && !isRpcRequestTimeout(error) && opts.isRetryable(error),
              signal: attemptSignal,
            })
          ))
        )), {
          isRetryable: () => !signal?.aborted,
          isEmptyResult: (value) => value === null,
        });
        return signal?.aborted || pass.status !== 'served' ? null : pass.value;
      } catch (error) {
        if (signal?.aborted || classifyRpcRetryDisposition(error) === 'retry-later') return null;
        throw error;
      }
    }, signal);
    return signal?.aborted ? null : result;
  });
}
