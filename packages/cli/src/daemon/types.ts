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

export type CatchupScope = 'durable' | 'durable-and-shared-memory';

export interface CatchupExecution {
  jobId: string;
  scope: CatchupScope;
}

export type CatchupJobView =
  | {
      jobId: string;
      scope: CatchupScope;
      kind: 'execution';
    }
  | {
      jobId: string;
      scope: CatchupScope;
      sourceExecutionJobId: string;
      kind: 'projection';
    };

/**
 * Mutable orchestration state for one serialized per-CG catch-up. Executions
 * describe actual runner work; views describe the immutable public job for
 * each requested scope. A narrow view can project a broad execution without
 * pretending to be another execution, while a wider request queues one real
 * serialized execution.
 */
export interface CatchupCoordinator {
  contextGraphId: string;
  executions: CatchupExecution[];
  viewsByScope: Map<CatchupScope, CatchupJobView>;
}

export interface CatchupTracker {
  jobs: Map<string, CatchupJob>;
  latestByContextGraph: Map<string, string>;
  inFlightByContextGraph: Map<string, CatchupCoordinator>;
}
