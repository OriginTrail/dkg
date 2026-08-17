// daemon/types.ts
//
// Pure type/interface declarations used across the daemon sub-modules.

import type { CatchupJobResult } from '../catchup-runner.js';
import type { Rfc64SelectedSwmGraphSyncStatus } from '@origintrail-official/dkg-agent';
import {
  toLegacyCatchupJobState,
  type CatchupJobState,
  type CatchupStatusResponse,
} from '../catchup-status.js';

export type { CatchupJobState } from '../catchup-status.js';

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

export type CatchupGraphSyncStatus = Rfc64SelectedSwmGraphSyncStatus;

export function toCatchupStatusResponse(
  job: CatchupJob,
  graphSync?: CatchupGraphSyncStatus,
): CatchupStatusResponse {
  return {
    jobId: job.jobId,
    contextGraphId: job.contextGraphId,
    includeWorkspace: job.includeWorkspace,
    includeSharedMemory: job.includeWorkspace,
    /** Older clients keep their closed terminal vocabulary. */
    status: toLegacyCatchupJobState(job.status),
    /** Precise bounded-job outcome for upgraded clients. */
    jobStatus: job.status,
    queuedAt: job.queuedAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(graphSync === undefined ? {} : { graphSync }),
  };
}
