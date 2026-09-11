// SPDX-License-Identifier: Apache-2.0

import { mapWithConcurrency } from '../../src/map-with-concurrency.ts';
import { RemoteCanaryError } from './errors.mjs';

export const PHASE_CONCURRENCY = 4;

export function mapCanaryPhaseV1(items, mapper) {
  return mapWithConcurrency(items, PHASE_CONCURRENCY, mapper);
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
