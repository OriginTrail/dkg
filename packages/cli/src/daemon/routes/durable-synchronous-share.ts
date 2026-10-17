import { executePromoteRequest } from '../worker/execute-promote-request.js';
import { DurableShareFailure, observeShareRecovery } from './durable-share-failure.js';
import { randomUUID } from 'node:crypto';
import { PromoteJobConflictError, PromoteAdmissionUncertainError, type PromoteJob } from '@origintrail-official/dkg-publisher';
import type { DKGAgent, AssertionPromoteOptions } from '@origintrail-official/dkg-agent';
import { runPromoteJob } from '../worker/async-promote-worker.js';
import { daemonState } from '../state.js';

/** Run the first attempt inline while the ordinary queue owns crash/failure recovery. */
export async function durableSynchronousShare(
  agent: DKGAgent, contextGraphId: string, name: string, options?: AssertionPromoteOptions,
): ReturnType<DKGAgent['assertion']['promote']> {
  const queue = agent.promoteQueue;
  if (!queue?.enqueueAndClaim || !daemonState.promoteWorkerAvailable) {
    throw new DurableShareFailure(new Error('Durable sharing requires an available share recovery worker'), { state: 'unavailable' });
  }
  const prepared = await agent.assertion.prepareDurableShare(contextGraphId, name, options);
  if (prepared.completedResult) return prepared.completedResult;
  const workerId = `http-share-${randomUUID()}`;
  let job: PromoteJob;
  try { job = await agent.assertion.admitDurableShare({ contextGraphId, assertionName: name, entities: 'all',
    subGraphName: options?.subGraphName, authorAgentAddress: options?.authorAgentAddress, ...prepared,
  }, workerId); } catch (error) {
    if (error instanceof PromoteJobConflictError) {
      throw new DurableShareFailure(error, await observeShareRecovery(queue, error.existingJobId));
    }
    if (error instanceof PromoteAdmissionUncertainError) {
      throw new DurableShareFailure(error, { state: 'admission-unconfirmed', jobId: error.jobId });
    }
    throw error;
  }
  const outcome = await runPromoteJob({ job, queue, workerId, now: Date.now,
    heartbeatIntervalMs: Math.min(60_000, Math.floor(queue.effectiveLeaseMs / 4)),
    log: message => console.warn(message),
    runPromote: (request) => executePromoteRequest(agent, request,
      { curatorAckTimeoutMs: options?.curatorAckTimeoutMs }),
  });
  if (outcome.outcome === 'succeeded') return outcome.result;
  if (outcome.outcome === 'failed_terminal' && outcome.retiredNoEffect) throw outcome.cause;
  const observation = outcome.outcome === 'failed_terminal'
    ? { state: 'inspection-required' as const, jobId: job.jobId }
    : outcome.outcome === 'failed_retrying'
      ? { state: 'pending' as const, jobId: job.jobId }
      : await observeShareRecovery(queue, job.jobId);
  throw new DurableShareFailure(outcome.cause, observation);
}

export function synchronousShareSuccessBody(share: Awaited<ReturnType<DKGAgent['assertion']['promote']>>) {
  const swmShared = share.promotedCount > 0 || Boolean(share.shareOperationId);
  return { swmShared, promotedCount: share.promotedCount,
    ...(share.sealed !== undefined ? { sealed: swmShared && share.sealed } : {}),
    ...(share.publishReady !== undefined ? { publishReady: swmShared && share.publishReady } : {}),
    ...(share.shareOperationId ? { shareOperationId: share.shareOperationId } : {}),
  };
}
