/**
 * Metrics presence gate (#1066 Item 1 / R6-B).
 *
 * The node-UI metric getters include full-store SPARQL COUNT scans. Running
 * them on the periodic collector tick while nothing is consuming metrics wastes
 * CPU — and on a saturated store those scans land on already-pegged cores. This
 * helper answers "is anything currently watching metrics?" so the collector can
 * skip the store scans when the answer is no.
 *
 * A consumer is considered present when either:
 *   - a node-UI dashboard is connected (its `/api/events` SSE stream is open), or
 *   - the metric-serving HTTP routes were read recently (covers Grafana / node
 *     health probes that poll `/api/metrics[/history]` without opening the UI).
 *
 * Pure and side-effect-free apart from the internal timestamp, with an
 * injectable clock so it can be unit-tested without real time.
 */
export interface MetricsPresenceOptions {
  /** Current count of connected node-UI SSE dashboard clients. */
  sseClientCount: () => number;
  /**
   * How long after the last metric-route read a consumer still counts as
   * present. Defaults to 90s (3× the 30s collector tick) so a steady poller
   * stays "present" across ticks without flapping.
   */
  windowMs?: number;
  /**
   * Kill-switch: when true the gate always reports a consumer, restoring the
   * pre-gate "always collect" behaviour (wired to `DKG_METRICS_ALWAYS_COLLECT`).
   */
  alwaysCollect?: boolean;
  /** Injectable clock (defaults to `Date.now`); used for deterministic tests. */
  now?: () => number;
}

export interface MetricsPresence {
  /** Record that a metric consumer was just seen (call from the metric routes). */
  mark(): void;
  /** True when a metric consumer is currently present. */
  hasRecentConsumer(): boolean;
}

export const DEFAULT_METRICS_PRESENCE_WINDOW_MS = 90_000;

export function createMetricsPresence(
  opts: MetricsPresenceOptions,
): MetricsPresence {
  const windowMs = opts.windowMs ?? DEFAULT_METRICS_PRESENCE_WINDOW_MS;
  const now = opts.now ?? Date.now;
  let lastConsumerAt = Number.NEGATIVE_INFINITY;
  return {
    mark() {
      lastConsumerAt = now();
    },
    hasRecentConsumer() {
      if (opts.alwaysCollect === true) return true;
      if (opts.sseClientCount() > 0) return true;
      return now() - lastConsumerAt < windowMs;
    },
  };
}
