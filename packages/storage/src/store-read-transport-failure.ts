import { SparqlHttpResponseError } from './adapters/sparql-http-response-error.js';
import { StoreOperationTimeoutError } from './store-operation-timeout.js';
/** A transport interruption from a query already classified as read-only. */
export class StoreReadTransportFailure extends Error {
  readonly code = 'STORE_READ_TRANSPORT_FAILURE';
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Read-only store transport was interrupted', { cause });
    this.name = 'StoreReadTransportFailure';
  }
}

/** Retain the established SPARQL status/operation contract at proven read boundaries. */
class StoreReadSparqlHttpFailure extends SparqlHttpResponseError {
  constructor(cause: SparqlHttpResponseError) {
    super(cause.operation, cause.status, cause.responseExcerpt);
    this.cause = cause;
  }
}

/** Preserve the adapter deadline contract for consumers outside the publisher. */
class StoreReadDeadlineFailure extends StoreOperationTimeoutError {
  constructor(cause: StoreOperationTimeoutError) { super({ ...cause, message: cause.message, cause }); }
}

export function isStoreReadTransportFailure(error: unknown): error is StoreReadTransportFailure | SparqlHttpResponseError | StoreOperationTimeoutError {
  return error instanceof StoreReadTransportFailure || error instanceof StoreReadSparqlHttpFailure || error instanceof StoreReadDeadlineFailure;
}

export class StoreReadHttpResponseError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const TRANSIENT_READ_STATUS = new Set([408, 429, 502, 503, 504]);
const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** Call only at a proven read boundary; this function never retries an operation. */
export async function classifyStoreReadTransport<T>(read: Promise<T>): Promise<T> {
  try { return await read; } catch (error) {
    if (error instanceof StoreOperationTimeoutError) throw new StoreReadDeadlineFailure(error);
    if (error instanceof SparqlHttpResponseError && TRANSIENT_READ_STATUS.has(error.status)) throw new StoreReadSparqlHttpFailure(error);
    if (error instanceof StoreReadHttpResponseError && TRANSIENT_READ_STATUS.has(error.status)) throw new StoreReadTransportFailure(error);
    if (error instanceof Error && (
      (error instanceof TypeError && (error.message === 'fetch failed' || error.message === 'terminated'))
      || ('code' in error && TRANSPORT_CODES.has(String(error.code)))
    )) throw new StoreReadTransportFailure(error);
    throw error;
  }
}
