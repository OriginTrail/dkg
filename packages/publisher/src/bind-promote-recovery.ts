import { isBoundPromoteJob, snapshotPromoteRequest } from './bound-promote-job.js';
import { ASYNC_PROMOTE_QUEUE_FORMAT_VERSION, type BoundPromoteJob, type PromoteJob } from './async-promote-queue-types.js';
import { recoveryBindingConflict, type PromoteRecoveryBinding } from './promote-recovery-binding.js';

/** Publisher owns compatibility and unsafe-transition policy before any seal preparation. */
export function classifyQueuedSharePreparation(job: PromoteJob): 'bound' | 'legacy' | 'eligible' {
  if (job.request.recoveryBinding) return 'bound';
  if (job.formatVersion !== ASYNC_PROMOTE_QUEUE_FORMAT_VERSION || !job.request.agentAddress) return 'legacy';
  if (job.request.entities !== 'all' || !job.request.agentAddress.trim()
    || !job.commitMarker || Object.values(job.commitMarker).some(value => value !== false)) {
    throw recoveryBindingConflict('Only a current, unstarted whole-asset share may acquire recovery authority');
  }
  return 'eligible';
}

/** Revalidate policy with a live lease under the queue lock and publisher lifecycle fence. */
export function bindUnstartedPromoteJob(job: PromoteJob, binding: PromoteRecoveryBinding, now: number): BoundPromoteJob {
  if (classifyQueuedSharePreparation(job) !== 'eligible')
    throw recoveryBindingConflict('Only a current, unstarted whole-asset share may acquire recovery authority');
  const bound = { ...job, updatedAt: now, request: snapshotPromoteRequest({ ...job.request,
    entities: 'all', agentAddress: job.request.agentAddress!, recoveryBinding: binding }) };
  if (!isBoundPromoteJob(bound)) throw recoveryBindingConflict('Invalid bound share job');
  return bound;
}
