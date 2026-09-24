import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Event-loop delay gauge for `/api/status` (`eventLoopDelay`).
 *
 * Everything the daemon does shares one JS thread, so a synchronous stretch
 * (a large SQLite `.all()`, an ABI decode over tens of thousands of rows)
 * stalls every HTTP route, libp2p stream and timer at once. Those stalls are
 * invisible from the outside except as timeouts elsewhere; this gauge makes
 * them a number an operator can read and alert on.
 *
 * `monitorEventLoopDelay` samples how late a `resolutionMs` timer fires, in
 * native code, so the gauge costs nothing measurable. The histogram is read
 * and reset once per window: `/api/status` reports the last complete window
 * (the in-progress one until the first completes), and a window whose max
 * reaches `warnThresholdMs` logs ONE warning line, at most once per
 * `warnIntervalMs`; windows skipped by that limit are counted into the next
 * warning.
 */

export interface EventLoopDelayStatusBlock {
  /** Median delay in the window, ms. `null` before the first sample. */
  p50Ms: number | null;
  p99Ms: number | null;
  /** Longest single stall in the window, ms. */
  maxMs: number | null;
  /** Wall-clock span the figures cover, ms. */
  windowMs: number;
}

/** Read-only view handed to the request context. */
export interface EventLoopDelayView {
  snapshot(): EventLoopDelayStatusBlock;
}

export interface EventLoopDelayMonitor extends EventLoopDelayView {
  stop(): void;
}

/** The subset of `IntervalHistogram` read here; values are nanoseconds. */
export interface EventLoopDelayHistogram {
  readonly count: number;
  readonly max: number;
  percentile(percentile: number): number;
  reset(): void;
  enable(): boolean;
  disable(): boolean;
}

export interface EventLoopDelayMonitorOptions {
  log: (message: string) => void;
  resolutionMs?: number;
  windowMs?: number;
  warnThresholdMs?: number;
  warnIntervalMs?: number;
  now?: () => number;
  /** Test seam; defaults to `monitorEventLoopDelay({ resolution })`. */
  createHistogram?: (resolutionMs: number) => EventLoopDelayHistogram;
}

export const EVENT_LOOP_DELAY_DEFAULTS = Object.freeze({
  resolutionMs: 20,
  windowMs: 60_000,
  warnThresholdMs: 2_000,
  warnIntervalMs: 10 * 60_000,
});

const NS_PER_MS = 1e6;

function toMs(nanoseconds: number): number {
  return Math.round(nanoseconds / NS_PER_MS * 10) / 10;
}

export function startEventLoopDelayMonitor(
  options: EventLoopDelayMonitorOptions,
): EventLoopDelayMonitor {
  const resolutionMs = options.resolutionMs ?? EVENT_LOOP_DELAY_DEFAULTS.resolutionMs;
  const windowMs = options.windowMs ?? EVENT_LOOP_DELAY_DEFAULTS.windowMs;
  const warnThresholdMs = options.warnThresholdMs ?? EVENT_LOOP_DELAY_DEFAULTS.warnThresholdMs;
  const warnIntervalMs = options.warnIntervalMs ?? EVENT_LOOP_DELAY_DEFAULTS.warnIntervalMs;
  const now = options.now ?? Date.now;
  const histogram = options.createHistogram?.(resolutionMs)
    ?? monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();

  let windowStartedAt = now();
  let lastWindow: EventLoopDelayStatusBlock | undefined;
  let lastWarnAt: number | undefined;
  let suppressedWarnings = 0;

  const read = (spanMs: number): EventLoopDelayStatusBlock => {
    // An empty histogram reports max 0 and a sentinel min; say "no data".
    if (histogram.count === 0) {
      return { p50Ms: null, p99Ms: null, maxMs: null, windowMs: spanMs };
    }
    return {
      p50Ms: toMs(histogram.percentile(50)),
      p99Ms: toMs(histogram.percentile(99)),
      maxMs: toMs(histogram.max),
      windowMs: spanMs,
    };
  };

  const rotate = (): void => {
    const at = now();
    const window = read(Math.max(0, at - windowStartedAt));
    histogram.reset();
    windowStartedAt = at;
    lastWindow = window;
    if (window.maxMs === null || window.maxMs < warnThresholdMs) return;
    if (lastWarnAt !== undefined && at - lastWarnAt < warnIntervalMs) {
      suppressedWarnings += 1;
      return;
    }
    const suppressed = suppressedWarnings === 0
      ? ''
      : `; ${suppressedWarnings} more window(s) over the threshold since the last warning`;
    options.log(
      `[warn] Event loop blocked: max ${window.maxMs} ms, p99 ${window.p99Ms} ms `
        + `in the last ${Math.round(window.windowMs / 1000)} s `
        + `(threshold ${warnThresholdMs} ms)${suppressed}`,
    );
    lastWarnAt = at;
    suppressedWarnings = 0;
  };

  const timer = setInterval(rotate, windowMs);
  timer.unref?.();
  let stopped = false;

  return {
    snapshot(): EventLoopDelayStatusBlock {
      return { ...(lastWindow ?? read(Math.max(0, now() - windowStartedAt))) };
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      histogram.disable();
    },
  };
}
