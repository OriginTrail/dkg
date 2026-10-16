import { decodeSparqlJsonQueryResult } from './sparql-json-query-result.js';
import { decodeSparqlTsvSelectResult } from './sparql-tsv-query-result.js';

/** How a SELECT result travels: compact TSV, or the standard JSON results format. */
export type SparqlSelectResultFormat = 'json' | 'tsv';

/**
 * The configured SELECT result format, or the default when unset: compact TSV
 * for managed Oxigraph, which honors it, and JSON for generic endpoints unless
 * the operator opts in.
 */
export function resolveSelectResultFormat(
  value: unknown,
  managedOxigraph: boolean,
): SparqlSelectResultFormat {
  if (value === undefined) return managedOxigraph ? 'tsv' : 'json';
  if (value === 'json' || value === 'tsv') return value;
  throw new Error('sparql-http selectResultFormat must be json or tsv');
}

/** The Accept header of a read query. ASK answers are always JSON. */
export function sparqlResultsAccept(isAsk: boolean, format: SparqlSelectResultFormat): string {
  return !isAsk && format === 'tsv'
    ? 'text/tab-separated-values'
    : 'application/sparql-results+json';
}

/**
 * Decode a SELECT or ASK response. Some generic endpoints ignore Accept and
 * still return JSON; an explicit JSON content type is safe to fall back to,
 * while managed Oxigraph honors TSV and takes the compact decoder.
 */
export function decodeSparqlQueryResponse(
  text: string,
  contentType: string | null,
  { isAsk, format }: { isAsk: boolean; format: SparqlSelectResultFormat },
) {
  const tsvRequested = !isAsk && format === 'tsv';
  if (tsvRequested && !(contentType?.toLowerCase() ?? '').includes('sparql-results+json')) {
    return decodeSparqlTsvSelectResult(text);
  }
  return decodeSparqlJsonQueryResult(text, isAsk ? 'ask' : 'select');
}
