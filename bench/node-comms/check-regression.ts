/**
 * Regression checker for the node-communication benchmark.
 *
 * Compares the current run's curated metrics against a reference and flags any
 * metric that regressed beyond a threshold (default 15%). Every tracked metric
 * is "higher is worse" (latency, memory, disk, stored-quad count), so a
 * regression is a meaningful *increase*.
 *
 * To stay robust against the inherent run-to-run jitter of microbenchmarks
 * (which `BENCHMARKING.md` calls out), the checker uses three guards:
 *
 *   1. Rolling-median baseline — when no explicit `baseline.json` is pinned, the
 *      reference is the per-metric MEDIAN of the last N runs in `history.ndjson`,
 *      not a single noisy previous run.
 *   2. Absolute-delta floor — a metric must move by both the percent threshold
 *      AND a minimum absolute amount to flag, so a 6ms→8ms (+33%) blip never
 *      trips while a 480MB→560MB memory jump does.
 *   3. Baseline warmup — with no pinned baseline and fewer than
 *      `minReferenceSamples` historical runs, deltas are reported but the run is
 *      NOT failed, letting the baseline "learn" before it starts enforcing.
 *
 * Invocations:
 *   - In-process from the runner via {@link runRegressionCheck}.
 *   - Standalone: `tsx bench/node-comms/check-regression.ts [--dir <dir>]`.
 *
 * Exit code is 1 only when a regression is flagged AND enforcement is active.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMetrics, formatBytes, median, round, type NodeCommsResult } from './lib.ts';

export const DEFAULT_THRESHOLD_PCT = 15;
export const DEFAULT_WINDOW = 10;
export const DEFAULT_MIN_REFERENCE_SAMPLES = 3;

/** Minimum absolute change required (per metric kind) before a percent delta can flag. */
export interface MinDeltaConfig {
  ms: number;
  memBytes: number;
  diskBytes: number;
  quads: number;
}

