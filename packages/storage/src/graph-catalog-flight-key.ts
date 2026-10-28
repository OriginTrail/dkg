import type { QueryOptions } from './triple-store.js';

/** Every execution-affecting byte limit is part of catalog single-flight identity. */
export function graphCatalogFlightKey(options?: QueryOptions): string {
  return JSON.stringify([options?.maxResponseBytes ?? null, options?.maxLiteralHydrationBytes ?? null]);
}
