import { controlStoreOptions, tryReplaceSubjectAtomically, type TripleStore } from '@origintrail-official/dkg-storage';
import { validatePromoteRecoveryBinding } from './promote-recovery-binding.js';
import { isBoundPromoteRequest } from './bound-promote-request.js';
import type { BoundPromoteJob, PromoteJob, PromoteRequest } from './async-promote-queue-types.js';
import { serializeJobRecord } from './async-promote-queue-utils.js';
import { replaceSubjectAtomicallyOrFallback } from './subject-atomic-write.js';

export function isBoundPromoteJob(job: PromoteJob): job is BoundPromoteJob {
  return job.formatVersion === 4 && isBoundPromoteRequest(job.request);
}

export function snapshotPromoteRequest(request: PromoteRequest): PromoteRequest {
  const scope = {
    contextGraphId: request.contextGraphId, assertionName: request.assertionName,
    ...(request.subGraphName !== undefined ? { subGraphName: request.subGraphName } : {}),
    ...(request.authorAgentAddress !== undefined ? { authorAgentAddress: request.authorAgentAddress } : {}),
  };
  if (request.recoveryBinding !== undefined) {
    if (!isBoundPromoteRequest(request)) throw new Error('Invalid bound promote request');
    return { ...scope, entities: 'all', agentAddress: request.agentAddress.trim(),
      recoveryBinding: validatePromoteRecoveryBinding(request.recoveryBinding) };
  }
  return { ...scope, entities: request.entities === 'all' ? 'all' : Object.freeze([...request.entities]),
    ...(request.agentAddress?.trim() ? { agentAddress: request.agentAddress.trim() } : {}) };
}

export function claimPromoteJob(job: PromoteJob, workerId: string, now: number, leaseMs: number, token: string): PromoteJob {
  return { ...job, state: 'running', updatedAt: now,
    attempt: { ...job.attempt, count: job.attempt.count + 1, nextRetryAt: undefined },
    lease: { workerId, acquiredAt: now, expiresAt: now + leaseMs, lastHeartbeatAt: now,
      claimToken: `${workerId}:${job.jobId}:${token}` },
    commitMarker: { promoteStarted: false, swmInserted: false, wmCleaned: false, lifecycleStamped: false, gossiped: false },
  };
}

/** A recovery owner must never disappear in a DELETE/INSERT crash window. */
export async function persistPromoteJob(store: TripleStore, graphUri: string, job: PromoteJob): Promise<void> {
  const { jobRef, jobQuads } = serializeJobRecord(job, graphUri);
  const options = controlStoreOptions('share', 'publisher.asyncPromote.writeJob');
  if (job.request.recoveryBinding !== undefined) {
    if (!isBoundPromoteJob(job)) throw new Error('Invalid bound promote job');
    if (!await tryReplaceSubjectAtomically(store, graphUri, jobRef, jobQuads, options)) {
      throw new Error('Durable synchronous sharing requires atomic queue record replacement');
    }
  } else {
    await replaceSubjectAtomicallyOrFallback(store, graphUri, jobRef, jobQuads, options);
  }
}