export function defaultMinDelta(): MinDeltaConfig {
  return {
    ms: numEnv('BENCH_MIN_DELTA_MS', 15),
    memBytes: numEnv('BENCH_MIN_DELTA_MEM_BYTES', 32 * 1024 * 1024),
    diskBytes: numEnv('BENCH_MIN_DELTA_DISK_BYTES', 4 * 1024),
    quads: numEnv('BENCH_MIN_DELTA_QUADS', 1),
  };
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function minAbsDeltaFor(metric: string, cfg: MinDeltaConfig): number {
  if (metric.endsWith('storeQuads')) return cfg.quads;
  if (metric.includes('Rss') || metric.includes('Heap')) return cfg.memBytes;
  if (metric.endsWith('Bytes')) return cfg.diskBytes;
  return cfg.ms; // duration / per-item latency metrics
}

export interface Comparison {
  metric: string;
  reference: number;
  current: number;
  deltaPct: number | null;
  absDelta: number;
  direction: 'regression' | 'improvement' | 'stable' | 'new';
  flagged: boolean;
  /**
   * Reported but never gates the build. Tail/spread statistics (`p95`) are
   * informational because at the default sample counts (5 latency, 3 catch-up)
   * `p95` is just the single worst sample — too noisy to fail CI on. They still
   * show in the report so a real tail-latency drift is visible; gate on the
   * robust `median`/`mean` instead. See `isInformationalMetric`.
   */
  informational: boolean;
}

/**
 * Metrics that are shown in the report but excluded from build-failing.
 * `p95` only becomes a meaningful percentile at ~20+ iterations; below that it
 * equals the max sample and false-flags constantly on shared CI runners. Raise
 * `--iterations` to 20+ if you want statistically meaningful tail gating.
 */
export function isInformationalMetric(metric: string): boolean {
  return metric.endsWith('.p95') || metric.endsWith('.max') || metric.endsWith('.stddev');
}

export interface ReferenceMetrics {
  label: string;
  timestamp: string;
  source: 'baseline-file' | 'rolling-median';
  sampleCount: number;
  metrics: Record<string, number>;
}

export interface RegressionReport {
  generatedAt: string;
  thresholdPct: number;
  minDelta: MinDeltaConfig;
  enforced: boolean;
  reference: { label: string; timestamp: string; source: string; sampleCount: number } | null;
  current: { timestamp: string };
  comparisons: Comparison[];
  flagged: Comparison[];
  improvements: Comparison[];
  /** Informational (non-gating) metrics that crossed the threshold — reported, not failed. */
  informationalOverThreshold: Comparison[];
  regressionCount: number;
  shouldFail: boolean;
}

function isByteMetric(metric: string): boolean {
  return metric.endsWith('Bytes');
}

export function compareMetrics(
  current: Record<string, number>,
  reference: Record<string, number>,
  thresholdPct: number,
  minDelta: MinDeltaConfig,
): Comparison[] {
  const comparisons: Comparison[] = [];
  for (const [metric, currentValue] of Object.entries(current)) {
    const informational = isInformationalMetric(metric);
    if (!(metric in reference)) {
      comparisons.push({
        metric, reference: Number.NaN, current: currentValue, deltaPct: null,
        absDelta: Number.NaN, direction: 'new', flagged: false, informational,
      });
      continue;
    }
    const referenceValue = reference[metric];
    const absDelta = currentValue - referenceValue;
    let deltaPct: number;
    if (referenceValue === 0) {
      deltaPct = currentValue === 0 ? 0 : Number.POSITIVE_INFINITY;
    } else {
      deltaPct = round(((currentValue - referenceValue) / Math.abs(referenceValue)) * 100);
    }

    const floor = minAbsDeltaFor(metric, minDelta);
    const movedEnough = Math.abs(absDelta) >= floor;
    let direction: Comparison['direction'] = 'stable';
    let flagged = false;
    if (deltaPct > thresholdPct && movedEnough) {
      direction = 'regression';
      // Informational metrics show their regression direction but never gate.
      flagged = !informational;
    } else if (deltaPct < -thresholdPct && movedEnough) {
      direction = 'improvement';
    }

    comparisons.push({ metric, reference: referenceValue, current: currentValue, deltaPct, absDelta, direction, flagged, informational });
  }
  return comparisons.sort((a, b) => (b.deltaPct ?? -Infinity) - (a.deltaPct ?? -Infinity));
}

/** Parse all metric maps from history.ndjson (oldest → newest). */
async function readHistory(historyFile: string): Promise<Array<{ timestamp: string; metrics: Record<string, number> }>> {
  if (!existsSync(historyFile)) return [];
  let raw: string;
  try {
    raw = await readFile(historyFile, 'utf8');
  } catch {
    return [];
  }
  const entries: Array<{ timestamp: string; metrics: Record<string, number> }> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { timestamp?: string; metrics?: Record<string, number> };
      if (parsed?.metrics) entries.push({ timestamp: parsed.timestamp ?? 'unknown', metrics: parsed.metrics });
    } catch {
      // skip malformed line
    }
  }
  return entries;
}

