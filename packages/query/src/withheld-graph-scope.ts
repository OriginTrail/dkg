import type { PreparedGraphScope } from './sparql-graph-scope.js';

export const WITHHELD_GRAPH_QUERY_CODE = 'WITHHELD_GRAPH_QUERY';

/** A query without a context graph named its own dataset while graphs had to be withheld from it. */
export class WithheldGraphQueryError extends Error {
  readonly code = WITHHELD_GRAPH_QUERY_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'WithheldGraphQueryError';
  }
}

export function isWithheldGraphQueryError(error: unknown): error is WithheldGraphQueryError {
  return error instanceof Error && (error as { code?: unknown }).code === WITHHELD_GRAPH_QUERY_CODE;
}

/**
 * A query without a context graph that must withhold graphs runs over the
 * store's dataset without them (`QueryOptions.withheldGraphRoots`), whatever its
 * patterns. The store replaces any dataset the query names, so FROM and FROM
 * NAMED are refused rather than silently ignored.
 */
export function assertWithheldGraphQuery(scope: PreparedGraphScope): void {
  if (scope.hasDatasetClause) {
    throw new WithheldGraphQueryError(
      'FROM and FROM NAMED cannot be used in a query without a context graph while graphs are withheld from it',
    );
  }
}
