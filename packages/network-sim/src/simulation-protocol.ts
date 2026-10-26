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
  elapsedMs: number;
  byOp: Record<string, OpStats>;
}

export interface DoneEvent {
  type: 'done';
  total: number;
  completed: number;
  errors: number;
  elapsedMs: number;
  byOp: Record<string, OpStats>;
}

interface ErrorEvent {
  type: 'error';
  message: string;
}

export type SimEvent = OpEvent | StatusEvent | DoneEvent | ErrorEvent | { type: 'unavailable'; message: string };
export type ScopedSimEvent = SimEvent & { runId: string };
export type ScopedDoneEvent = DoneEvent & { runId: string };
export type RunStatus = Omit<StatusEvent, 'type'> & { runId: string; running: boolean };
export interface CancellationResult { stopped: boolean; runId?: string; snapshot?: ScopedDoneEvent; reason?: string }

export interface OpStats {
  ok: number;
  fail: number;
  timeouts: number;
  /** Successful-operation duration, retained for existing API consumers. */
  totalMs: number;
  allMs: number;
  phaseTotals: Record<string, number>;
  phaseCounts: Record<string, number>;
}

