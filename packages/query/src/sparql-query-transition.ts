import { prepareSparql, prepareSparqlQuery, type PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import { ScopedQueryViolationError } from './scoped-query-error.js';

/** Own preparation after source edits; no-op transitions retain object identity. */
export function transitionGraphScope(scope: PreparedSparqlQuery, source: string): PreparedSparqlQuery {
  if (source === scope.source) return scope;
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') {
    throw new ScopedQueryViolationError('graph rewrite produced malformed SPARQL');
  }
  return prepareSparqlQuery(prepared);
}
