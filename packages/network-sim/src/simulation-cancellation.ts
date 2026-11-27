import type { OpStats, ScopedCancellationOutcome, ScopedDoneEvent } from './simulation-protocol';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function metrics(value: unknown): value is OpStats {
  return record(value) && ['ok', 'fail', 'timeouts', 'totalMs', 'allMs'].every(key => nonnegative(value[key]))
    && record(value.phaseTotals) && Object.values(value.phaseTotals).every(nonnegative)
    && record(value.phaseCounts) && Object.values(value.phaseCounts).every(nonnegative);
}
function terminal(value: unknown, runId: string): value is ScopedDoneEvent {
  return record(value) && value.type === 'done' && value.runId === runId
    && ['total', 'completed', 'errors', 'elapsedMs'].every(key => nonnegative(value[key]))
    && record(value.byOp) && Object.values(value.byOp).every(metrics);
}

/** Validate wire data once; ambiguous/foreign outcomes never relinquish the active run. */
export function normalizeSimulationCancellation(value: unknown, runId: string): ScopedCancellationOutcome {
  const unconfirmed = { kind: 'unconfirmed' as const, runId, reason: 'Cancellation was not confirmed' };
  if (!record(value) || value.runId !== runId) return unconfirmed;
  if (value.stopped === true) {
    if (value.retryAfterMs !== undefined || value.reason !== undefined) return unconfirmed;
    if (value.snapshot === undefined) return { kind: 'cancelled', runId };
    return terminal(value.snapshot, runId) ? { kind: 'completed', runId, snapshot: value.snapshot } : unconfirmed;
  }
  if (value.stopped !== false || value.snapshot !== undefined) return unconfirmed;
  if (value.retryAfterMs === undefined) return unconfirmed;
  if (!nonnegative(value.retryAfterMs) || value.retryAfterMs === 0) return unconfirmed;
  return { kind: 'retry', runId, retryAfterMs: value.retryAfterMs,
    reason: typeof value.reason === 'string' ? value.reason : unconfirmed.reason };
}

export async function requestSimulationCancellation(runId: string, signal: AbortSignal): Promise<ScopedCancellationOutcome> {
  const response = await fetch(`/sim/stop?runId=${runId}`, { method: 'POST', signal });
  if (!response.ok) throw new Error('Cancellation failed');
  return normalizeSimulationCancellation(await response.json(), runId);
}
