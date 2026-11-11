/**
 * The embedded worker store's read bound and its typed timeout, kept apart
 * from the adapter so the adapter can stay within its size budget.
 */

/**
 * Default per-operation timeout for the embedded worker store. The worker is
 * a SINGLE thread that processes store ops FIFO, so one slow / wedged op (a
 * huge import, an expensive query, or a genuinely hung worker) blocks every
 * other store-backed request queued behind it. Without a bound, the caller —
 * an API route, the publisher, gossip ingest — waits FOREVER. That is the
 * exact signature behind issues #997 / #999 / #1002 / #1005 / #1008:
 * `/api/status` (no store) stays green while `/api/query`,
 * `/api/context-graph/list`, `/api/assertion/create` never return.
 *
 * A bounded wait turns an indefinite hang into a surfaced error the operator
 * can act on (the message points at the real fix: use an external SPARQL
 * server for heavy workloads). 120s is generous enough not to trip normal
 * operations yet finite. Set `operationTimeoutMs: 0` to restore the old
 * unbounded behaviour.
 *
 * IMPORTANT — the timeout is applied to READ-ONLY ops only (see
 * READ_ONLY_METHODS). A read is side-effect-free, so bounding the caller's wait
 * and rejecting is always a clean, determinate failure. A mutation is NOT
 * bounded: the timeout only drops the caller's promise while the single worker
 * thread keeps running the op, so a "timed-out" insert/delete could STILL
 * commit afterwards — and the rest of the codebase treats a rejected
 * insert/delete as a clean failure, which would leave partial state visible and
 * retries ambiguous. The user-visible hang in the issues above is on the read
 * paths (`/api/query`, `/api/context-graph/list`); bounding reads surfaces a
 * wedged worker there without inventing an indeterminate mutation outcome.
 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;

/**
 * Accept only a finite, non-negative override; otherwise fall back. The result
 * is floored to an INTEGER — the timeout is a millisecond count, so a fractional
 * value is meaningless noise.
 */
export function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

export function asAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

/**
 * Side-effect-free read methods. ONLY these are bounded by the per-op timeout:
 * rejecting a read after the bound is a clean, determinate failure (nothing was
 * written), so it safely surfaces a wedged worker on the exact paths that hang
 * in production. Every other method mutates persisted state and is left
 * unbounded — see DEFAULT_OPERATION_TIMEOUT_MS for why timing out a mutation
 * would be unsafe with the current call sites.
 */
export const READ_ONLY_METHODS = new Set<string>([
  'query', 'hasGraph', 'listGraphs', 'countQuads', 'rfc64ExactBindingsReadV1',
]);

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
