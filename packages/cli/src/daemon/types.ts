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

/**
 * One serialized per-CG catch-up has exactly the two scopes the product
 * exposes. When durable starts first, a later full request occupies the full
 * slot and runs second. When full starts first, a later durable request
 * occupies the durable slot and is settled from that full result.
 */
export interface CatchupCoordinator {
  contextGraphId: string;
  initialScope: CatchupScope;
  durableJobId?: string;
  fullJobId?: string;
}

export interface CatchupTracker {
  jobs: Map<string, CatchupJob>;
  latestByContextGraph: Map<string, string>;
}
