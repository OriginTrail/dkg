import { createHistogram, performance } from 'node:perf_hooks';

/**
 * Event-loop delay gauge for `/api/status` (`eventLoopDelay`).
 *
 * Everything the daemon does shares one JS thread, so a synchronous stretch
 * (a large SQLite `.all()`, an ABI decode over tens of thousands of rows)
 * stalls every HTTP route, libp2p stream and timer at once. Those stalls are
 * invisible from the outside except as timeouts elsewhere; this gauge makes
 * them a number an operator can read and alert on.
 *
 * A `resolutionMs` interval timer takes one sample per tick: how much later
 * than `resolutionMs` after the previous sample it ran. That is the delay the
 * loop added, NET of the sampling interval, so an idle loop reads ~0 ms rather
 * than the interval itself (`monitorEventLoopDelay` records the raw time
 * between ticks, so an idle node showed ~22 ms). Samples go into a native HDR
 * histogram, one per window; the sampler costs one timer callback per tick,
 * the same wake-ups the native monitor's own timer made.
 *
 * The previous-sample timestamp is the sampler's own and is NEVER reset, so a
 * stall that straddles a window boundary is recorded exactly once: by the
 * first sample after it, into whichever window is open when that sample runs
 * (the next one, when the rotation timer fires first). Resetting the native
 * monitor at each rotation used to clear its previous-tick timestamp, and a
 * stall still in progress at the reset landed in no window at all.
 *
 * `/api/status` reports the last complete window (the in-progress one until
 * the first completes), and a window whose max reaches `warnThresholdMs` logs
 * ONE warning line, at most once per `warnIntervalMs`; windows skipped by that
 * limit are counted into the next warning.
 */

export interface EventLoopDelayStatusBlock {
  /** Median delay past the sampling interval in the window, ms. `null` before the first sample. */
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

/** The subset of `RecordableHistogram` used here; values are nanoseconds. */
export interface EventLoopDelayHistogram {
  readonly count: number;
  readonly max: number;
  percentile(percentile: number): number;
  /** An integer >= 1, as `RecordableHistogram.record` requires. */
  record(nanoseconds: number): void;
  reset(): void;
}

export interface EventLoopDelayMonitorOptions {
  log: (message: string) => void;
  resolutionMs?: number;
  windowMs?: number;
  warnThresholdMs?: number;
  warnIntervalMs?: number;
  /** Wall clock for window spans and the warning rate limit. */
  now?: () => number;
  /** Monotonic ms clock the sampler measures with; defaults to `performance.now`. */
  sampleClock?: () => number;
  /** Test seam; defaults to `createHistogram()`. */
  createHistogram?: () => EventLoopDelayHistogram;
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
  const sampleClock = options.sampleClock ?? (() => performance.now());
  const histogram = options.createHistogram?.() ?? createHistogram();

  let windowStartedAt = now();
  let previousSampleAt = sampleClock();
  let lastWindow: EventLoopDelayStatusBlock | undefined;
  let lastWarnAt: number | undefined;
  let suppressedWarnings = 0;

  const sample = (): void => {
    const at = sampleClock();
    const delayMs = Math.max(0, at - previousSampleAt - resolutionMs);
    previousSampleAt = at;
    // `record` takes integers >= 1 ns; 1 ns reads back as 0 ms.
    histogram.record(Math.max(1, Math.round(delayMs * NS_PER_MS)));
  };

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
    // Safe to reset: the histogram holds samples only. The time since the last
    // sample lives in `previousSampleAt`, which a rotation never touches.
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

  const sampler = setInterval(sample, resolutionMs);
  sampler.unref?.();
  const rotation = setInterval(rotate, windowMs);
  rotation.unref?.();
  let stopped = false;

  return {
    snapshot(): EventLoopDelayStatusBlock {
      return { ...(lastWindow ?? read(Math.max(0, now() - windowStartedAt))) };
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(sampler);
      clearInterval(rotation);
    },
  };
}
