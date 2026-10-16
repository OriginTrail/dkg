import { tryReplaceSubjectAtomically, type TripleStore } from '@origintrail-official/dkg-storage';
import { validatePromoteRecoveryBinding } from './promote-recovery-binding.js';
import type { PromoteJob, PromoteRequest } from './async-promote-queue-types.js';
import { serializeJobRecord } from './async-promote-queue-utils.js';
import { replaceSubjectAtomicallyOrFallback } from './subject-atomic-write.js';

export function isBoundPromoteJob(job: PromoteJob): boolean {
  if (job.formatVersion !== 4 || job.request.entities !== 'all' || !job.request.agentAddress) return false;
  try { validatePromoteRecoveryBinding(job.request.recoveryBinding); return true; } catch { return false; }
}

export function snapshotPromoteRequest(request: PromoteRequest): PromoteRequest {
  return {
    contextGraphId: request.contextGraphId, assertionName: request.assertionName,
    entities: request.entities === 'all' ? 'all' : Object.freeze([...request.entities]),
    ...(request.subGraphName !== undefined ? { subGraphName: request.subGraphName } : {}),
    ...(request.agentAddress?.trim() ? { agentAddress: request.agentAddress.trim() } : {}),
    ...(request.authorAgentAddress !== undefined ? { authorAgentAddress: request.authorAgentAddress } : {}),
    ...(request.recoveryBinding !== undefined
      ? { recoveryBinding: validatePromoteRecoveryBinding(request.recoveryBinding) } : {}),
  };
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
  const source = 'publisher.asyncPromote.writeJob';
  if (job.request.recoveryBinding !== undefined) {
    if (!isBoundPromoteJob(job)) throw new Error('Invalid bound promote job');
    if (!await tryReplaceSubjectAtomically(store, graphUri, jobRef, jobQuads, { source })) {
      throw new Error('Durable synchronous sharing requires atomic queue record replacement');
    }
  } else {
    await replaceSubjectAtomicallyOrFallback(store, graphUri, jobRef, jobQuads, source);
  }
}
