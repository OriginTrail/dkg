import type { QueryOptions } from '@origintrail-official/dkg-storage';

/** One scheduler and tracing policy for every RS-heal store operation. */
export function rsHealStoreOptions(operation: string, signal?: AbortSignal): QueryOptions {
  return {
    priority: 'background',
    source: `agent.swm.rsHeal.${operation}`,
    ...(signal ? { signal } : {}),
  };
}
