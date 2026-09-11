// SPDX-License-Identifier: Apache-2.0

import { mapWithConcurrency } from '../../src/map-with-concurrency.ts';

export const PHASE_CONCURRENCY = 4;

export function mapCanaryPhaseV1(items, mapper) {
  return mapWithConcurrency(items, PHASE_CONCURRENCY, mapper);
}

export async function pollUntilV1(check, timeoutMs, intervalMs, sleep, failureFactory) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const result = await check();
      if (result) return result;
    } catch {
      // Bounded polling treats transient request failures as not ready.
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw failureFactory();
}
