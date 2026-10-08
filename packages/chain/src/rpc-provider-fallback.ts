// SPDX-License-Identifier: Apache-2.0

import { resolveWithinAbort, withRetry } from '@origintrail-official/dkg-core';
import { classifyRpcRetryDisposition } from './evm-adapter-rpc.js';
import { resolveCapMs } from './rpc-read-timeout-policy.js';
import {
  activeRpcRequestAbortSignal,
  withRpcRequestContext,
  withRpcRequestTimeout,
} from './rpc-request-transport.js';

/**
 * Resolve a complete read from the primary, then configured fallbacks in order.
 * A null result or failed endpoint advances the pass; the first non-null result
 * is authoritative. Each endpoint gets one transient retry within the existing
 * point-read deadline. Caller cancellation and local admission pressure end the
 * operation rather than starting another endpoint.
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
    const timeoutMs = resolveCapMs('pointRead', providers.length);
    const result = await resolveWithinAbort(async () => {
      for (const provider of providers) {
        if (signal?.aborted) return null;
        const readWithRetry = () => {
          // The deadline's composed signal also stops backoff and later stages
          // of an abandoned endpoint; using only the caller signal would leak
          // a detached retry after its attempt timed out.
          const attemptSignal = activeRpcRequestAbortSignal();
          return withRetry(() => readOne(provider, attemptSignal), {
            maxAttempts: 2,
            baseDelayMs: opts.retryDelayMs,
            maxDelayMs: opts.retryDelayMs,
            jitter: 0,
            isRetryable: (error) => !attemptSignal?.aborted && opts.isRetryable(error),
            signal: attemptSignal,
          });
        };
        try {
          const view = await (timeoutMs === undefined
            ? readWithRetry()
            : withRpcRequestTimeout(timeoutMs, 'coherent provider read', readWithRetry));
          if (signal?.aborted) return null;
          if (view !== null) return view;
        } catch (error) {
          if (signal?.aborted || classifyRpcRetryDisposition(error) === 'retry-later') return null;
          // This endpoint cannot supply the coherent evidence. Even a
          // deterministic pinned-state refusal may be served by a fallback.
        }
      }
      return null;
    }, signal);
    return signal?.aborted ? null : result;
  });
}
