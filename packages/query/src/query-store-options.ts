import type { QueryOptions } from './query-engine.js';
import type { QueryOptions as StoreQueryOptions } from '@origintrail-official/dkg-storage';

export function storeOptions(options: QueryOptions | undefined): StoreQueryOptions | undefined {
  if (!options?.signal && !options?.priority && !options?.source && options?.maxResponseBytes === undefined && options?.maxLiteralHydrationBytes === undefined && options?.workDeadline === undefined) return undefined;
  return {
    signal: options.signal,
    priority: options.priority,
    source: options.source,
    maxResponseBytes: options.maxResponseBytes,
    maxLiteralHydrationBytes: options.maxLiteralHydrationBytes,
    // Only the caller's own reads carry it: shared discovery reads are built
    // without it (query-store-read-context.ts), so one caller never stops them.
    ...(options.workDeadline === undefined ? {} : { workDeadline: options.workDeadline }),
  };
}
