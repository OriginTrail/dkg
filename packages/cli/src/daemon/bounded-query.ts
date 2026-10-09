import { classifySparqlOperation } from '@origintrail-official/dkg-core';
import { prepareSparql, prepareSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';

export const BOUNDED_QUERY_VERSION = 1;
export const BOUNDED_QUERY_MAX_ROWS = 8192;
export const BOUNDED_QUERY_MAX_BYTES = 1024 * 1024;
export const BOUNDED_QUERY_MAX_TIMEOUT_MS = 2000;

/** A complete SELECT result or an explicit refusal, never an apparently empty truncation. */
export function boundSelect(sparql: unknown, maxRows: unknown): { sparql: string; maxRows: number } {
  if (typeof sparql !== 'string' || Buffer.byteLength(sparql) > 64 * 1024) {
    throw new Error('Expected a SELECT query of at most 64 KiB');
  }
  if (!Number.isInteger(maxRows) || (maxRows as number) < 1 || (maxRows as number) > BOUNDED_QUERY_MAX_ROWS) {
    throw new Error(`maxRows must be an integer from 1 to ${BOUNDED_QUERY_MAX_ROWS}`);
  }
  const operation = classifySparqlOperation(sparql);
  const prepared = prepareSparql(sparql);
  if (operation.kind !== 'read' || operation.form !== 'SELECT' || prepared.status !== 'valid') {
    throw new Error('Only read-only SELECT queries are supported');
  }
  const query = prepareSparqlQuery(prepared);
  if (!query.where || query.hasDatasetClause) throw new Error('A scoped WHERE clause is required');
  for (const [i, token] of prepared.tokens.entries()) {
    if (token.kind !== 'word') continue;
    if (token.upper === 'SERVICE') throw new Error('Remote SERVICE queries are not supported');
    if (query.structure.braces.depthBefore[i] === 0 && ['LIMIT', 'OFFSET'].includes(token.upper)) {
      throw new Error('Use maxRows; top-level LIMIT and OFFSET are not supported');
    }
  }
  // Newline also terminates a trailing SPARQL comment. The extra row is the
  // overflow witness: a full page is never silently called a complete result.
  return { sparql: `${sparql}\nLIMIT ${(maxRows as number) + 1}`, maxRows: maxRows as number };
}

export function boundedResult(bindings: Array<Record<string, unknown>>, maxRows: number) {
  if (bindings.length > maxRows) return { ok: false as const, code: 'QUERY_RESULT_TOO_LARGE' };
  const result = { type: 'bindings' as const, bindings };
  if (Buffer.byteLength(JSON.stringify(result)) > BOUNDED_QUERY_MAX_BYTES) {
    return { ok: false as const, code: 'QUERY_RESULT_TOO_LARGE' };
  }
  return { ok: true as const, result };
}
