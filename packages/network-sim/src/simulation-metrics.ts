import type { DoneEvent, StatusEvent } from './simulation-protocol';
import type { LiveOpMetrics, PerTypeMetrics } from './store';

const emptyType = (): PerTypeMetrics => ({ total: 0, success: 0, errors: 0,
  totalDurationMs: 0, successDurationMs: 0, phaseTotals: {}, phaseCounts: {} });
export const emptyMetrics = (): LiveOpMetrics => ({ total: 0, success: 0, errors: 0, byType: {}, recentTimestamps: [] });

/** Snapshots replace observed run totals; missing operations are never invented as events. */
export function snapshotMetrics(snapshot: DoneEvent | StatusEvent, previous: LiveOpMetrics): LiveOpMetrics {
  return {
    total: snapshot.completed, success: Math.max(0, snapshot.completed - snapshot.errors), errors: snapshot.errors,
    // Preserve observed timestamps, rather than manufacturing a recovery spike.
    recentTimestamps: previous.recentTimestamps,
    byType: Object.fromEntries(Object.entries(snapshot.byOp).map(([type, stats]) => [type, {
      total: stats.ok + stats.fail, success: stats.ok, errors: stats.fail,
      totalDurationMs: stats.allMs, successDurationMs: stats.totalMs,
      phaseTotals: { ...stats.phaseTotals }, phaseCounts: { ...stats.phaseCounts },
    }])),
  };
}

function addCounts(first: Record<string, number>, second: Record<string, number>) {
  return Object.fromEntries([...new Set([...Object.keys(first), ...Object.keys(second)])]
    .map(key => [key, (first[key] ?? 0) + (second[key] ?? 0)]));
}

/** Every operation updates exactly one canonical contribution: manual work or its run. */
export function recordMetric(metrics: LiveOpMetrics, event: {
  opType: string; success: boolean; durationMs: number; phases?: Record<string, number>;
}): LiveOpMetrics {
  const before = metrics.byType[event.opType] ?? emptyType();
  const success = event.success ? 1 : 0, errors = event.success ? 0 : 1;
  const phases = event.phases ?? {};
  const byType = { ...metrics.byType, [event.opType]: {
    total: before.total + 1, success: before.success + success, errors: before.errors + errors,
    totalDurationMs: before.totalDurationMs + event.durationMs,
    successDurationMs: before.successDurationMs + (event.success ? event.durationMs : 0),
    phaseTotals: addCounts(before.phaseTotals, phases),
    phaseCounts: addCounts(before.phaseCounts, Object.fromEntries(Object.keys(phases).map(key => [key, 1]))),
  } };
  const now = Date.now();
  return { total: metrics.total + 1, success: metrics.success + success, errors: metrics.errors + errors,
    byType, recentTimestamps: [...metrics.recentTimestamps.filter(time => now - time < 10_000), now] };
}

/** The live dashboard is a derived view; recovery never subtracts from stored aggregates. */
export function combineMetrics(manual: LiveOpMetrics, simulation?: LiveOpMetrics): LiveOpMetrics {
  if (!simulation) return manual;
  const types = new Set([...Object.keys(manual.byType), ...Object.keys(simulation.byType)]);
  const byType = Object.fromEntries([...types].map(type => {
    const a = manual.byType[type] ?? emptyType(), b = simulation.byType[type] ?? emptyType();
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
