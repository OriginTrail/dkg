/** Structural for the same package-boundary reason as the read-authority code in http-utils.ts. */
export const UNSCOPED_QUERY_INVALIDATED_CODE = 'UNSCOPED_QUERY_INVALIDATED';

/** The body of the retryable 503 that answers a withheld unscoped query. */
export interface UnscopedQueryInvalidatedBody {
  readonly error: string;
  readonly code: typeof UNSCOPED_QUERY_INVALIDATED_CODE;
  readonly retryable: true;
}

/**
 * An unscoped query releases its result only when no local write and no
 * read-authority change landed while it ran. Losing that check says nothing
 * about the request and the same query succeeds once the write has settled, so
 * the caller gets the retryable 503 of the other transient conditions, not a
 * 500. The sentence is the one the agent throws, so the answer's text did not
 * change with its status.
 *
 * Returns that answer's body for the agent's marker, and `undefined` for any
 * other error.
 */
export function unscopedQueryInvalidatedBody(err: unknown): UnscopedQueryInvalidatedBody | undefined {
  const shaped = err as { code?: unknown; retryable?: unknown } | null | undefined;
  if (shaped?.code !== UNSCOPED_QUERY_INVALIDATED_CODE || shaped.retryable !== true) return undefined;
  return {
    error: 'Unscoped query dataset or read authority changed; retry the query or specify contextGraphId',
    code: UNSCOPED_QUERY_INVALIDATED_CODE,
    retryable: true,
  };
}