export async function loadReference(
  dir: string,
  options: { baselineFile?: string; window?: number; excludeTimestamp?: string } = {},
): Promise<ReferenceMetrics | null> {
  const baselinePath = options.baselineFile ?? join(dir, 'baseline.json');
  if (existsSync(baselinePath)) {
    try {
      const result = JSON.parse(await readFile(baselinePath, 'utf8')) as NodeCommsResult;
      return {
        label: baselinePath,
        timestamp: result.timestamp ?? 'unknown',
        source: 'baseline-file',
        sampleCount: 1,
        metrics: collectMetrics(result),
      };
    } catch {
      // fall through to rolling median
    }
  }

  const window = options.window ?? DEFAULT_WINDOW;
  const allHistory = await readHistory(join(dir, 'history.ndjson'));
  // Exclude the current run (the runner appends it after this check; the
  // standalone re-check reads a history that already contains it) so the
  // reference is strictly *previous* runs and stays comparable across both.
  const history = options.excludeTimestamp
    ? allHistory.filter((e) => e.timestamp !== options.excludeTimestamp)
    : allHistory;
  if (history.length === 0) return null;

  const recent = history.slice(-window);
  const metricNames = new Set<string>();
  for (const entry of recent) for (const name of Object.keys(entry.metrics)) metricNames.add(name);

  const metrics: Record<string, number> = {};
  for (const name of metricNames) {
    const values = recent.map((e) => e.metrics[name]).filter((v): v is number => typeof v === 'number');
    if (values.length > 0) metrics[name] = round(median(values));
  }
  return {
    label: `rolling median of last ${recent.length} run(s)`,
    timestamp: `${recent[0].timestamp} … ${recent[recent.length - 1].timestamp}`,
    source: 'rolling-median',
    sampleCount: recent.length,
    metrics,
  };
}

function fmt(metric: string, value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (isByteMetric(metric)) return formatBytes(value);
  if (metric.includes('storeQuads')) return `${value} quads`;
  return `${round(value)} ms`;
}

function deltaLabel(c: Comparison): string {
  if (c.deltaPct === null) return '   n/a';
  if (c.deltaPct === Number.POSITIVE_INFINITY) return '   +∞%';
  return `${c.deltaPct >= 0 ? '+' : ''}${c.deltaPct}%`;
}

