const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;

export interface ClaimFailureBackoff {
  isDue(): boolean;
  recordFailure(): number;
  reset(): void;
}

export interface ClaimFailureBackoffOptions {
  now: () => number;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

/** Global queue-claim pacing shared by every worker slot. */
export function createClaimFailureBackoff(
  options: ClaimFailureBackoffOptions,
): ClaimFailureBackoff {
  const random = options.random ?? Math.random;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  let nextAttemptAt = 0;
  let nextBaseDelayMs = baseDelayMs;

  return {
    isDue: () => options.now() >= nextAttemptAt,
    recordFailure: () => {
      const jitter = 1 - jitterRatio + random() * jitterRatio * 2;
      const delayMs = Math.min(
        maxDelayMs,
        Math.max(1, Math.round(nextBaseDelayMs * jitter)),
      );
      nextAttemptAt = options.now() + delayMs;
      nextBaseDelayMs = Math.min(maxDelayMs, nextBaseDelayMs * 2);
      return delayMs;
    },
    reset: () => {
      nextAttemptAt = 0;
      nextBaseDelayMs = baseDelayMs;
    },
  };
}
