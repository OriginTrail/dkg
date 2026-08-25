/**
 * Provenance for "the SPARQL the CALLER sent was rejected".
 *
 * GH#1758 / PR #2330 review — the daemon route used to classify any typed
 * SPARQL HTTP 400/422 as a client error. That is unsound: a single
 * `/api/query` request also runs engine-generated queries for access control,
 * graph resolution and metadata scans, and a store that rejects one of THOSE
 * (backend dialect incompatibility, say) produces the same typed 400. Reporting
 * it as HTTP 400 blames the caller for an integration fault and suppresses the
 * retry or operator remediation that would actually fix it.
 *
 * Only the query engine knows which store call carried caller-supplied SPARQL,
 * so it marks that one. The route classifies on this marker, never on a bare
 * upstream status.
 */
export const CALLER_SPARQL_REJECTED_CODE = 'CALLER_SPARQL_REJECTED';

export class CallerSparqlRejectedError extends Error {
  readonly code = CALLER_SPARQL_REJECTED_CODE;
  /** Upstream status that rejected it (400 / 422). */
  readonly status: number;

  constructor(message: string, status: number, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'CallerSparqlRejectedError';
    this.status = status;
  }
}

/** True when `err` carries the caller-SPARQL-rejected contract. */
export function isCallerSparqlRejectedError(err: unknown): err is CallerSparqlRejectedError {
  if (err instanceof CallerSparqlRejectedError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const c = err as { code?: unknown; status?: unknown; message?: unknown };
  return (
    c.code === CALLER_SPARQL_REJECTED_CODE &&
    typeof c.status === 'number' &&
    Number.isFinite(c.status) &&
    typeof c.message === 'string'
  );
}
