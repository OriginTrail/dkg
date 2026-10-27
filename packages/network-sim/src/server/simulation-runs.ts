import type { ServerResponse } from 'node:http';
import { accumulateMetric, opStatsFromMetrics, type PerTypeMetrics } from '../simulation-metrics.js';

import type { CancellationResult, DoneEvent, OpEvent, OpStats, SimOp, RunStatus, SimEvent, ScopedSimEvent } from '../simulation-protocol.js';

export interface RunStats {
  total: number;
  completed: number;
  errors: number;
  startedAt: number;
  recentTimestamps: number[];
  operations: Map<SimOp, { metrics: PerTypeMetrics; timeouts: number }>;
}
export interface SimulationRun {
  id: string;
  abort: AbortController;
  stats: RunStats;
  terminal?: DoneEvent & { runId: string };
  errorLogCount: number;
}
export function currentOpsPerSec(stats: RunStats): number {
  const now = Date.now();
  stats.recentTimestamps = stats.recentTimestamps.filter(t => now - t < 10_000);
  if (stats.recentTimestamps.length < 2) return 0;
  const span = (now - stats.recentTimestamps[0]) / 1000;
  return span > 0 ? stats.recentTimestamps.length / span : 0;
}

/** Keeps the latest 100 completed runs in memory; IDs are never reassigned while retained. */
export class SimulationRuns {
  active: SimulationRun | null = null;
  latest: SimulationRun | null = null;
  private runs = new Map<string, SimulationRun>();
  private cancelledStarts = new Set<string>();
  private processedCancellations = new Set<string>();
  private clients = new Map<ServerResponse, string | undefined>();

  get(id: string) { return this.runs.get(id); }

  admit(id: string, total: number): { accepted: true; run: SimulationRun } | { accepted: false; error: string } {
    // Pending reservations are never evicted. Once their start has arrived,
    // retain only a bounded replay tombstone and release the pending capacity.
    if (this.cancelledStarts.delete(id)) {
      this.processedCancellations.add(id);
      if (this.processedCancellations.size > 100) this.processedCancellations.delete(this.processedCancellations.values().next().value!);
    }
    if (this.active) return { accepted: false, error: 'Simulation already running' };
    if (this.runs.has(id) || this.processedCancellations.has(id)) {
      return { accepted: false, error: 'Simulation run ID was completed or cancelled' };
    }
    const run: SimulationRun = { id, abort: new AbortController(), errorLogCount: 0,
      stats: { total, completed: 0, errors: 0, startedAt: Date.now(), recentTimestamps: [], operations: new Map() } };
    this.runs.set(id, run);
    this.active = this.latest = run;
    return { accepted: true, run };
  }

  status(run: SimulationRun): RunStatus {
    return { runId: run.id, running: !run.terminal, total: run.stats.total,
      completed: run.stats.completed, errors: run.stats.errors,
      elapsedMs: run.terminal?.elapsedMs ?? Date.now() - run.stats.startedAt,
      opsPerSec: run.terminal ? 0 : Math.round(currentOpsPerSec(run.stats) * 10) / 10, byOp: this.snapshotOperations(run) };
  }

  private snapshotOperations(run: SimulationRun): Record<string, OpStats> {
    return Object.fromEntries([...run.stats.operations].map(([op, { metrics, timeouts }]) =>
      [op, opStatsFromMetrics(metrics, timeouts)]));
  }

  record(run: SimulationRun, event: OpEvent): boolean {
    if (run.terminal) return false;
    const stats = run.stats;
    stats.completed++;
    stats.recentTimestamps.push(Date.now());
    if (!event.success) stats.errors++;
    const previous = stats.operations.get(event.opType);
    stats.operations.set(event.opType, {
      metrics: accumulateMetric(previous?.metrics, event),
      timeouts: (previous?.timeouts ?? 0) + Number(!event.success && event.detail.startsWith('timeout')),
    });
    this.emit(run, event);
    return true;
  }

  fail(run: SimulationRun, error: unknown) {
    if (run.terminal) return;
    run.stats.errors++;
    this.emit(run, { type: 'error', message: String(error instanceof Error ? error.message : error) });
  }

  emit(run: SimulationRun, event: SimEvent) {
    if (run.terminal) return;
    if (event.type === 'op' && !event.success && run.errorLogCount < 20) {
      run.errorLogCount++;
      console.error(`[sim] error #${run.errorLogCount}: ${event.opType} node${event.nodeId} — ${event.detail}`);
    }
    this.publish(run.id, { ...event, runId: run.id });
  }

  finish(run: SimulationRun) {
    if (run.terminal) return run.terminal;
    run.terminal = { type: 'done', runId: run.id, total: run.stats.total,
      completed: run.stats.completed, errors: run.stats.errors,
      elapsedMs: Date.now() - run.stats.startedAt, byOp: this.snapshotOperations(run) };
    if (this.active === run) this.active = null;
    this.publish(run.id, run.terminal);
    for (const [client, scope] of this.clients) {
      if (scope === run.id) { this.clients.delete(client); client.end(); }
    }
    const terminalIds = [...this.runs.values()].filter(item => item.terminal).map(item => item.id);
    for (const id of terminalIds.slice(0, -100)) this.runs.delete(id);
    return run.terminal;
  }

  cancel(id?: string): CancellationResult {
    const run = id ? this.get(id) : this.active;
    if (!run) {
      if (!id) return { stopped: false, reason: 'No simulation running' };
      if (this.processedCancellations.has(id)) return { stopped: true, runId: id };
      // A stop may arrive before the corresponding start body has been read.
      if (!this.cancelledStarts.has(id) && this.cancelledStarts.size >= 100) {
        return { stopped: false, runId: id, reason: 'Pending cancellation limit reached; retry after start is accepted' };
      }
      this.cancelledStarts.add(id);
      return { stopped: true, runId: id };
    }
    run.abort.abort();
    const snapshot = this.finish(run);
    return id ? { stopped: true, runId: id, snapshot } : { stopped: true };
  }

  subscribe(client: ServerResponse, id?: string) {
    const run = id ? this.get(id) : this.active;
    if (id && !run) {
      this.send(client, { type: 'unavailable', runId: id, message: 'Results for this simulation are no longer available.' });
      client.end();
      return;
    }
    this.clients.set(client, id);
    if (run) {
      const snapshot: ScopedSimEvent = run.terminal ?? { type: 'status', ...this.status(run) };
      this.send(client, snapshot);
      if (id && run.terminal) { this.clients.delete(client); client.end(); }
    }
  }

  unsubscribe(client: ServerResponse) { this.clients.delete(client); }

  private publish(id: string, event: ScopedSimEvent) {
    for (const [client, scope] of this.clients) {
      if (!scope || scope === id) this.send(client, event);
    }
  }

  private send(client: ServerResponse, event: ScopedSimEvent) {
    try { client.write(`data: ${JSON.stringify(event)}\n\n`); }
    catch { this.clients.delete(client); }
  }
}
