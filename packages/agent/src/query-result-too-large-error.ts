import { type StoreResponseTooLargeErrorLike, isStoreResponseTooLargeError } from '@origintrail-official/dkg-storage';
import { isQueryMaterializationTooLargeError, isQueryResultTooLargeError as isQueryLayerResultTooLargeError } from '@origintrail-official/dkg-query';

export const QUERY_RESULT_TOO_LARGE = 'QUERY_RESULT_TOO_LARGE' as const;

export interface QueryResultTooLargeErrorLike {
  readonly code: typeof QUERY_RESULT_TOO_LARGE;
  readonly maxBytes: number;
  readonly actualBytes: number;
  readonly message: string;
}

/** The single public query-size failure exposed across the agent boundary. */
export class QueryResultTooLargeError extends Error
  implements QueryResultTooLargeErrorLike {
  readonly code = QUERY_RESULT_TOO_LARGE;
  readonly queryPhase = 'result';
  readonly maxBytes: number;
  readonly actualBytes: number;

  constructor(cause: StoreResponseTooLargeErrorLike);
  constructor(maxBytes: number, actualBytes: number, options?: ErrorOptions);
  constructor(limitOrCause: number | StoreResponseTooLargeErrorLike, actual?: number, options: ErrorOptions = {}) {
    const maxBytes = typeof limitOrCause === 'number' ? limitOrCause : limitOrCause.maxBytes;
    const actualBytes = typeof limitOrCause === 'number' ? actual! : toPublicByteCount(limitOrCause.actualBytes);
    super(`Query result exceeds byte limit (${actualBytes} > ${maxBytes})`,
      typeof limitOrCause === 'number' ? options : { cause: limitOrCause });
    this.name = 'QueryResultTooLargeError';
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

/** Structural because worker and RPC boundaries do not preserve prototypes. */
export function isQueryResultTooLargeError(
  error: unknown,
): error is QueryResultTooLargeErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    maxBytes?: unknown;
    actualBytes?: unknown;
    message?: unknown;
  };
  return candidate.code === QUERY_RESULT_TOO_LARGE
    && isNonNegativeSafeInteger(candidate.maxBytes)
    && isNonNegativeFiniteNumber(candidate.actualBytes)
    && typeof candidate.message === 'string';
}

/** Normalize private storage/query enforcement errors at the agent boundary. */
export function asQueryResultTooLargeError(
  error: unknown,
): QueryResultTooLargeErrorLike | undefined {
  if (isQueryResultTooLargeError(error)) return error;
  if (isStoreResponseTooLargeError(error) && isQueryLayerResultTooLargeError(error)) {
    return new QueryResultTooLargeError(error);
  }
  if (!isQueryMaterializationTooLargeError(error)) return undefined;
  return new QueryResultTooLargeError(error.maxBytes, error.actualBytes, { cause: error });
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function toPublicByteCount(value: number | bigint): number {
  if (typeof value === 'number') return value;
  return value > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(value);
}
