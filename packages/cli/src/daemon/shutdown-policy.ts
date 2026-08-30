/** One startup-time shutdown policy shared by the worker and its supervisor. */
export interface ShutdownPolicy {
  hardTimeoutMs: number;
  supervisorGraceMs: number;
}

export const DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS = 15_000;
export const MIN_SHUTDOWN_HARD_TIMEOUT_MS = 5_000;
export const MAX_SHUTDOWN_HARD_TIMEOUT_MS = 300_000;

/**
 * Per-callsite budget for the best-effort forced-cleanup hook (state-file
 * unlinks, etc.) that runs after the hard timeout fires. Bounded separately
 * from the hard timeout so stalled filesystem I/O cannot recreate the same
 * zombie shape: after one second the worker abandons that cleanup and exits.
 */
export const SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS = 1_000;

/**
 * Default per-probe TCP-connect timeout. Production requests usually finish
 * far faster; five seconds leaves ample tail latency without letting one
 * liveness probe occupy the watcher indefinitely.
 */
export const LIVENESS_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_LIVENESS_SHUTDOWN_GRACE_MS = 30_000;

/**
 * Resolve all timing derived from DKG_SHUTDOWN_HARD_TIMEOUT_MS once. Keeping
 * the worker deadline and supervisor grace in one value makes it impossible
 * for the watchdog to preempt a valid worker shutdown budget.
 */
export function resolveShutdownPolicy(value: string | undefined): ShutdownPolicy {
  let hardTimeoutMs = DEFAULT_SHUTDOWN_HARD_TIMEOUT_MS;
  if (value !== undefined) {
    const parsed = Number(value);
    if (
      value.trim() === ''
      || !Number.isSafeInteger(parsed)
      || parsed < MIN_SHUTDOWN_HARD_TIMEOUT_MS
      || parsed > MAX_SHUTDOWN_HARD_TIMEOUT_MS
    ) {
      throw new TypeError(
        `DKG_SHUTDOWN_HARD_TIMEOUT_MS must be an integer from `
          + `${MIN_SHUTDOWN_HARD_TIMEOUT_MS} to ${MAX_SHUTDOWN_HARD_TIMEOUT_MS}`,
      );
    }
    hardTimeoutMs = parsed;
  }

  return {
    hardTimeoutMs,
    supervisorGraceMs: Math.max(
      DEFAULT_LIVENESS_SHUTDOWN_GRACE_MS,
      hardTimeoutMs + SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS + LIVENESS_PROBE_TIMEOUT_MS,
    ),
  };
}
