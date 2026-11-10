import type { QueryOptions } from './triple-store.js';

/**
 * Stores that cannot restrict a query's dataset refuse to run one that must
 * withhold graphs, that is, one with a non-empty list of withheld roots.
 */
export function refuseWithheldGraphQuery(options: QueryOptions | undefined, storeName: string): void {
  if (options?.withheldGraphRoots?.length) {
    throw new Error(`${storeName} cannot withhold graphs from a query`);
  }
}
