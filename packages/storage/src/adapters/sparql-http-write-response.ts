import { drainResponseBody } from '../http-response-limit.js';
import { SparqlHttpResponseError } from './sparql-http-response-error.js';

/** Keep transport ownership until EOF; successful headers do not acknowledge a write. */
export async function consumeSparqlWriteResponse(response: Response, signal: AbortSignal, operation: string): Promise<void> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new SparqlHttpResponseError(operation, response.status, text.slice(0, 300));
  }
  await drainResponseBody(response);
  signal.throwIfAborted();
}
