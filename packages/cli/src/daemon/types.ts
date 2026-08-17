// daemon/types.ts
//
// Pure type/interface declarations used across the daemon sub-modules.

import type { CatchupJobResult } from '../catchup-runner.js';

export type CatchupJobState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "denied"
  /** Local scheduler capacity was unavailable; retry is safe. */
  | "deferred"
  /**
   * The bounded job inserted verified data but ended before every requested
   * plane was complete. Graph-level synchronization may continue separately.
   */
  | "partial"
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

export interface CatchupTracker {
  jobs: Map<string, CatchupJob>;
  latestByContextGraph: Map<string, string>;
}

export interface CatchupGraphSyncStatus {
  mechanism: 'rfc64-selected-on-connect';
  state: 'inactive' | 'waiting' | 'continuing' | 'converged';
  configuredProviderCount: number;
  retryRequiredProviderCount: number;
  terminalProviderCount: number;
}

export function toCatchupStatusResponse(
  job: CatchupJob,
  graphSync?: CatchupGraphSyncStatus,
) {
  return {
    ...job,
    /** Explicit alias: `status` is retained for wire compatibility. */
    jobStatus: job.status,
    contextGraphId: job.contextGraphId,
    includeSharedMemory: job.includeWorkspace,
    ...(graphSync === undefined ? {} : { graphSync }),
  };
}
