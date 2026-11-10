import type { QueryOptions } from './triple-store.js';

export const QUERY_DATASET_UNRESTRICTED_CODE = 'QUERY_DATASET_UNRESTRICTED';

/** The store cannot restrict a query's dataset, and the query asked it to. */
export class QueryDatasetUnrestrictedError extends Error {
  readonly code = QUERY_DATASET_UNRESTRICTED_CODE;

  constructor(storeName: string) {
    super(`${storeName} cannot withhold graphs from a query`);
    this.name = 'QueryDatasetUnrestrictedError';
  }
}

export function isQueryDatasetUnrestrictedError(error: unknown): error is QueryDatasetUnrestrictedError {
  return error instanceof Error && (error as { code?: unknown }).code === QUERY_DATASET_UNRESTRICTED_CODE;
}

/**
 * Stores that cannot restrict a query's dataset refuse to run a query that
 * asks them to, with withheld roots or with an empty list.
 */
export function refuseWithheldGraphQuery(options: QueryOptions | undefined, storeName: string): void {
  if (options?.withheldGraphRoots !== undefined) throw new QueryDatasetUnrestrictedError(storeName);
}
