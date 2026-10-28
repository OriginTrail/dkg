/**
 * A non-OK response from the configured SPARQL endpoint.
 *
 * GH#1758 — the upstream status used to be rendered into the message and then
 * recovered at the HTTP boundary with a regex, which coupled the daemon route
 * to this file's exact diagnostic wording. Carrying `status` as data lets the
 * route distinguish "the caller's SPARQL was malformed" (400/422) from
 * "the store rejected US" (401/403/404/429) without string matching.
 *
 * `message` is unchanged from the previous template so existing log greps and
 * error-message assertions keep working.
 */
export class SparqlHttpResponseError extends Error {
  /** Stable discriminant for cross-boundary recognition. */
  readonly code = SPARQL_HTTP_RESPONSE_ERROR_CODE;
  readonly status: number;
  readonly operation: string;
  readonly responseExcerpt: string;

  constructor(operation: string, status: number, responseExcerpt: string) {
    super(`SPARQL HTTP ${operation} failed (${status}): ${responseExcerpt}`);
    this.name = 'SparqlHttpResponseError';
    this.status = status;
    this.operation = operation;
    this.responseExcerpt = responseExcerpt;
  }
}

/** Stable discriminant, so the guard does not key off a mutable class name. */
export const SPARQL_HTTP_RESPONSE_ERROR_CODE = 'SPARQL_HTTP_RESPONSE';

/**
 * The contract a cross-boundary consumer may rely on.
 *
 * PR #2330 review — the previous guard narrowed to the concrete class after
 * checking only `name` and `status`, so `{ name: 'SparqlHttpResponseError',
 * status: 400 }` satisfied it and TypeScript then permitted
 * `err.operation.toUpperCase()` on a value with no `operation`. Narrow to the
 * shape actually validated instead.
 */
export interface SparqlHttpResponseErrorLike {
  readonly code: typeof SPARQL_HTTP_RESPONSE_ERROR_CODE;
  readonly status: number;
  readonly operation: string;
  readonly responseExcerpt: string;
  readonly message: string;
}

/**
 * True when `err` carries the full SPARQL HTTP response contract — either as
 * the concrete class, or structurally when `instanceof` cannot survive the
 * boundary (workers, duplicate module instances). EVERY field the interface
 * promises is validated.
 */
export function isSparqlHttpResponseError(err: unknown): err is SparqlHttpResponseErrorLike {
  if (err instanceof SparqlHttpResponseError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const c = err as Partial<Record<keyof SparqlHttpResponseErrorLike, unknown>>;
  return (
    c.code === SPARQL_HTTP_RESPONSE_ERROR_CODE &&
    typeof c.status === 'number' &&
    Number.isFinite(c.status) &&
    typeof c.operation === 'string' &&
    typeof c.responseExcerpt === 'string' &&
    typeof c.message === 'string'
  );
}

/** HTTP request/authentication refusals certify rejection, unlike server failures. */
export function isDefinitiveSparqlUpdateRejectionV1(error: unknown): boolean {
  return isSparqlHttpResponseError(error)
    && [400, 401, 403, 404, 405, 413, 415, 422].includes(error.status);
}
