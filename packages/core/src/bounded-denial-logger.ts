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

export interface BoundedKeyedEmitterOptions<T> {
  emit: (value: T, suppressedSinceLast: number) => void | Promise<void>;
  now: () => number;
  intervalMs: number;
  cacheMax: number;
  /** Optional global cap so high-cardinality keys cannot amplify logging. */
  maxEmitsPerWindow?: number;
  windowMs?: number;
}

/** Per-key suppression with bounded state and an optional total emission budget. */
export function createBoundedKeyedEmitter<T>(options: BoundedKeyedEmitterOptions<T>):
  (key: string, value: () => T) => void {
  const entries = new Map<string, { lastLoggedAt: number; suppressed: number }>();
  const globalLimit = options.maxEmitsPerWindow;
  const windowMs = options.windowMs ?? options.intervalMs;
  let windowStart: number | undefined;
  let windowEmitted = 0;

  return (key, value) => {
    const timestamp = options.now();
    if (globalLimit !== undefined && (windowStart === undefined || timestamp < windowStart
      || timestamp - windowStart >= windowMs)) {
      windowStart = timestamp;
      windowEmitted = 0;
    }
    const previous = entries.get(key);
    if (previous && timestamp - previous.lastLoggedAt < options.intervalMs) {
      previous.suppressed += 1;
      return;
    }
    if (!previous && entries.size >= options.cacheMax) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    const suppressed = previous?.suppressed ?? 0;
    entries.delete(key);
    entries.set(key, { lastLoggedAt: timestamp, suppressed: 0 });
    if (globalLimit !== undefined && windowEmitted >= globalLimit) {
      entries.get(key)!.suppressed = suppressed + 1;
      return;
    }
    windowEmitted++;
    try {
      const delivery = options.emit(value(), suppressed);
      if (delivery) void delivery.catch(() => undefined);
    } catch {
      // Logging and telemetry must not change the caller's outcome.
    }
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
  return createBoundedKeyedEmitter<string>({
    emit: (message, suppressed) => options.log(
      `${message}${suppressed > 0 ? ` suppressedSinceLast=${suppressed}` : ''}`,
    ),
    now: options.now,
    intervalMs: options.intervalMs,
    cacheMax: options.cacheMax,
  });
}
