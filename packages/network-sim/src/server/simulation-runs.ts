import type { ServerResponse } from 'node:http';

export interface OpEvent {
  type: 'op';
  opType: string;
  nodeId: number;
  success: boolean;
  durationMs: number;
  detail: string;
  phases: Record<string, number>;
}

export interface StatusEvent {
  type: 'status';
  total: number;
  completed: number;
  errors: number;
  opsPerSec: number;
}

export interface DoneEvent {
  type: 'done';
  total: number;
  completed: number;
  errors: number;
  elapsedMs: number;
  byOp?: Record<string, OpStats>;
}

interface ErrorEvent {
  type: 'error';
  message: string;
}

export type SimEvent = OpEvent | StatusEvent | DoneEvent | ErrorEvent;

export interface OpStats {
  ok: number;
  fail: number;
  timeouts: number;
  totalMs: number;
}

export interface RunStats {
  total: number;
  completed: number;
  errors: number;
  startedAt: number;
  recentTimestamps: number[];
  byOp: Record<string, OpStats>;
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
  private clients = new Map<ServerResponse, string | undefined>();

  get(id: string) { return this.runs.get(id); }
  wasCancelled(id: string) { return this.cancelledStarts.has(id); }

  create(id: string, total: number): SimulationRun {
    const run: SimulationRun = { id, abort: new AbortController(), errorLogCount: 0,
      stats: { total, completed: 0, errors: 0, startedAt: Date.now(), recentTimestamps: [], byOp: {} } };
    this.runs.set(id, run);
    this.active = this.latest = run;
    return run;
  }

  status(run: SimulationRun) {
    return { runId: run.id, running: !run.terminal, total: run.stats.total,
      completed: run.stats.completed, errors: run.stats.errors,
      elapsedMs: run.terminal?.elapsedMs ?? Date.now() - run.stats.startedAt,
      opsPerSec: run.terminal ? 0 : Math.round(currentOpsPerSec(run.stats) * 10) / 10, byOp: run.stats.byOp };
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
      elapsedMs: Date.now() - run.stats.startedAt, byOp: structuredClone(run.stats.byOp) };
    if (this.active === run) this.active = null;
    this.publish(run.id, run.terminal);
    for (const [client, scope] of this.clients) {
      if (scope === run.id) { this.clients.delete(client); client.end(); }
    }
    const terminalIds = [...this.runs.values()].filter(item => item.terminal).map(item => item.id);
    for (const id of terminalIds.slice(0, -100)) this.runs.delete(id);
    return run.terminal;
  }

  cancel(id?: string) {
    const run = id ? this.get(id) : this.active;
    if (!run) {
      if (!id) return { stopped: false, reason: 'No simulation running' };
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
      const snapshot = run.terminal ?? { type: 'status', ...this.status(run) };
      this.send(client, snapshot);
      if (id && run.terminal) { this.clients.delete(client); client.end(); }
    }
  }

  unsubscribe(client: ServerResponse) { this.clients.delete(client); }

  private publish(id: string, event: object) {
    for (const [client, scope] of this.clients) {
      if (!scope || scope === id) this.send(client, event);
    }
  }

  private send(client: ServerResponse, event: object) {
    try { client.write(`data: ${JSON.stringify(event)}\n\n`); }
    catch { this.clients.delete(client); }
  }
}
