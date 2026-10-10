// SPDX-License-Identifier: Apache-2.0
/** Unref'd sleep — a respawn backoff timer must not keep the process alive on its own. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Accept only a finite, non-negative override; otherwise fall back. The result
 * is floored to an INTEGER — the timeout is a millisecond count, so a fractional
 * value is meaningless noise.
 */
export function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}
