// SPDX-License-Identifier: Apache-2.0

/**
 * All-provider polling primitive, in its own focused transport module (r4 3881841032: the
 * failover client stays the sequential state machine; this is the parallel fan-out mode). One
 * poll asks EVERY configured provider in parallel, gives each endpoint ONE in-place retry for
 * transient failures (via core's canonical abort-aware `withRetry` — deterministic failures
 * surface immediately as an unanswered slot), and completes on abort rather than waiting out a
 * stalled endpoint. Domain callers keep their per-endpoint read construction and their decision
 * over the settled views (r3 3880005809).
 *
 * Returns one slot per provider (`null` where the endpoint could not answer even after its
 * retry), or `null` for the WHOLE poll when the signal aborts. The abort listener is removed in
 * a finally block (r4 3881841018): a successful poll leaves NOTHING attached to the
 * caller-owned signal, so repeated reads against one long-lived controller accumulate no
 * listeners.
 */

import type { JsonRpcProvider } from 'ethers';
import { withRetry } from '@origintrail-official/dkg-core';

export async function readAllProvidersWithTransientRetry<T>(
  providers: readonly JsonRpcProvider[],
  readOne: (provider: JsonRpcProvider) => Promise<T | null>,
  opts: {
    retryDelayMs: number;
    isRetryable: (err: unknown) => boolean;
    signal?: AbortSignal;
  },
): Promise<Array<T | null> | null> {
  if (opts.signal?.aborted) return null;
  let onAbort: (() => void) | undefined;
  const aborted = opts.signal
    ? new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        opts.signal?.addEventListener('abort', onAbort, { once: true });
      })
    : null;
  try {
    const withOneTransientRetry = (provider: JsonRpcProvider) => withRetry(
      () => readOne(provider),
      {
        maxAttempts: 2,
        baseDelayMs: opts.retryDelayMs,
        maxDelayMs: opts.retryDelayMs,
        jitter: 0,
        isRetryable: opts.isRetryable,
        signal: opts.signal,
      },
    );
    const poll = Promise.allSettled(providers.map(withOneTransientRetry))
      .then((settled) => settled.map((r) => (r.status === 'fulfilled' ? r.value : null)));
    const result = aborted ? await Promise.race([poll, aborted]) : await poll;
    if (!result || opts.signal?.aborted) return null;
    return result;
  } finally {
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
}
