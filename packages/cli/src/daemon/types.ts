// daemon/types.ts
//
// Pure type/interface declarations used across the daemon sub-modules.
// Kept intentionally lean — `PublishQuad` / `PublishRequestBody` /
// `PublishAccessPolicy` deliberately stay in `./http-utils.ts` because
// the body parser is their only semantic consumer.

import type { CatchupJobResult } from '../catchup-runner.js';

export type CatchupJobState = "queued" | "running" | "done" | "failed" | "denied";

export interface CatchupJob {
  jobId: string;
  paranetId: string;
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
  latestByParanet: Map<string, string>;
}

export function toCatchupStatusResponse(job: CatchupJob) {
  return {
    ...job,
    contextGraphId: job.paranetId,
    includeSharedMemory: job.includeWorkspace,
  };
}
