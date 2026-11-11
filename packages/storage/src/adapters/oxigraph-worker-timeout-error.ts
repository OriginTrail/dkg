/** Rejection raised when a read op exceeds its per-op timeout. */
export interface OxigraphWorkerTimeoutError extends Error {
  code: 'OXIGRAPH_WORKER_OP_TIMEOUT';
  /** Which store method timed out. */
  method: string;
  /** The bound that was exceeded. */
  timeoutMs: number;
}

export function createOxigraphWorkerTimeoutError(
  method: string,
  timeoutMs: number,
): OxigraphWorkerTimeoutError {
  const error = new Error(
    `oxigraph-worker: "${method}" timed out after ${timeoutMs}ms. `
      + 'The embedded store runs on a single worker thread, so a long-running or '
      + 'stuck operation blocks all reads queued behind it. For heavy workloads '
      + 'point the node at an external SPARQL server (store.backend "sparql-http" '
      + '/ "blazegraph"), or raise / disable store.options.operationTimeoutMs.',
  ) as OxigraphWorkerTimeoutError;
  error.code = 'OXIGRAPH_WORKER_OP_TIMEOUT';
  error.method = method;
  error.timeoutMs = timeoutMs;
  return error;
}
