import type { QueryOptions } from './triple-store.js';

/**
 * Stores that cannot restrict a query's dataset refuse to run one that must
 * withhold graphs. An empty list asks only that graphs hidden from enumeration
 * stay out; these stores run such a query over their whole dataset.
 */
export function refuseWithheldGraphQuery(options: QueryOptions | undefined, storeName: string): void {
  if (options?.withheldGraphRoots?.length) {
    throw new Error(`${storeName} cannot withhold graphs from a query`);
  }
}
