// daemon/types.ts
//
// Pure type/interface declarations used across the daemon sub-modules.

import type { CatchupJobResult } from '../catchup-runner.js';
import type { CatchupJobState } from '../catchup-status-wire.js';

export type { CatchupJobState } from '../catchup-status-wire.js';

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
  upgradeJobId?: string;
  narrowProjectionJobId?: string;
}

export interface CatchupTracker {
  jobs: Map<string, CatchupJob>;
  latestByContextGraph: Map<string, string>;
  inFlightByContextGraph: Map<string, CatchupCoordinator>;
}
