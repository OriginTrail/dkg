export interface BoundedDenialLoggerOptions {
  log: (message: string) => void;
  now: () => number;
  /** Minimum time between two lines for the same key. */
  intervalMs: number;
  /** Most keys remembered at once; the least recently logged is evicted first. */
  cacheMax: number;
}

/**
 * Logs `message()` for `key` unless that key logged within the interval. The
 * message is built only when a line is actually emitted.
 */
export type BoundedDenialLogger = (key: string, message: () => string) => void;

/**
 * Rate limiter shared by the connection-gater isolation policies. Gating is a
 * hot path: one foreign peer can be offered many times in a single discovery
 * wave, and each offer is a refused dial. This emits at most one line per key
 * per interval and appends ` suppressedSinceLast=<n>` when lines were dropped
 * in between. The bounded cache keeps attacker-chosen peer ids from growing it.
 */
export function createBoundedDenialLogger(options: BoundedDenialLoggerOptions): BoundedDenialLogger {
  const { log, now, intervalMs, cacheMax } = options;
  const entries = new Map<string, { lastLoggedAt: number; suppressed: number }>();

  return (key, message) => {
    const timestamp = now();
    const previous = entries.get(key);
    if (previous && timestamp - previous.lastLoggedAt < intervalMs) {
      previous.suppressed += 1;
      return;
    }
    if (!previous && entries.size >= cacheMax) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    const suppressed = previous?.suppressed ?? 0;
    entries.delete(key);
    entries.set(key, { lastLoggedAt: timestamp, suppressed: 0 });
    log(`${message()}${suppressed > 0 ? ` suppressedSinceLast=${suppressed}` : ''}`);
  };
}
