// SPDX-License-Identifier: Apache-2.0

import { classifyRpcRetryDisposition } from './evm-adapter-rpc.js';

export interface RpcProviderPassOptions<P, T> {
  readonly isRetryable: (error: unknown) => boolean;
  readonly isEmptyResult?: (value: T) => boolean;
  /** Checked before observers or physical work; indexes are zero-based. */
  readonly canStartAttempt?: (attempt: P, index: number) => boolean;
  readonly onAttempt?: (attempt: P, index: number) => void;
  readonly onServed?: (attempt: P, value: T, index: number) => void;
  readonly onFailure?: (attempt: P, error: unknown, index: number) => void;
}

export type RpcProviderPassResult<T> =
  | { readonly status: 'served'; readonly value: T }
  | {
      readonly status: 'exhausted';
      readonly lastError?: unknown;
      readonly empty: { readonly value: T } | null;
      readonly stopped: boolean;
    };

/**
 * Run one ordered provider pass. Callers own endpoint ordering, attempt budgets,
 * retry policy, telemetry and exhaustion translation. A benign empty response
 * advances without recording success or failure. Local retry-later failures
 * always stop the pass, even when a caller's classifier permits all errors.
 */
export async function runRpcProviderPass<P, T>(
  attempts: readonly P[],
  readOne: (attempt: P, index: number) => Promise<T>,
  options: RpcProviderPassOptions<P, T>,
): Promise<RpcProviderPassResult<T>> {
  let lastError: unknown;
  let empty: { value: T } | null = null;
  let stopped = false;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (options.canStartAttempt?.(attempt, index) === false) {
      stopped = true;
      break;
    }
    try {
      options.onAttempt?.(attempt, index);
      const value = await readOne(attempt, index);
      if (options.isEmptyResult?.(value)) {
        empty = { value };
        continue;
      }
      options.onServed?.(attempt, value, index);
      return { status: 'served', value };
    } catch (error) {
      if (classifyRpcRetryDisposition(error) === 'retry-later') throw error;
      if (!options.isRetryable(error)) throw error;
      lastError = error;
      options.onFailure?.(attempt, error, index);
    }
  }
  return {
    status: 'exhausted',
    ...(lastError === undefined ? {} : { lastError }),
    empty,
    stopped,
  };
}
