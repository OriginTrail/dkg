import type { QueryOptions } from './query-engine.js';
import type { QueryOptions as StoreQueryOptions } from '@origintrail-official/dkg-storage';

export function storeOptions(options: QueryOptions | undefined): StoreQueryOptions | undefined {
  if (!options?.signal && !options?.priority && !options?.source && options?.maxResponseBytes === undefined) return undefined;
  return {
    signal: options.signal,
    priority: options.priority,
    source: options.source,
    maxResponseBytes: options.maxResponseBytes,
  };
}
