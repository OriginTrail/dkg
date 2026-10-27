import type { DoneEvent, StatusEvent, OpStats } from './simulation-protocol';
export interface PerTypeMetrics {
  total: number;
  success: number;
  errors: number;
  totalDurationMs: number;
  successDurationMs: number;
  /** Accumulated phase durations (e.g. prepare, store, chain, broadcast) */
  phaseTotals: Record<string, number>;
  phaseCounts: Record<string, number>;
}

export interface LiveOpMetrics {
  total: number;
  success: number;
  errors: number;
  byType: Record<string, PerTypeMetrics>;
  /** Rolling window of recent op timestamps for ops/sec calculation */
  recentTimestamps: number[];
}

const emptyType = (): PerTypeMetrics => ({ total: 0, success: 0, errors: 0,
  totalDurationMs: 0, successDurationMs: 0, phaseTotals: {}, phaseCounts: {} });
export const emptyMetrics = (): LiveOpMetrics => ({ total: 0, success: 0, errors: 0, byType: {}, recentTimestamps: [] });

/** Snapshots replace observed run totals; missing operations are never invented as events. */
export function snapshotMetrics(snapshot: DoneEvent | StatusEvent, previous: LiveOpMetrics): LiveOpMetrics {
  const errors = Object.values(snapshot.byOp).reduce((sum, stats) => sum + stats.fail, 0);
  return {
    total: snapshot.completed, success: snapshot.completed - errors, errors,
    // Preserve observed timestamps, rather than manufacturing a recovery spike.
    recentTimestamps: previous.recentTimestamps,
    byType: Object.fromEntries(Object.entries(snapshot.byOp).map(([type, stats]) => [type, metricsFromOpStats(stats)])),
  };
}

/** Dictionary keys may come from daemon phase names; never read inherited entries. */
export function ownValue<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
}

function addCounts(first: Record<string, number>, second: Record<string, number>) {
  return Object.fromEntries([...new Set([...Object.keys(first), ...Object.keys(second)])]
    .map(key => [key, (ownValue(first, key) ?? 0) + (ownValue(second, key) ?? 0)]));
}

interface MetricEvent { success: boolean; durationMs: number; phases?: Record<string, number> }

/** One immutable accumulator for both streamed browser updates and server snapshots. */
export function accumulateMetric(previous: PerTypeMetrics | undefined, event: MetricEvent): PerTypeMetrics {
  const before = previous ?? emptyType();
  const phases = event.phases ?? {};
  return {
    total: before.total + 1, success: before.success + Number(event.success), errors: before.errors + Number(!event.success),
    totalDurationMs: before.totalDurationMs + event.durationMs,
    successDurationMs: before.successDurationMs + (event.success ? event.durationMs : 0),
    phaseTotals: addCounts(before.phaseTotals, phases),
    phaseCounts: addCounts(before.phaseCounts, Object.fromEntries(Object.keys(phases).map(key => [key, 1]))),
  };
}

/** Legacy wire field names are converted only at the snapshot boundary. */
export function metricsFromOpStats(stats: OpStats): PerTypeMetrics {
  return { total: stats.ok + stats.fail, success: stats.ok, errors: stats.fail,
    totalDurationMs: stats.allMs, successDurationMs: stats.totalMs,
    phaseTotals: { ...stats.phaseTotals }, phaseCounts: { ...stats.phaseCounts } };
}

export function opStatsFromMetrics(metrics: PerTypeMetrics, timeouts: number): OpStats {
  return { ok: metrics.success, fail: metrics.errors, timeouts,
    totalMs: metrics.successDurationMs, allMs: metrics.totalDurationMs,
    phaseTotals: { ...metrics.phaseTotals }, phaseCounts: { ...metrics.phaseCounts } };
}

/** Every operation updates exactly one canonical contribution: manual work or its run. */
export function recordMetric(metrics: LiveOpMetrics, event: {
  opType: string; success: boolean; durationMs: number; phases?: Record<string, number>;
}): LiveOpMetrics {
  const success = event.success ? 1 : 0, errors = event.success ? 0 : 1;
  const byType = { ...metrics.byType,
    [event.opType]: accumulateMetric(ownValue(metrics.byType, event.opType), event) };
  const now = Date.now();
  return { total: metrics.total + 1, success: metrics.success + success, errors: metrics.errors + errors,
    byType, recentTimestamps: [...metrics.recentTimestamps.filter(time => now - time < 10_000), now] };
}

/** The live dashboard is a derived view; recovery never subtracts from stored aggregates. */
export function combineMetrics(manual: LiveOpMetrics, simulation?: LiveOpMetrics): LiveOpMetrics {
  if (!simulation) return manual;
  const types = new Set([...Object.keys(manual.byType), ...Object.keys(simulation.byType)]);
  const byType = Object.fromEntries([...types].map(type => {
    const a = ownValue(manual.byType, type) ?? emptyType(), b = ownValue(simulation.byType, type) ?? emptyType();
    return [type, {
      total: a.total + b.total, success: a.success + b.success, errors: a.errors + b.errors,
      totalDurationMs: a.totalDurationMs + b.totalDurationMs,
      successDurationMs: a.successDurationMs + b.successDurationMs,
      phaseTotals: addCounts(a.phaseTotals, b.phaseTotals), phaseCounts: addCounts(a.phaseCounts, b.phaseCounts),
    }];
  }));
  return { total: manual.total + simulation.total, success: manual.success + simulation.success,
    errors: manual.errors + simulation.errors, byType,
    recentTimestamps: [...manual.recentTimestamps, ...simulation.recentTimestamps].sort((a, b) => a - b) };
}
