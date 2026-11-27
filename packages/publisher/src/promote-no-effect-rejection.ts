import type { PromoteRecoveryBinding } from './promote-recovery-binding.js';
import type { PromoteJob } from './async-promote-queue-types.js';

export const PROMOTE_NO_EFFECT_REJECTION_CODE = 'PROMOTE_NO_EFFECT_REJECTION' as const;
export interface PromoteNoEffectProof { readonly sealDigest: string; readonly operationId: string }
const certified = new WeakMap<Error, PromoteNoEffectProof>();

/** Read exact current SWM under the producer lifecycle lock before certifying rejection. */
export async function certifyPromoteNoEffectRejection<T extends Error>(error: T, binding: PromoteRecoveryBinding | undefined,
  evidence: { operationAbsent: boolean; resumingCommittedSwm: boolean; readSwm: () => Promise<readonly unknown[]> },
): Promise<T> {
  if (binding && evidence.operationAbsent && !evidence.resumingCommittedSwm && (await evidence.readSwm()).length === 0) {
    certified.set(error, Object.freeze({sealDigest: binding.sealDigest, operationId: binding.intent.operationId}));
  }
  return error;
}
export function getPromoteNoEffectProof(error: unknown): PromoteNoEffectProof | undefined {
  return error instanceof Error ? certified.get(error) : undefined;
}

/** Discount only a proven preparation-only prefix; later execution or lost proof stays fenced. */
export function canRetireBoundRejection(job: Omit<PromoteJob, 'state'> & {state: string},
  proof: PromoteNoEffectProof | undefined): boolean {
  const binding = job.request.recoveryBinding;
  const prepared = job.preparationAttempts ?? 0;
  return job.formatVersion === 4 && binding !== undefined
    && Number.isSafeInteger(prepared) && prepared >= 0 && job.attempt.count === prepared + 1
    && job.commitMarker?.swmInserted === false && job.reason === undefined
    && proof?.sealDigest === binding.sealDigest && proof?.operationId === binding.intent.operationId;
}
export function isRetiredBoundRejection(job: Omit<PromoteJob, 'state'> & {state: string}): boolean {
  const error = job.attempt.lastError;
  return job.state === 'failed' && error?.diagnosticCode === PROMOTE_NO_EFFECT_REJECTION_CODE
    && error.classification === 'cap_exceeded' && error.retryable === false
    && canRetireBoundRejection(job, error.noEffectProof);
}

/** A contiguous prefix only: missing/crashed execution evidence must not be discounted. */
export function recordUnstartedPromoteAttempt(job: PromoteJob): PromoteJob {
  const prepared = job.preparationAttempts ?? 0;
  if (job.formatVersion === 4 && !job.request.recoveryBinding
    && job.commitMarker?.promoteStarted === false && job.commitMarker.swmInserted === false
    && Number.isSafeInteger(prepared) && prepared >= 0 && job.attempt.count === prepared + 1) {
    return { ...job, preparationAttempts: job.attempt.count };
  }
  return job;
}
