/** Stable transport-neutral error domain for malformed SPARQL result bodies. */
export class SparqlResultsShapeError extends Error {
  readonly code = 'SPARQL_RESULTS_SHAPE';

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'SparqlResultsShapeError';
  }
}
