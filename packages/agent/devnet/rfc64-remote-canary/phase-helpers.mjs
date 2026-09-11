// SPDX-License-Identifier: Apache-2.0

import {
  mapWithConcurrency,
  mapWithConcurrencySettled,
} from '../../src/map-with-concurrency.ts';
import { RemoteCanaryError } from './errors.mjs';

export const PHASE_CONCURRENCY = 4;

export function mapCanaryPhaseV1(items, mapper) {
  return mapWithConcurrency(items, PHASE_CONCURRENCY, mapper);
}

/**
 * Run a bounded phase to quiescence before surfacing its first failure.
 * This is required inside lifecycle critical sections: fail-fast promises may
 * reject while sibling workers are still mutating remote state.
 */
export async function mapCanaryPhaseDrainedV1(items, mapper) {
  const settled = await mapWithConcurrencySettled(items, PHASE_CONCURRENCY, mapper);
  const rejected = settled.find((result) => result.status === 'rejected');
  if (rejected !== undefined) throw rejected.reason;
  return settled.map((result) => result.value);
}

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

export function isRetryableNodeRequestErrorV1(error) {
  return error instanceof RemoteCanaryError
    && ['node-request-failed', 'node-http-status-failed'].includes(error.code);
}
