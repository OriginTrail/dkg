import { getLiftJobFailurePolicy } from './lift-job.js';
import type { LiftJobHex, PersistedLiftJob } from './lift-job.js';

/**
 * #3591 — does the record itself already account for the hash a reaccept carries forward? Yes when
 * the failure proves the attempt's own transaction had no effect (refused before the mempool), or
 * when the hash is an inherited one an earlier reset already marked accounted. Carried forward as an
 * open question instead, it would hold the re-run the first time that fails before signing, on a
 * transaction no proof can settle again — and an `insufficient_funds` job now re-runs by itself.
 */
export function isFailedJobTxHashAccounted(
  job: Extract<PersistedLiftJob, { status: 'failed' }>,
  txHash: LiftJobHex | undefined,
): boolean {
  if (txHash === undefined) return false;
  if ((job as { broadcast?: { txHash?: string } }).broadcast?.txHash === txHash) {
    return getLiftJobFailurePolicy(job.failure.code).provenIneffective === true;
  }
  return isInheritedTxHashAccounted(job, txHash);
}

/**
 * Does the job carry a hash from an earlier attempt that is still an open question? Only a RESET
 * record can carry the accounted mark; a finalized-from-chain record is not a job that is still
 * waiting on anything.
 */
export function carriesOpenInheritedHash(job: PersistedLiftJob): boolean {
  const recovery = job.recovery;
  if (!recovery?.txHashChecked) return false;
  return recovery.action !== 'reset_to_accepted' || recovery.txHashAccounted !== true;
}

/**
 * Has the failure settled the attempt's own transaction while an older hash stays open? Then the
 * older hash is the one question left, so it is the evidence chain proof has to answer, under the
 * signer and nonce kept with it. Asking about the settled transaction could never release the job.
 */
export function ownTransactionSettledBesideOpenHash(job: PersistedLiftJob): boolean {
  return job.status === 'failed'
    && 'failure' in job
    && getLiftJobFailurePolicy(job.failure.code).provenIneffective === true
    && carriesOpenInheritedHash(job);
}

/**
 * Is this the inherited hash an earlier reset already marked accounted? Every reset that carries it
 * forward keeps the mark. It only ever keeps one: a reset that has asked the chain nothing never
 * turns an open question into an accounted one.
 */
export function isInheritedTxHashAccounted(job: PersistedLiftJob, txHash: LiftJobHex | undefined): boolean {
  const recovery = job.recovery;
  return txHash !== undefined
    && recovery?.action === 'reset_to_accepted'
    && recovery.txHashChecked === txHash
    && recovery.txHashAccounted === true;
}
