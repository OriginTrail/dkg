// SPDX-License-Identifier: Apache-2.0

import { classifyRpcRetryDisposition } from './evm-adapter-rpc.js';
import {
  activeRpcRequestAbortSignal,
  withRpcRequestContext,
} from './rpc-request-transport.js';

/** Own one endpoint's physical response stalls, independently of admission wait. */
export async function withRpcResponseStallScope<T>(
  timeoutMs: number | undefined,
  read: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const owner = new AbortController();
  try {
    return await withRpcRequestContext({
      signal: owner.signal,
      ...(timeoutMs === undefined ? {} : {
        responseStallPolicy: { timeoutMs, onTimeout: (error: Error) => owner.abort(error) },
      }),
    }, () => {
      const signal = activeRpcRequestAbortSignal();
      signal?.throwIfAborted();
      return read(signal);
    });
  } finally {
    // Retire any later stage of this endpoint without cancelling its caller.
    owner.abort();
  }
}

/**
 * Settle a typed tuple under one child request owner. Invoke thunks lazily so a
 * synchronous getter failure cannot leave already-started siblings unowned.
 * Local pressure cancels every sibling immediately and preserves its original
 * retry-later verdict; ordinary errors wait for bounded physical settlement.
 */
export async function readRpcTuple<T extends readonly unknown[]>(
  reads: { readonly [K in keyof T]: () => Promise<T[K]> },
): Promise<T> {
  const owner = new AbortController();
  let pressure: unknown;
  let sawPressure = false;
  try {
    return await withRpcRequestContext({ signal: owner.signal }, async () => {
      activeRpcRequestAbortSignal()?.throwIfAborted();
      const settled = await Promise.allSettled(reads.map((read) => (
        Promise.resolve().then(() => {
          activeRpcRequestAbortSignal()?.throwIfAborted();
          return read();
        }).catch((error: unknown) => {
          if (!sawPressure && classifyRpcRetryDisposition(error) === 'retry-later') {
            sawPressure = true;
            pressure = error;
            owner.abort(error);
          }
          throw error;
        })
      )));
      if (sawPressure) throw pressure;
      activeRpcRequestAbortSignal()?.throwIfAborted();
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return settled.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      }) as unknown as T;
    });
  } finally {
    owner.abort();
  }
}
