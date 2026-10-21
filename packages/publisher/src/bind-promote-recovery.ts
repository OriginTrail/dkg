import { isBoundPromoteJob, snapshotPromoteRequest } from './bound-promote-job.js';
import { ASYNC_PROMOTE_QUEUE_FORMAT_VERSION, type BoundPromoteJob, type PromoteJob } from './async-promote-queue-types.js';
import { recoveryBindingConflict, type PromoteRecoveryBinding } from './promote-recovery-binding.js';

/** Called with a live lease under the queue lock, inside the publisher lifecycle fence. */
export function bindUnstartedPromoteJob(job: PromoteJob, binding: PromoteRecoveryBinding, now: number): BoundPromoteJob {
  if (job.formatVersion !== ASYNC_PROMOTE_QUEUE_FORMAT_VERSION || job.request.recoveryBinding
    || job.request.entities !== 'all' || !job.request.agentAddress?.trim()
    || !job.commitMarker || Object.values(job.commitMarker).some(value => value !== false)) {
    throw recoveryBindingConflict('Only a current, unstarted whole-asset share may acquire recovery authority');
  }
  const bound = { ...job, updatedAt: now, request: snapshotPromoteRequest({ ...job.request,
    entities: 'all', agentAddress: job.request.agentAddress, recoveryBinding: binding }) };
  if (!isBoundPromoteJob(bound)) throw recoveryBindingConflict('Invalid bound share job');
  return bound;
}
