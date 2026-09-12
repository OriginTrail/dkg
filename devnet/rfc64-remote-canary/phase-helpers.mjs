// SPDX-License-Identifier: Apache-2.0

import { mapWithConcurrency } from '@origintrail-official/dkg-agent';
import { RemoteCanaryError } from './errors.mjs';

export const PHASE_CONCURRENCY = 4;

/**
 * @template Input, Output
 * @param {readonly Input[]} items
 * @param {(item: Input, index: number) => Promise<Output>} mapper
 */
export function mapCanaryPhaseV1(items, mapper) {
  return mapWithConcurrency(items, PHASE_CONCURRENCY, mapper);
}

/**
 * Run a bounded phase to quiescence before surfacing its first failure.
 * Once a failure is observed, already-started work drains and queued work is
 * skipped so no new remote operation begins on behalf of a failed phase.
 * This is required inside lifecycle critical sections: fail-fast promises may
 * reject while sibling workers are still mutating remote state.
 *
 * @template Input, Output
 * @param {readonly Input[]} items
 * @param {(item: Input, index: number) => Promise<Output>} mapper
 * @returns {Promise<readonly Output[]>}
 */
export async function mapCanaryPhaseDrainedV1(items, mapper) {
  let failureObserved = false;
  const settled = await mapWithConcurrency(
    items,
    PHASE_CONCURRENCY,
    async (item, index) => {
      if (failureObserved) return Object.freeze({ status: /** @type {const} */ ('skipped') });
      try {
        return Object.freeze({
          status: /** @type {const} */ ('fulfilled'),
          value: await mapper(item, index),
        });
      } catch (reason) {
        failureObserved = true;
        return Object.freeze({ status: /** @type {const} */ ('rejected'), reason });
      }
    },
  );
  const rejected = settled.find((result) => result.status === 'rejected');
  if (rejected !== undefined && rejected.status === 'rejected') throw rejected.reason;
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    if (result.status === 'skipped') throw new TypeError('drained-phase-skipped-without-failure');
    return result.value;
  });
}

/**
 * @template Result
 * @param {() => Result | false | Promise<Result | false>} check
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @param {(milliseconds: number) => Promise<void>} sleep
 * @param {() => Error} failureFactory
 * @param {{ retryError?: (error: unknown) => boolean }} [options]
 * @returns {Promise<Result>}
 */
export async function pollUntilV1(
  check,
  timeoutMs,
  intervalMs,
  sleep,
  failureFactory,
  { retryError = () => false } = {},
) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      if (!retryError(error)) throw error;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw failureFactory();
}

/** @param {unknown} error @returns {boolean} */
export function isRetryableNodeRequestErrorV1(error) {
  return error instanceof RemoteCanaryError
    && ['node-request-failed', 'node-http-status-failed'].includes(error.code);
}
