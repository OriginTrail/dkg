/**
 * Shared helpers for the node-communication benchmark.
 *
 * These utilities are intentionally dependency-free (only Node built-ins) so the
 * benchmark and the regression checker can run on a bare `tsx` invocation in a
 * cron / launchd job without a prior `pnpm install` beyond the workspace.
 */
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

export interface DurationStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  stddev: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `read` until `predicate` is satisfied or the deadline passes. Returns the
 * elapsed milliseconds when satisfied, or `null` on timeout. Uses
 * `performance.now()` for sub-millisecond resolution.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs: number; intervalMs?: number; startedAt?: number },
): Promise<{ elapsedMs: number; value: T } | { elapsedMs: number; value: T | null; timedOut: true }> {
  const intervalMs = options.intervalMs ?? 25;
  const startedAt = options.startedAt ?? performance.now();
  const deadline = startedAt + options.timeoutMs;
  let last: T | null = null;
  while (performance.now() < deadline) {
    const value = await read();
    last = value;
    if (predicate(value)) {
      return { elapsedMs: performance.now() - startedAt, value };
    }
    await sleep(intervalMs);
  }
  return { elapsedMs: performance.now() - startedAt, value: last, timedOut: true };
}

export function summarize(samples: number[]): DurationStats {
  if (samples.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, median: 0, p95: 0, stddev: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const mean = sum / count;
  const variance = sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / count;
  return {
    count,
    min: sorted[0],
    max: sorted[count - 1],
    mean: round(mean),
    median: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    stddev: round(Math.sqrt(variance)),
  };
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = Math.ceil((pct / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Median of an arbitrary numeric array (returns 0 for empty input). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Recursively sum the byte size of every regular file under `dir`. */
export async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        // File vanished between readdir and stat (e.g. store flush). Ignore.
      }
    }
  }
  return total;
}

/** Samples process RSS on an interval and tracks the peak. */
export class MemorySampler {
  private timer: NodeJS.Timeout | null = null;
  private peakRss = 0;
  private peakHeapUsed = 0;

  start(intervalMs = 100): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private sample(): void {
    const usage = process.memoryUsage();
    if (usage.rss > this.peakRss) this.peakRss = usage.rss;
    if (usage.heapUsed > this.peakHeapUsed) this.peakHeapUsed = usage.heapUsed;
  }

  stop(): { peakRssBytes: number; peakHeapUsedBytes: number; finalRssBytes: number; finalHeapUsedBytes: number } {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sample();
    // Best-effort GC for a more stable heap number when run with --expose-gc.
    const maybeGc = (globalThis as { gc?: () => void }).gc;
    if (typeof maybeGc === 'function') maybeGc();
    const usage = process.memoryUsage();
    return {
      peakRssBytes: this.peakRss,
      peakHeapUsedBytes: this.peakHeapUsed,
      finalRssBytes: usage.rss,
      finalHeapUsedBytes: usage.heapUsed,
    };
  }
}

/**
 * The set of numeric indicators we track day-over-day. Keeping this curated (vs
 * flattening the whole result) keeps `history.ndjson` and the regression report
 * focused on signal, not config/env noise. Every metric here is "higher is
 * worse" — a meaningful increase is a regression.
 */
export interface NodeCommsResult {
  schemaVersion: number;
  benchmark: string;
  timestamp: string;
  env: Record<string, unknown>;
  config: Record<string, unknown>;
  scenarios: Record<string, ScenarioResult>;
  process: { peakRssBytes: number; peakHeapUsedBytes: number; finalRssBytes: number; finalHeapUsedBytes: number };
  disk: { nodeA: { dataDirBytes: number }; nodeB: { dataDirBytes: number } };
}

export interface ScenarioResult {
  description: string;
  itemCount: number;
  iterations: number;
  samplesMs: number[];
  durationMs: DurationStats;
  perItemMsMean?: number;
  receiver: { diskBytes: number; storeQuads: number };
  timedOut?: boolean;
}

/** Flatten a result into the curated `metric -> value` map used for comparison. */
export function collectMetrics(result: NodeCommsResult): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const [name, scenario] of Object.entries(result.scenarios)) {
    metrics[`scenario.${name}.durationMs.median`] = scenario.durationMs.median;
    metrics[`scenario.${name}.durationMs.p95`] = scenario.durationMs.p95;
    metrics[`scenario.${name}.durationMs.mean`] = scenario.durationMs.mean;
    if (typeof scenario.perItemMsMean === 'number') {
      metrics[`scenario.${name}.perItemMsMean`] = scenario.perItemMsMean;
    }
    metrics[`scenario.${name}.receiver.diskBytes`] = scenario.receiver.diskBytes;
    metrics[`scenario.${name}.receiver.storeQuads`] = scenario.receiver.storeQuads;
  }
  // Peak RSS is the stable "how much memory did the run use" high-water mark.
  // `finalRssBytes` is intentionally excluded from comparison: RSS does not
  // shrink predictably after work completes, so it produces noisy false-positive
  // regressions. Peak RSS + heap (post-GC when run with --expose-gc) are stable.
  metrics['process.peakRssBytes'] = result.process.peakRssBytes;
  metrics['process.peakHeapUsedBytes'] = result.process.peakHeapUsedBytes;
  metrics['process.finalHeapUsedBytes'] = result.process.finalHeapUsedBytes;
  metrics['disk.nodeA.dataDirBytes'] = result.disk.nodeA.dataDirBytes;
  metrics['disk.nodeB.dataDirBytes'] = result.disk.nodeB.dataDirBytes;
  return metrics;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return String(bytes);
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${round(value)} ${units[unit]}`;
}

// ── Pretty terminal output ────────────────────────────────────────────────
/**
 * ANSI colour is enabled only for an interactive TTY (so the daily runner,
 * which tees output to a log file, stays clean plain-text). Honours the
 * `NO_COLOR` and `FORCE_COLOR` conventions.
 */
function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
  return Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
}

const COLOR = colorEnabled();
const paint = (code: string) => (s: string): string => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);

/** Minimal, dependency-free ANSI styler. No-ops when colour is disabled. */
export const style = {
  enabled: COLOR,
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
  gray: paint('90'),
};

/** Visible width of a string, ignoring ANSI escape sequences. */
export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Right-pad to a visible width (ANSI-aware). */
export function padEndVisible(s: string, width: number): string {
  const pad = width - visibleLength(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/** Left-pad to a visible width (ANSI-aware). */
export function padStartVisible(s: string, width: number): string {
  const pad = width - visibleLength(s);
  return pad > 0 ? ' '.repeat(pad) + s : s;
}
