/** The closed set shared by the UI, request validation and executor dispatch. */
export const SIMULATION_OPERATIONS = ['publish', 'query', 'workspace', 'chat'] as const;
export type SimOp = typeof SIMULATION_OPERATIONS[number];
export function isSimOp(value: unknown): value is SimOp {
  return SIMULATION_OPERATIONS.some(op => op === value);
}
export interface SimulationSettings {
  opCount: number;
  opsPerSec: number;
  concurrency: number;
  kasPerPublish: number;
  enabledOps: SimOp[];
}

export interface OpEvent {
  type: 'op';
  opType: SimOp;
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

export interface ErrorEvent {
  type: 'error';
  message: string;
  /** False for setup progress; omitted legacy errors remain counted diagnostics. */
  counted?: boolean;
}

export type SimEvent = OpEvent | StatusEvent | DoneEvent | ErrorEvent | { type: 'unavailable'; message: string };
export type ScopedSimEvent = SimEvent & { runId: string };
export type ScopedDoneEvent = DoneEvent & { runId: string };
export type RunStatus = Omit<StatusEvent, 'type'> & { runId: string; running: boolean };
export type LegacyCancellationResult = ({ stopped: true; reason?: never } | { stopped: false; reason: string }) & {
  runId?: never; snapshot?: never; retryAfterMs?: never;
};
export type ScopedCancellationResult =
  | { stopped: true; runId: string; snapshot: ScopedDoneEvent; retryAfterMs?: never; reason?: never }
  | { stopped: true; runId: string; snapshot?: never; retryAfterMs?: never; reason?: never }
  | { stopped: false; runId: string; reason: string; retryAfterMs: number; snapshot?: never }
  | { stopped: false; runId: string; reason: string; retryAfterMs?: never; snapshot?: never };
export type CancellationResult = LegacyCancellationResult | ScopedCancellationResult;

/** Validated scoped outcomes consumed by the session owner. */
export type ScopedCancellationOutcome =
  | { kind: 'completed'; runId: string; snapshot: ScopedDoneEvent }
  | { kind: 'cancelled'; runId: string }
  | { kind: 'retry'; runId: string; retryAfterMs: number; reason: string }
  | { kind: 'unconfirmed'; runId: string; reason: string };

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


/** Normalize the legacy error envelope before consumers account for diagnostics. */
export function isCountedDiagnostic(event: ErrorEvent): boolean { return event.counted !== false; }

/** New UI starts have a bounded admission window, independent of cancellation capacity.
 * The deadline is part of the ID so an arbitrarily delayed request cannot renew it.
 * Legacy IDs keep their existing reservation semantics.
 */
export const SIMULATION_START_WINDOW_MS = 30_000;
export function simulationStartExpiresAt(id: string): number | undefined {
  const match = /^sim-v1-(\d{13})-[a-zA-Z0-9_-]+$/.exec(id);
  return match ? Number(match[1]) : undefined;
}
