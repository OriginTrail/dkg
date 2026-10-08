import { createDefaultPromoteBackoff, resolvePromoteRetryTuning, type AsyncPromoteQueueConfig } from '@origintrail-official/dkg-publisher';
import type { DkgConfig } from '../config.js';

/** Adapt validated operator configuration to the publisher-owned retry policy. */
export function resolveDaemonPromoteQueueConfig(
  config: DkgConfig['promoteQueue'],
  random: () => number = Math.random,
): AsyncPromoteQueueConfig {
  const tuning = resolvePromoteRetryTuning(config);
  return { maxRetries: tuning.maxRetries, backoff: createDefaultPromoteBackoff(random, tuning) };
}
