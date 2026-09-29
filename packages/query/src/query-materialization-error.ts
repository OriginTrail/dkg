export const QUERY_MATERIALIZATION_TOO_LARGE = 'QUERY_MATERIALIZATION_TOO_LARGE' as const;

/** One logical query retained more decoded store data than its query-layer budget. */
export class QueryMaterializationTooLargeError extends Error {
  readonly code = QUERY_MATERIALIZATION_TOO_LARGE;

  constructor(
    readonly maxBytes: number,
    readonly actualBytes: number,
  ) {
    super(`Query materialization exceeds byte limit (${actualBytes} > ${maxBytes})`);
    this.name = 'QueryMaterializationTooLargeError';
  }
}
