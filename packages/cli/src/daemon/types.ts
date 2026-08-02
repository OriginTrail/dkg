// daemon/types.ts
//
// Pure type/interface declarations used across the daemon sub-modules.

import type { CatchupJobResult } from '../catchup-runner.js';
import type { ContextGraphConvergenceSnapshot } from '../context-graph-readiness.js';

export type CatchupJobState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "denied"
  /** Local scheduler capacity was unavailable; retry is safe. */
  | "deferred"
  /**
   * Catchup completed but no peer could deliver the CG content within
   * the run — every per-peer sync round either failed or returned
   * nothing while no responder explicitly denied access. Distinct from
   * `denied` (curator refused) and `failed` (the worker itself threw)
   * so the UI can render targeted copy + a "send signed join request"
   * CTA without misclassifying slow public CGs as denied.
   */
  | "unreachable";

export interface CatchupJob {
  jobId: string;
  contextGraphId: string;
  includeWorkspace: boolean; // kept for wire compat; semantically "includeSharedMemory"
  status: CatchupJobState;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: CatchupJobResult;
  error?: string;
}

/**
 * Mutable orchestration state for one serialized per-CG catch-up. Public job
 * records stay immutable in scope; a later SWM upgrade receives its own jobId
 * while reusing this coordinator and the same background worker.
 */
export interface CatchupCoordinator {
  contextGraphId: string;
  baseJobId: string;
  requestedIncludeSharedMemory: boolean;
  upgradeJobId?: string;
}

export interface CatchupTracker {
  jobs: Map<string, CatchupJob>;
  latestByContextGraph: Map<string, string>;
  inFlightByContextGraph?: Map<string, CatchupCoordinator>;
}

export interface CatchupConvergenceStatus extends ContextGraphConvergenceSnapshot {
  syncMode: 'on-demand' | 'always-on';
  automaticRetryActive: boolean;
}

export function toCatchupStatusResponse(
  job: CatchupJob,
  convergence?: CatchupConvergenceStatus,
) {
  const completedAfterAttempt = convergence?.state === 'complete' &&
    (job.status === 'failed' ||
      job.status === 'deferred' ||
      job.status === 'unreachable');
  return {
    ...job,
    contextGraphId: job.contextGraphId,
    includeSharedMemory: job.includeWorkspace,
    attemptStatus: job.status,
    ...(completedAfterAttempt
      ? {
          status: 'done' as const,
          error: undefined,
          ...(job.error ? { attemptError: job.error } : {}),
        }
      : {}),
    ...(convergence ? { convergence } : {}),
    ...(completedAfterAttempt ? { completedAfterAttempt: true } : {}),
  };
}
