/**
 * A read's own time limit, and the answer a store gives when the limit ended
 * the read's work and not only the caller's wait.
 *
 * Stopping is backend-specific. The embedded worker store replaces its worker
 * thread, Blazegraph is given the limit as its own query deadline, and a
 * DKG-managed Oxigraph server is restarted by its supervisor. A store that
 * cannot stop a running read only releases its caller, and rejects with the
 * caller's own reason instead of {@link QueryWorkStoppedError}.
 */

export interface QueryWorkLimitOptions {
  /**
   * The caller's time limit for this read, as a `performance.now()` deadline.
   * When it passes, or `signal` aborts, a store that can stop a running read
   * stops its work and rejects with {@link QueryWorkStoppedError}. Only routes
   * that answer for a time limit set it: a stop can replace a store's worker.
   */
  workDeadline?: number;
}

export const QUERY_WORK_STOPPED_CODE = 'QUERY_WORK_STOPPED' as const;

/** `not_started`: the read never reached the store's engine. `stopped`: its work was ended. */
export type QueryWorkStopOutcome = 'not_started' | 'stopped';

export class QueryWorkStoppedError extends Error {
  readonly code = QUERY_WORK_STOPPED_CODE;
  readonly backend: string;
  readonly outcome: QueryWorkStopOutcome;

  constructor(backend: string, outcome: QueryWorkStopOutcome, cause: unknown) {
    super(outcome === 'stopped'
      ? `${backend} stopped a read when its time limit or its caller ended it`
      : `${backend} did not start a read whose time limit or caller had ended`, { cause });
    this.name = 'QueryWorkStoppedError';
    this.backend = backend;
    this.outcome = outcome;
  }
}

/** Structural, so the marker survives package and prototype boundaries. */
export function isQueryWorkStoppedError(
  error: unknown,
): error is { code: typeof QUERY_WORK_STOPPED_CODE; backend: string; outcome: QueryWorkStopOutcome } {
  if (!error || typeof error !== 'object') return false;
  const shaped = error as Record<string, unknown>;
  return shaped.code === QUERY_WORK_STOPPED_CODE
    && typeof shaped.backend === 'string'
    && (shaped.outcome === 'not_started' || shaped.outcome === 'stopped');
}

/**
 * Whole milliseconds left before `workDeadline`, never below 1, or undefined
 * when the read has no limit. A store bound may only be shortened by it.
 */
export function remainingWorkMs(workDeadline: number | undefined): number | undefined {
  if (workDeadline === undefined || !Number.isFinite(workDeadline)) return undefined;
  return Math.max(1, Math.ceil(workDeadline - performance.now()));
}

/** A store's own bound for a read in ms (0 = none), shortened to the read's work deadline. */
export function boundByWorkDeadline(boundMs: number, workDeadline: number | undefined): number {
  const remaining = remainingWorkMs(workDeadline);
  if (remaining === undefined) return boundMs;
  return boundMs > 0 ? Math.min(boundMs, remaining) : remaining;
}

/**
 * For a store that stops a read once its caller leaves or its work deadline
 * passes: the error the read rejects with. Any other failure is returned as is.
 */
export function workStoppedError(
  backend: string,
  error: unknown,
  options: { readonly signal?: AbortSignal; readonly workDeadline?: number },
  outcome: QueryWorkStopOutcome = 'stopped',
): unknown {
  const callerLeft = options.signal?.aborted === true;
  const limitPassed = options.workDeadline !== undefined && performance.now() >= options.workDeadline;
  if (!callerLeft && !limitPassed) return error;
  return new QueryWorkStoppedError(backend, outcome, callerLeft ? options.signal!.reason : error);
}
