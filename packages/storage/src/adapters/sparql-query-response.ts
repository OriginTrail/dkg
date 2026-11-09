import type { QueryResult } from '../triple-store.js';
import type { StoreOperation } from '../store-operation-outcome.js';
import { decodeSparqlJsonQueryResult } from '../sparql-json-query-result.js';
import { decodeSparqlTsvSelectResponse } from '../sparql-tsv-query-result.js';
import { SparqlHttpResponseError } from './sparql-http-response-error.js';
import {
  assertManagedOxigraphSparqlResponseComplete,
  readSparqlResponseText,
} from './sparql-response-policy.js';

export type SparqlQueryResponseMode = 'ask-json' | 'select-json' | 'select-tsv';

export function sparqlQueryResponseAccept(mode: SparqlQueryResponseMode): string {
  return mode === 'select-tsv' ? 'text/tab-separated-values' : 'application/sparql-results+json';
}

export interface SparqlQueryResponseOptions {
  readonly mode: SparqlQueryResponseMode;
  readonly managedOxigraph: boolean;
  readonly maxResponseBytes?: number;
  readonly operation: StoreOperation;
}

/** Own response-format negotiation and decoding outside the oversized adapter. */
export async function decodeSparqlHttpQueryResponse(
  response: Response,
  options: SparqlQueryResponseOptions,
): Promise<QueryResult> {
  if (!response.ok) {
    const text = await readSparqlResponseText(response, {
      maxResponseBytes: options.maxResponseBytes,
      managedOxigraph: options.managedOxigraph,
      operation: options.operation,
      tolerateReadFailure: true,
    });
    throw new SparqlHttpResponseError('query', response.status, text.slice(0, 300));
  }

  // Managed Oxigraph honors TSV. A proxy that explicitly identifies JSON
  // keeps the established fallback; generic endpoints never request TSV.
  const contentType = response.headers?.get?.('content-type')?.toLowerCase() ?? '';
  if (options.mode === 'select-tsv' && !contentType.includes('json')) {
    return decodeSparqlTsvSelectResponse(response, {
      maxResponseBytes: options.maxResponseBytes,
    }, options.managedOxigraph
      ? line => assertManagedOxigraphSparqlResponseComplete(line, options.operation)
      : undefined);
  }
  const text = await readSparqlResponseText(response, {
    maxResponseBytes: options.maxResponseBytes,
    managedOxigraph: options.managedOxigraph,
    operation: options.operation,
  });
  return decodeSparqlJsonQueryResult(text, options.mode === 'ask-json' ? 'ask' : 'select');
}
