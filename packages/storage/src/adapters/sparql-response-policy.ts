import { readResponseTextBounded } from '../http-response-limit.js';
import { StoreOperationTimeoutError } from '../store-operation-timeout.js';
import type { StoreOperation } from '../store-operation-outcome.js';

// Oxigraph 0.5.x appends this evaluator error to an already-started
// SELECT/CONSTRUCT response when `serve --timeout-s` cancels the query.
const MANAGED_OXIGRAPH_CANCELLATION_SUFFIX = 'The SPARQL operation has been cancelled';

export interface SparqlResponseTextOptions {
  maxResponseBytes?: number;
  managedOxigraph?: boolean;
  operation: StoreOperation;
  tolerateReadFailure?: boolean;
}

/**
 * Read a SPARQL response body under the configured size bound and apply the
 * endpoint-specific completeness policy before a generic adapter parses it.
 *
 * Managed Oxigraph may commit HTTP 200 and stream a partial result before its
 * native evaluator deadline fires. Reject its cancellation suffix here so no
 * SELECT/CONSTRUCT decoder can mistake that prefix for a complete response.
 */
export async function readSparqlResponseText(
  response: Response,
  options: SparqlResponseTextOptions,
): Promise<string> {
  const read = options.maxResponseBytes === undefined
    ? response.text()
    : readResponseTextBounded(response, options.maxResponseBytes);
  const text = options.tolerateReadFailure ? await read.catch(() => '') : await read;
  if (
    options.managedOxigraph === true
    && text.trimEnd().endsWith(MANAGED_OXIGRAPH_CANCELLATION_SUFFIX)
  ) {
    throw new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation: options.operation,
      message: `Managed Oxigraph ${options.operation} exceeded its server-side query deadline`,
    });
  }
  return text;
}
