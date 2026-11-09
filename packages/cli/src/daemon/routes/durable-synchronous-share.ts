import { executePromoteRequest } from '../worker/execute-promote-request.js';
import { DurableShareFailure, observeShareRecovery, shareJobStatusUrl } from './durable-share-failure.js';
import { randomUUID } from 'node:crypto';
import { PromoteStaleAdmissionError, PromoteJobConflictError, PromoteAdmissionUncertainError, type PromoteJob } from '@origintrail-official/dkg-publisher';
import { committedSharePendingCatalogHandoff, type DKGAgent, type AssertionPromoteOptions, type CommittedSharePendingCatalogHandoff } from '@origintrail-official/dkg-agent';
import { runPromoteJob } from '../worker/async-promote-worker.js';
import { daemonState } from '../state.js';

/** A committed share whose durable job still owes the catalog handoff names that job. */
export type SynchronousShareResult = Awaited<ReturnType<DKGAgent['assertion']['promote']>> & {
  catalogHandoff?: Readonly<{ state: 'pending'; reason: CommittedSharePendingCatalogHandoff['reason']; recoveryJobId: string }>;
};

/** Run the first attempt inline while the ordinary queue owns crash/failure recovery. */
export async function durableSynchronousShare(
  agent: DKGAgent, contextGraphId: string, name: string, options?: AssertionPromoteOptions,
): Promise<SynchronousShareResult> {
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
    if (error instanceof PromoteStaleAdmissionError) {
      // The winner may already be complete. Observe only an exact durable owner;
      // inability to read one must not invent a recovery promise or retry a mutation.
      // Only jobs stored under this selector's own key can be its owner, so read those (any state) and not the whole context graph.
      const selector = { contextGraphId, assertionName: name, agentAddress: prepared.agentAddress, subGraphName: options?.subGraphName };
      const owners = await (queue.listForSelector?.(selector) ?? queue.list({ contextGraphId })).catch(() => []);
      const owner = owners.find(candidate => candidate.request.assertionName === name
        && candidate.request.agentAddress === prepared.agentAddress
        && candidate.request.subGraphName === options?.subGraphName
        && candidate.request.recoveryBinding?.intent.operationId === error.existingOperationId);
      if (owner) throw new DurableShareFailure(error, await observeShareRecovery(queue, owner.jobId));
      throw error;
    }
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
    runPromote: (request, executionAuthority) => executePromoteRequest(agent, request,
      { curatorAckTimeoutMs: options?.curatorAckTimeoutMs, executionAuthority }),
  });
  if (outcome.outcome === 'succeeded') return outcome.result;
  // The queue durably acknowledged the bound retry, so the share it committed is answered
  // as shared while that job keeps the catalog handoff obligation and its fence.
  const committed = outcome.outcome === 'failed_retrying' ? committedSharePendingCatalogHandoff(outcome.cause) : undefined;
  if (committed) {
    process.stderr.write(`[DKG-Daemon] ${JSON.stringify({ event: 'knowledge_asset_share_catalog_handoff_pending',
      code: 'SWM_INVENTORY_HANDOFF_PENDING', causeReason: committed.reason, recoveryJobId: job.jobId, contextGraphId, name,
      ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}) })}\n`);
    return { ...committed.result, catalogHandoff: { state: 'pending', reason: committed.reason, recoveryJobId: job.jobId } };
  }
  if (outcome.outcome === 'failed_terminal' && outcome.retiredNoEffect) throw outcome.cause;
  const observation = outcome.outcome === 'failed_terminal'
    ? { state: 'inspection-required' as const, jobId: job.jobId }
    : outcome.outcome === 'failed_retrying'
      ? { state: 'pending' as const, jobId: job.jobId }
      : await observeShareRecovery(queue, job.jobId);
  throw new DurableShareFailure(outcome.cause, observation);
}

/** The share operation fields both share answers carry, including a pending catalog handoff. */
export function shareOperationFields(share: SynchronousShareResult) {
  return { ...(share.shareOperationId ? { shareOperationId: share.shareOperationId } : {}),
    ...(share.catalogHandoff ? { catalogHandoff: { ...share.catalogHandoff,
      recoveryStatusUrl: shareJobStatusUrl(share.catalogHandoff.recoveryJobId) } } : {}) };
}

export function synchronousShareSuccessBody(share: SynchronousShareResult) {
  const swmShared = share.promotedCount > 0 || Boolean(share.shareOperationId);
  return { swmShared, promotedCount: share.promotedCount,
    ...(share.sealed !== undefined ? { sealed: swmShared && share.sealed } : {}),
    ...(share.publishReady !== undefined ? { publishReady: swmShared && share.publishReady } : {}),
    ...shareOperationFields(share),
  };
}