export function renderReport(report: RegressionReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════════');
  lines.push('  node-comms benchmark — regression check');
  lines.push('═══════════════════════════════════════════════════════════════════');
  if (!report.reference) {
    lines.push('  No reference found — this run establishes the baseline.');
    lines.push('  Re-run after the next benchmark to compare day-over-day.');
    lines.push('═══════════════════════════════════════════════════════════════════');
    return lines.join('\n');
  }
  lines.push(`  reference : ${report.reference.label}`);
  lines.push(`              (${report.reference.timestamp}, via ${report.reference.source})`);
  lines.push(`  threshold : +${report.thresholdPct}%  (higher = worse for every metric)`);
  lines.push(`  floors    : ${report.minDelta.ms}ms · ${formatBytes(report.minDelta.memBytes)} mem · ${formatBytes(report.minDelta.diskBytes)} disk · ${report.minDelta.quads} quad`);
  if (!report.enforced) {
    lines.push(`  mode      : REPORT-ONLY (baseline warming up — ${report.reference.sampleCount}/${DEFAULT_MIN_REFERENCE_SAMPLES} runs)`);
  }
  lines.push('───────────────────────────────────────────────────────────────────');
  for (const c of report.comparisons) {
    const marker = c.flagged
      ? '🚩'
      : c.informational && c.direction === 'regression'
        ? '📊' // over threshold but non-gating (tail/spread stat)
        : c.direction === 'improvement'
          ? '✅'
          : c.direction === 'new'
            ? '🆕'
            : '  ';
    const label = c.informational ? `${c.metric} (info)` : c.metric;
    lines.push(`  ${marker} ${label.padEnd(52)} ${deltaLabel(c).padStart(9)}`);
    if (c.direction !== 'new') {
      lines.push(`        ${fmt(c.metric, c.reference)}  →  ${fmt(c.metric, c.current)}`);
    } else {
      lines.push(`        (no reference value) → ${fmt(c.metric, c.current)}`);
    }
  }
  lines.push('───────────────────────────────────────────────────────────────────');
  if (report.regressionCount === 0) {
    lines.push('  ✅ No regressions above threshold.');
  } else if (!report.enforced) {
    lines.push(`  ⚠️  ${report.regressionCount} metric(s) above +${report.thresholdPct}% — NOT failing (baseline warming up).`);
  } else {
    lines.push(`  🚩 ${report.regressionCount} regression(s) above +${report.thresholdPct}% — FLAGGED.`);
  }
  if (report.informationalOverThreshold.length > 0) {
    lines.push(`  📊 ${report.informationalOverThreshold.length} informational metric(s) above +${report.thresholdPct}% (tail/spread — not gating):`);
    for (const c of report.informationalOverThreshold) {
      lines.push(`     - ${c.metric}: ${fmt(c.metric, c.reference)} → ${fmt(c.metric, c.current)} (${deltaLabel(c).trim()})`);
    }
  }
  for (const c of report.flagged) {
    lines.push(`     - ${c.metric}: ${fmt(c.metric, c.reference)} → ${fmt(c.metric, c.current)} (${deltaLabel(c).trim()})`);
  }
  lines.push('═══════════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

export async function runRegressionCheck(options: {
  result: NodeCommsResult;
  dir: string;
  thresholdPct?: number;
  baselineFile?: string;
  window?: number;
  minReferenceSamples?: number;
  minDelta?: MinDeltaConfig;
  write?: boolean;
  excludeTimestamp?: string;
}): Promise<RegressionReport> {
  const thresholdPct = options.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const minDelta = options.minDelta ?? defaultMinDelta();
  const minReferenceSamples = options.minReferenceSamples ?? DEFAULT_MIN_REFERENCE_SAMPLES;
  const current = collectMetrics(options.result);
  const reference = await loadReference(options.dir, {
    baselineFile: options.baselineFile,
    window: options.window,
    excludeTimestamp: options.excludeTimestamp,
  });

  const comparisons = reference ? compareMetrics(current, reference.metrics, thresholdPct, minDelta) : [];
  const flagged = comparisons.filter((c) => c.flagged);
  const improvements = comparisons.filter((c) => c.direction === 'improvement');
  const informationalOverThreshold = comparisons.filter((c) => c.informational && c.direction === 'regression');

  // A pinned baseline file always enforces. A rolling-median reference only
  // enforces once enough runs exist to be statistically meaningful.
  const enforced = !!reference
    && (reference.source === 'baseline-file' || reference.sampleCount >= minReferenceSamples);

  const report: RegressionReport = {
    generatedAt: new Date().toISOString(),
    thresholdPct,
    minDelta,
    enforced,
    reference: reference
      ? { label: reference.label, timestamp: reference.timestamp, source: reference.source, sampleCount: reference.sampleCount }
      : null,
    current: { timestamp: options.result.timestamp },
    comparisons,
    flagged,
    improvements,
    informationalOverThreshold,
    regressionCount: flagged.length,
    shouldFail: enforced && flagged.length > 0,
  };

  if (options.write !== false) {
    await writeFile(join(options.dir, 'regression-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = flag('--dir') ?? join(process.cwd(), 'bench', 'results', 'node-comms');
  const thresholdPct = flag('--threshold') !== undefined
    ? Number(flag('--threshold'))
    : numEnv('BENCH_REGRESSION_THRESHOLD_PCT', DEFAULT_THRESHOLD_PCT);
  const window = flag('--window') !== undefined ? Number(flag('--window')) : numEnv('BENCH_REGRESSION_WINDOW', DEFAULT_WINDOW);
  const minReferenceSamples = numEnv('BENCH_REGRESSION_MIN_SAMPLES', DEFAULT_MIN_REFERENCE_SAMPLES);
  const baselineFile = flag('--baseline-file');

  const latestPath = join(dir, 'latest.json');
  if (!existsSync(latestPath)) {
    console.error(`No latest.json found at ${latestPath}. Run the benchmark first.`);
    process.exit(2);
  }
  const result = JSON.parse(await readFile(latestPath, 'utf8')) as NodeCommsResult;
  const report = await runRegressionCheck({
    result,
    dir,
    thresholdPct,
    baselineFile,
    window,
    minReferenceSamples,
    excludeTimestamp: result.timestamp,
  });
  console.log(renderReport(report));
  process.exit(report.shouldFail ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
