import type { AsyncPromoteQueueConfig } from '@origintrail-official/dkg-publisher';
import type { DkgConfig } from '../config.js';

/** Validate operator policy before constructing the queue; existing jobs retain their budgets. */
export function resolveDaemonPromoteQueueConfig(
  config: DkgConfig['promoteQueue'],
  random: () => number = Math.random,
): AsyncPromoteQueueConfig {
  const positiveInteger = (key: 'maxRetries' | 'retryBaseMs' | 'retryMaxMs', fallback: number) => {
    const value = config?.[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`promoteQueue.${key} must be a positive safe integer`);
    return value;
  };
  const maxRetries = positiveInteger('maxRetries', 5);
  const base = positiveInteger('retryBaseMs', 60_000);
  const max = positiveInteger('retryMaxMs', 900_000);
  if (max < base) throw new Error('promoteQueue.retryMaxMs must be at least retryBaseMs');
  const jitter = config?.retryJitterRatio ?? 0.2;
  if (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new Error('promoteQueue.retryJitterRatio must be a number in [0, 1]');
  }
  return {
    maxRetries,
    backoff: (attempt) => Math.min(max, Math.max(1, Math.round(
      Math.min(max, base * 2 ** Math.min(52, Math.max(0, attempt - 1))) * (1 + jitter * (2 * random() - 1)),
    ))),
  };
}
