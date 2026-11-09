export const QUERY_MATERIALIZATION_TOO_LARGE = 'QUERY_MATERIALIZATION_TOO_LARGE' as const;

export interface QueryMaterializationTooLargeErrorLike {
  readonly code: typeof QUERY_MATERIALIZATION_TOO_LARGE;
  readonly maxBytes: number;
  readonly actualBytes: number;
  readonly message: string;
}

/** One logical query retained more decoded store data than its query-layer budget. */
export class QueryMaterializationTooLargeError extends Error
  implements QueryMaterializationTooLargeErrorLike {
  readonly code = QUERY_MATERIALIZATION_TOO_LARGE;

  constructor(
    readonly maxBytes: number,
    readonly actualBytes: number,
  ) {
    super(`Query materialization exceeds byte limit (${actualBytes} > ${maxBytes})`);
    this.name = 'QueryMaterializationTooLargeError';
  }
}

/** Structural because package and worker boundaries do not preserve prototypes. */
export function isQueryMaterializationTooLargeError(
  error: unknown,
): error is QueryMaterializationTooLargeErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    maxBytes?: unknown;
    actualBytes?: unknown;
    message?: unknown;
  };
  return candidate.code === QUERY_MATERIALIZATION_TOO_LARGE
    && typeof candidate.maxBytes === 'number'
    && Number.isSafeInteger(candidate.maxBytes)
    && candidate.maxBytes >= 0
    && typeof candidate.actualBytes === 'number'
    && Number.isFinite(candidate.actualBytes)
    && candidate.actualBytes >= 0
    && typeof candidate.message === 'string';
}
