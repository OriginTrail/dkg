import { createHistogram, type RecordableHistogram } from 'node:perf_hooks';

/** Percentiles of the samples recorded since the previous {@link IntervalLatency.take}. */
export interface LatencySummary {
  /** Samples in the window. The percentiles are `null` when this is 0. */
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

/** Longest duration recorded: about 11 days, far above any queue wait or admission latency. */
const MAX_MS = 1e9;

/**
 * A latency window that is read and emptied by one consumer (the periodic usage line).
 * Samples are kept in a fixed-size HDR histogram in microseconds, so recording costs no
 * memory growth however long the window runs, and a percentile is exact to three digits.
 */
export class IntervalLatency {
  private readonly histogram: RecordableHistogram = createHistogram();
  /** Kept apart from the histogram, whose own maximum is rounded up to its bucket. */
  private longestMs = 0;

  /** Ignores a non-finite or negative value. Never throws. */
  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    try {
      const bounded = Math.min(ms, MAX_MS);
      // The histogram rejects 0, so the smallest sample is one microsecond.
      this.histogram.record(Math.max(1, Math.round(bounded * 1000)));
      this.longestMs = Math.max(this.longestMs, bounded);
    } catch {
      // A rejected sample must never reach queue code.
    }
  }

  /** The window so far, which then starts empty. */
  take(): LatencySummary {
    const histogram = this.histogram;
    const n = histogram.count;
    const summary: LatencySummary = n === 0
      ? { n: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null }
      : {
        n,
        p50Ms: histogram.percentile(50) / 1000,
        p95Ms: histogram.percentile(95) / 1000,
        p99Ms: histogram.percentile(99) / 1000,
        maxMs: this.longestMs,
      };
    histogram.reset();
    this.longestMs = 0;
    return summary;
  }
}
