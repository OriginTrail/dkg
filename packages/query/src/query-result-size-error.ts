import { StoreResponseTooLargeError } from '@origintrail-official/dkg-storage';

/** Distinguishes caller-result limits from internal graph-discovery failures. */
export class QueryResultTooLargeError extends StoreResponseTooLargeError {
  readonly queryPhase = 'result';
  constructor(cause: StoreResponseTooLargeError) {
    super(cause.maxBytes, cause.actualBytes);
    this.cause = cause;
  }
}
