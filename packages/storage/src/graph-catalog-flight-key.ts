import type { QueryOptions } from './triple-store.js';

/** Catalog reads carry the internal ceiling, so callers share a flight; a changed ceiling starts its own. */
export function graphCatalogFlightKey(options?: QueryOptions): string {
  return JSON.stringify([options?.maxResponseBytes ?? null, options?.maxLiteralHydrationBytes ?? null]);
}
