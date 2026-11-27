/** A successful SPARQL response whose wire payload is not a valid result. */
export class SparqlResultsShapeError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'SparqlResultsShapeError';
  }
}
