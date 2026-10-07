// SPDX-License-Identifier: Apache-2.0

export interface PromoteRetryTuning {
  readonly maxRetries: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly retryJitterRatio: number;
}
export const DEFAULT_PROMOTE_RETRY_TUNING: PromoteRetryTuning = Object.freeze({
  maxRetries: 5, retryBaseMs: 60_000, retryMaxMs: 900_000, retryJitterRatio: 0.2,
});

export function resolvePromoteRetryTuning(input: Partial<PromoteRetryTuning> = {}): PromoteRetryTuning {
  const tuning: PromoteRetryTuning = {
    maxRetries: input.maxRetries ?? DEFAULT_PROMOTE_RETRY_TUNING.maxRetries,
    retryBaseMs: input.retryBaseMs ?? DEFAULT_PROMOTE_RETRY_TUNING.retryBaseMs,
    retryMaxMs: input.retryMaxMs ?? DEFAULT_PROMOTE_RETRY_TUNING.retryMaxMs,
    retryJitterRatio: input.retryJitterRatio ?? DEFAULT_PROMOTE_RETRY_TUNING.retryJitterRatio,
  };
  for (const key of ['maxRetries', 'retryBaseMs', 'retryMaxMs'] as const) {
    if (!Number.isSafeInteger(tuning[key]) || tuning[key] < 1) {
      throw new Error(`promoteQueue.${key} must be a positive safe integer`);
    }
  }
  if (tuning.retryMaxMs < tuning.retryBaseMs) throw new Error('promoteQueue.retryMaxMs must be at least retryBaseMs');
  if (!Number.isFinite(tuning.retryJitterRatio) || tuning.retryJitterRatio < 0 || tuning.retryJitterRatio > 1) {
    throw new Error('promoteQueue.retryJitterRatio must be a number in [0, 1]');
  }
  return Object.freeze(tuning);
}

/** Exponential retry delay before jitter, with a bounded exponent and ceiling. */
export function defaultBackoffMs(attemptCount: number, tuning = DEFAULT_PROMOTE_RETRY_TUNING): number {
  return Math.min(tuning.retryMaxMs, tuning.retryBaseMs * 2 ** Math.min(52, Math.max(0, attemptCount - 1)));
}

/** Publisher-owned default and operator-configured policy; custom queue callbacks bypass it. */
export function createDefaultPromoteBackoff(
  rand: () => number = () => Math.random(),
  tuning = DEFAULT_PROMOTE_RETRY_TUNING,
): (attemptCount: number) => number {
  return (attemptCount) => Math.min(tuning.retryMaxMs, Math.max(1, Math.round(
    defaultBackoffMs(attemptCount, tuning) * (1 + tuning.retryJitterRatio * (2 * rand() - 1)),
  )));
}
