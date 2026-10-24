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

/** A later attempt or lost proof cannot retire a possibly committed earlier attempt. */
export function canRetireBoundRejection(job: Omit<PromoteJob, 'state'> & {state: string},
  proof: PromoteNoEffectProof | undefined): boolean {
  const binding = job.request.recoveryBinding;
  return job.formatVersion === 4 && binding !== undefined && job.attempt.count === 1
    && job.commitMarker?.swmInserted === false && job.reason === undefined
    && proof?.sealDigest === binding.sealDigest && proof?.operationId === binding.intent.operationId;
}
export function isRetiredBoundRejection(job: Omit<PromoteJob, 'state'> & {state: string}): boolean {
  const error = job.attempt.lastError;
  return job.state === 'failed' && error?.diagnosticCode === PROMOTE_NO_EFFECT_REJECTION_CODE
    && error.classification === 'cap_exceeded' && error.retryable === false
    && canRetireBoundRejection(job, error.noEffectProof);
}
