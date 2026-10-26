import type { DoneEvent, StatusEvent } from './simulation-protocol';
import type { LiveOpMetrics, PerTypeMetrics } from './store';

const emptyType = (): PerTypeMetrics => ({ total: 0, success: 0, errors: 0,
  totalDurationMs: 0, successDurationMs: 0, phaseTotals: {}, phaseCounts: {} });

/** Snapshots replace observed run totals; missing operations are never invented as events. */
export function snapshotMetrics(snapshot: DoneEvent | StatusEvent, previous: LiveOpMetrics): LiveOpMetrics {
  return {
    total: snapshot.completed, success: Math.max(0, snapshot.completed - snapshot.errors), errors: snapshot.errors,
    // A snapshot has no individual completion timestamps. Keep only observed
    // timestamps for the rolling rate, rather than manufacturing a recovery spike.
    recentTimestamps: previous.recentTimestamps,
    byType: Object.fromEntries(Object.entries(snapshot.byOp).map(([type, stats]) => [type, {
      total: stats.ok + stats.fail, success: stats.ok, errors: stats.fail,
      totalDurationMs: stats.allMs, successDurationMs: stats.totalMs,
      phaseTotals: { ...stats.phaseTotals }, phaseCounts: { ...stats.phaseCounts },
    }])),
  };
}

function replaceCounts(current: Record<string, number>, before: Record<string, number>, after: Record<string, number>) {
  return Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(before), ...Object.keys(after)])]
    .map(key => [key, (current[key] ?? 0) - (before[key] ?? 0) + (after[key] ?? 0)]));
}

/** Correct the run's contribution while preserving manual work in the live dashboard. */
export function reconcileLiveMetrics(current: LiveOpMetrics, before: LiveOpMetrics, after: LiveOpMetrics): LiveOpMetrics {
  const types = new Set([...Object.keys(current.byType), ...Object.keys(before.byType), ...Object.keys(after.byType)]);
  const byType = Object.fromEntries([...types].map(type => {
    const c = current.byType[type] ?? emptyType(), b = before.byType[type] ?? emptyType(), a = after.byType[type] ?? emptyType();
    return [type, {
      total: c.total - b.total + a.total,
      success: c.success - b.success + a.success,
      errors: c.errors - b.errors + a.errors,
      totalDurationMs: c.totalDurationMs - b.totalDurationMs + a.totalDurationMs,
      successDurationMs: c.successDurationMs - b.successDurationMs + a.successDurationMs,
      phaseTotals: replaceCounts(c.phaseTotals, b.phaseTotals, a.phaseTotals),
      phaseCounts: replaceCounts(c.phaseCounts, b.phaseCounts, a.phaseCounts),
    }];
  }));
  return { ...current, total: current.total - before.total + after.total,
    success: current.success - before.success + after.success,
    errors: current.errors - before.errors + after.errors, byType };
}
