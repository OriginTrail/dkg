import { StoreResponseTooLargeError } from '@origintrail-official/dkg-storage';

/** Distinguishes caller-result limits from internal graph-discovery failures. */
export class QueryResultTooLargeError extends StoreResponseTooLargeError {
  readonly queryPhase = 'result';
  constructor(cause: StoreResponseTooLargeError) {
    super(cause.maxBytes, cause.actualBytes);
    this.cause = cause;
  }
}

/** Public discriminator shared by consumers across package/error boundaries. */
export type QueryResultTooLargeErrorLike = Pick<QueryResultTooLargeError, 'code' | 'queryPhase'>;

export function isQueryResultTooLargeError(error: unknown): error is QueryResultTooLargeErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as Partial<Record<keyof QueryResultTooLargeErrorLike, unknown>>;
  return value.code === 'STORE_RESPONSE_TOO_LARGE' && value.queryPhase === 'result';
}
