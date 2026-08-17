/**
 * GH#2270 — the ONE classifier for "what happens to this failed job, and why is it sitting
 * there". Both consumers read it: the operator retry pass (`retryDetailed` → its three counts)
 * and the read-only status projection (`describeJobRetryState` → `autoRetryEligible` +
 * `waitingReason`). They therefore report ONE partition of the failed set structurally, not by
 * two orderings a comment promises to keep in step.
 *
 * A read model, deliberately outside `lift-job-types.ts`: nothing here is persisted, and the
 * persisted job shape stays free of derived fields.
 */
import {
  hasBroadcastEvidence,
  isAutomaticallyRetryableLiftJob,
  isFailedJob,
  type PersistedFailedJob,
} from './async-lift-publisher-utils.js';
import type { LiftJob } from './lift-job.js';

/**
 * Why a job is not moving, when it is not moving:
 *  - `backoff` — the publisher's own lane owns it; it fires at `nextRetryAt`.
 *  - `pending_chain_proof` — a transaction may exist; no path may republish it until chain
 *    proof says otherwise (GH#2270 PR-3 dispatches on that proof).
 *  - `recovery` — `retry_recovery` resolution: `recover()` re-checks it forever, off-budget.
 *  - `operator` — retryable and evidence-free, but nothing automatic will move it: the code is
 *    not allow-listed, or the operator switched the lane off.
 *  - `exhausted` — the shared retry budget is spent; a fresh client mandate re-arms exactly one.
 */
export type LiftJobRetryWaitingReason =
  | 'backoff'
  | 'pending_chain_proof'
  | 'recovery'
  | 'operator'
  | 'exhausted';

/**
 * Read-only retry projection of a job. `autoRetryEligible` answers "will this node retry this
 * job by itself?"; `waitingReason` is absent when the job is not waiting on a retry at all (it
 * is still running, finalized, or failed terminally with nothing left to re-arm it).
 */
export interface LiftJobRetryProjection {
  readonly autoRetryEligible: boolean;
  readonly waitingReason?: LiftJobRetryWaitingReason;
}

/**
 * What a manual retry pass does with the job. Independent of `autoRetryEnabled` BY
 * CONSTRUCTION: the kill-switch only separates `backoff` from `operator` inside the
 * projection, and both of those are `reaccept` — an operator's retry never depends on whether
 * the automatic lane is switched on.
 */
export type FailedJobRetryAction = 'reaccept' | 'blocked_pending_recovery' | 'skip';

export interface FailedJobRetryDisposition {
  readonly action: FailedJobRetryAction;
  readonly projection: LiftJobRetryProjection;
}

/**
 * The single precedence. Chain safety is decided before the budget, so a job that may have sent
 * a transaction can never be reported as merely waiting on a budget — or reaccepted because one
 * remained.
 */
export function classifyFailedJobRetryDisposition(
  job: PersistedFailedJob,
  options: { readonly autoRetryEnabled: boolean },
): FailedJobRetryDisposition {
  const autoRetryEligible = isAutomaticallyRetryableLiftJob(job, options);
  const blocked = (waitingReason: LiftJobRetryWaitingReason): FailedJobRetryDisposition => ({
    action: 'blocked_pending_recovery',
    projection: { autoRetryEligible, waitingReason },
  });

  // A terminal failure is not WAITING for anything — no lane, operator action or fresh mandate
  // re-arms it (only a clear removes it), so it carries no reason at all.
  if (!job.failure.retryable) return { action: 'skip', projection: { autoRetryEligible } };
  if (job.failure.resolution === 'retry_recovery') return blocked('recovery');
  if (hasBroadcastEvidence(job)) return blocked('pending_chain_proof');
  if (job.retries.retryCount >= job.retries.maxRetries) {
    return { action: 'skip', projection: { autoRetryEligible, waitingReason: 'exhausted' } };
  }
  return {
    action: 'reaccept',
    projection: { autoRetryEligible, waitingReason: autoRetryEligible ? 'backoff' : 'operator' },
  };
}

/**
 * The projection half of {@link classifyFailedJobRetryDisposition}, for any job. A job that has
 * not failed has no retry projection: nothing is eligible, and it is not waiting on a retry.
 */
export function deriveLiftJobRetryProjection(
  job: LiftJob,
  options: { readonly autoRetryEnabled: boolean },
): LiftJobRetryProjection {
  if (!isFailedJob(job)) return { autoRetryEligible: false };
  return classifyFailedJobRetryDisposition(job, options).projection;
}
