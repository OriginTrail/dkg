import { randomUUID } from 'node:crypto';
import { PromoteJobConflictError, type PromoteJob } from '@origintrail-official/dkg-publisher';
import type { DKGAgent, AssertionPromoteOptions } from '@origintrail-official/dkg-agent';
import { runPromoteJob } from '../worker/async-promote-worker.js';
import { daemonState } from '../state.js';

/** Run the first attempt inline while the ordinary queue owns crash/failure recovery. */
export async function durableSynchronousShare(
  agent: DKGAgent, contextGraphId: string, name: string, options?: AssertionPromoteOptions,
): ReturnType<DKGAgent['assertion']['promote']> {
  const queue = agent.promoteQueue;
  if (!queue?.enqueueAndClaim || !daemonState.promoteWorkerAvailable) {
    throw Object.assign(new Error('Durable sharing requires an available share recovery worker'),
      { code: 'SHARE_RECOVERY_UNAVAILABLE' });
  }
  const prepared = await agent.assertion.prepareDurableShare(contextGraphId, name, options);
  if (prepared.completedResult) return prepared.completedResult;
  const workerId = `http-share-${randomUUID()}`;
  let job: PromoteJob;
  try { job = await queue.enqueueAndClaim({ contextGraphId, assertionName: name, entities: 'all',
    subGraphName: options?.subGraphName, authorAgentAddress: options?.authorAgentAddress, ...prepared,
  }, workerId); } catch (error) {
    if (error instanceof PromoteJobConflictError) {
      throw Object.assign(error, { code: 'SHARE_ALREADY_PENDING', recoveryJobId: error.existingJobId,
        recoveryState: 'pending', recoveryStatusUrl: `/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(error.existingJobId)}` });
    }
    throw error;
  }
  let response: Awaited<ReturnType<DKGAgent['assertion']['promote']>> | undefined;
  let failure: unknown;
  const outcome = await runPromoteJob({ job, queue, workerId, now: Date.now,
    heartbeatIntervalMs: Math.min(60_000, Math.floor(queue.effectiveLeaseMs / 4)),
    log: message => console.warn(message),
    runPromote: async (_request, markStarted) => {
      await markStarted();
      try {
        response = await agent.assertion.promote(contextGraphId, name, { ...options, ...prepared });
        return response;
      } catch (error) { failure = error; throw error; }
    },
  });
  if (outcome.outcome === 'succeeded' && response) return response;
  const error = failure instanceof Error ? failure : new Error('Share completion is awaiting durable recovery');
  throw Object.assign(error, { contextGraphId, subGraphName: options?.subGraphName, retryKnowledgeAssetName: name, recoveryJobId: job.jobId,
    recoveryState: outcome.outcome === 'failed_terminal' ? 'inspection-required' : 'pending',
    recoveryStatusUrl: `/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(job.jobId)}` });
}

export function synchronousShareSuccessBody(share: Awaited<ReturnType<DKGAgent['assertion']['promote']>>) {
  const swmShared = share.promotedCount > 0 || Boolean(share.shareOperationId);
  return { swmShared, promotedCount: share.promotedCount,
    ...(share.sealed !== undefined ? { sealed: swmShared && share.sealed } : {}),
    ...(share.publishReady !== undefined ? { publishReady: swmShared && share.publishReady } : {}),
    ...(share.shareOperationId ? { shareOperationId: share.shareOperationId } : {}),
  };
}
