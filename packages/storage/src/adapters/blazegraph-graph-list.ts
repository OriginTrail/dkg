import type { AdmittedReadDeadline } from '../admitted-read-cancellation.js';
import { readResponseTextBounded } from '../http-response-limit.js';
import { decodeSparqlJsonQueryResult } from '../sparql-json-query-result.js';
import { decodeSparqlTsvSelectResponse } from '../sparql-tsv-query-result.js';

/**
 * Blazegraph's complete graph list. The store answers the graph-list query in
 * SPARQL TSV, one graph per line, and the answer is decoded as a stream: chunk
 * by chunk, letting the rest of the process run between chunks, without first
 * holding the whole body as one string or JSON tree. The response byte limit
 * applies while it streams. An answer that does not declare TSV, as a proxy or
 * a test double may send, keeps the buffered JSON decode.
 */
export const BLAZEGRAPH_GRAPH_LIST_QUERY = 'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }';
export const GRAPH_LIST_ACCEPT = 'text/tab-separated-values';

/** The graphs of a graph-list answer that `visible` admits, in the order the store sent them. */
export async function decodeBlazegraphGraphList(
  response: Response,
  deadline: AdmittedReadDeadline,
  maxResponseBytes: number | undefined,
  visible: (graph: string) => boolean,
): Promise<string[]> {
  const tsv = (response.headers.get('content-type') ?? '').toLowerCase().includes(GRAPH_LIST_ACCEPT);
  const result = tsv
    ? await deadline.waitFor(decodeSparqlTsvSelectResponse(response, { maxResponseBytes, yieldBetweenChunks: true }))
    : decodeSparqlJsonQueryResult(await deadline.waitFor(maxResponseBytes === undefined
      ? response.text()
      : readResponseTextBounded(response, maxResponseBytes)), 'select');
  return result.type === 'bindings' ? result.bindings.map((binding) => binding.g).filter(visible) : [];
}
