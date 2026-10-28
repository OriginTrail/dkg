import type { QueryOptions } from './triple-store.js';

/** Stores that cannot restrict a query's dataset refuse to run one that must withhold graphs. */
export function refuseWithheldGraphQuery(options: QueryOptions | undefined, storeName: string): void {
  if (options?.withheldGraphRoots?.length) {
    throw new Error(`${storeName} cannot withhold graphs from a query`);
  }
}
