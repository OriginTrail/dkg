import type { CatchupJobResult } from './catchup-result-wire.js';
import type { ContextGraphConvergenceSnapshot } from './context-graph-readiness-wire.js';

export type CatchupJobState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'denied'
  /** Local scheduler capacity was unavailable; retry is safe. */
  | 'deferred'
  /**
   * Peers were reachable, but none delivered every required plane during this
   * attempt. This remains distinct from authorization denial and worker error.
   */
  | 'unreachable';

export interface CatchupConvergenceStatus extends ContextGraphConvergenceSnapshot {
  syncMode: 'on-demand' | 'always-on';
  automaticRetryActive: boolean;
}

/** Shared daemon/client contract for the catch-up status endpoint. */
export interface CatchupStatusResponse {
  jobId: string;
  contextGraphId: string;
  includeWorkspace: boolean;
  includeSharedMemory: boolean;
  /** Canonical actionable status, including newer live convergence evidence. */
  status: CatchupJobState;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: CatchupJobResult;
  error?: string;
  /** Historical runner outcome, emitted only when it differs from status. */
  attempt?: {
    status: CatchupJobState;
    error?: string;
  };
  convergence?: CatchupConvergenceStatus;
  completedAfterAttempt?: true;
}
