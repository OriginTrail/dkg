// SPDX-License-Identifier: Apache-2.0

import { setTimeout as delay } from 'node:timers/promises';
import { isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';

/**
 * How long a foreground request may wait for the store to admit one of its
 * steps. A burst of background reads can fill a lane's bounded queue for a
 * few seconds; a request the caller is waiting on should outlast it rather
 * than fail on the first refusal.
 */
export const STORE_ADMISSION_RETRY_BUDGET_MS = 15_000;
const FIRST_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;

export interface StoreAdmissionRetryOptions {
  /** Total time spent waiting between attempts. */
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
  /** Told the refused operation and the wait before each new attempt. */
  readonly onRetry?: (operation: string, delayMs: number) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * The retrier for one request the caller waits on, such as a context graph
 * create or registration. Each step passed to it must be idempotent; every
 * repeat is logged under `request`, so an operator can see a request outlast
 * a burst of background store work instead of failing on its first refusal.
 */
export function storeAdmissionRetrier(
  request: string,
  log: (message: string) => void,
): <T>(step: () => Promise<T>) => Promise<T> {
  return (step) => retryStoreAdmission(step, {
    onRetry: (operation, delayMs) => log(
      `${request}: the store refused ${operation} while busy; retrying in ${delayMs} ms`,
    ),
  });
}

/**
 * Run `step` again when the store scheduler refused it before it started
 * (`queue_full` or `queue_wait_timeout`). Only that refusal is retried: the
 * scheduler guarantees the refused operation never ran, so a step built from
 * idempotent writes is safe to repeat. Any other error, an abort, or a
 * refusal after the budget is spent propagates unchanged.
 */
export async function retryStoreAdmission<T>(
  step: () => Promise<T>,
  options: StoreAdmissionRetryOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }));
  const deadline = now() + (options.budgetMs ?? STORE_ADMISSION_RETRY_BUDGET_MS);
  let delayMs = FIRST_RETRY_DELAY_MS;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      return await step();
    } catch (error) {
      if (!isStoreSchedulerBusyError(error)) throw error;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) throw error;
      const waitMs = Math.min(delayMs, remainingMs);
      options.onRetry?.(error.operation, waitMs);
      try {
        await sleep(waitMs, options.signal);
      } catch (sleepError) {
        // Surface the caller's abort reason rather than the timer's.
        options.signal?.throwIfAborted();
        throw sleepError;
      }
      delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS);
    }
  }
}
