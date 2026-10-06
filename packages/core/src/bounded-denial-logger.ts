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

export interface BoundedKeyedLimiterOptions {
  now: () => number;
  intervalMs: number;
  cacheMax: number;
  /** Optional global cap so high-cardinality keys cannot amplify logging. */
  maxEmitsPerWindow?: number;
  windowMs?: number;
}

/** Returns the suppressed count when a key may emit, or undefined when denied. */
export function createBoundedKeyedLimiter(options: BoundedKeyedLimiterOptions):
  (key: string) => number | undefined {
  const entries = new Map<string, { lastLoggedAt: number | null; suppressed: number }>();
  const globalLimit = options.maxEmitsPerWindow;
  const windowMs = options.windowMs ?? options.intervalMs;
  let windowStart: number | undefined;
  let windowEmitted = 0;

  return (key) => {
    const timestamp = options.now();
    if (globalLimit !== undefined && (windowStart === undefined || timestamp < windowStart
      || timestamp - windowStart >= windowMs)) {
      windowStart = timestamp;
      windowEmitted = 0;
    }
    const previous = entries.get(key);
    if (previous && previous.lastLoggedAt !== null
      && timestamp - previous.lastLoggedAt < options.intervalMs) {
      previous.suppressed += 1;
      return undefined;
    }
    if (globalLimit !== undefined && windowEmitted >= globalLimit) {
      if (previous) previous.suppressed += 1;
      else {
        if (entries.size >= options.cacheMax) {
          const oldest = entries.keys().next();
          if (!oldest.done) entries.delete(oldest.value);
        }
        // Remember suppression without starting a cooldown for a key that has
        // never emitted. It may log as soon as the global window reopens.
        entries.set(key, { lastLoggedAt: null, suppressed: 1 });
      }
      return undefined;
    }
    if (!previous && entries.size >= options.cacheMax) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    const suppressed = previous?.suppressed ?? 0;
    entries.delete(key);
    entries.set(key, { lastLoggedAt: timestamp, suppressed: 0 });
    windowEmitted++;
    return suppressed;
  };
}

/**
 * Rate limiter shared by the connection-gater isolation policies. Gating is a
 * hot path: one foreign peer can be offered many times in a single discovery
 * wave, and each offer is a refused dial. This emits at most one line per key
 * per interval and appends ` suppressedSinceLast=<n>` when lines were dropped
 * in between. The bounded cache keeps attacker-chosen peer ids from growing it.
 */
export function createBoundedDenialLogger(options: BoundedDenialLoggerOptions): BoundedDenialLogger {
  const decide = createBoundedKeyedLimiter({
    now: options.now,
    intervalMs: options.intervalMs,
    cacheMax: options.cacheMax,
  });
  return (key, message) => {
    const suppressed = decide(key);
    if (suppressed === undefined) return;
    try {
      options.log(`${message()}${suppressed > 0 ? ` suppressedSinceLast=${suppressed}` : ''}`);
    } catch {
      // A logger failure cannot change a connection-gating decision.
    }
  };
}
