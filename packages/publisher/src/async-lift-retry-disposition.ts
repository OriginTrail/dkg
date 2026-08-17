/**
 * GH#2270 — what happens to a failed job, and why it is sitting there, decided ONCE.
 *
 * The split is the point. {@link classifyRetryAction} is the WRITE decision and takes the job
 * alone: what a retry pass does with a job never depended on the operator's `autoRetryEnabled`
 * knob, and now it cannot — the signature has nowhere to put it.
 * {@link describeRetryProjection} is the READ view, derived from that same action plus the knob.
 * So both consumers (`retryDetailed`'s counts, `describeJobRetryState`'s per-job answer) still
 * share one source, and the type boundary shows which of them the switch may influence.
 *
 * A read model, deliberately outside `lift-job-types.ts`: nothing here is persisted, and the
 * persisted job shape stays free of derived fields.
 */
import {
  isAutomaticallyRetryableLiftJob,
  isFailedJob,
  isHeldForChainProof,
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
 * What a retry pass does with a failed job. Finer-grained than the three counts it feeds, so the
 * read view can name the reason without re-deriving it: both `blocked_*` actions count as
 * `blockedPendingRecovery`, both `skip_*` as `skipped`.
 */
export type FailedJobRetryAction =
  | 'reaccept'
  | 'blocked_recovery'
  | 'blocked_pending_chain_proof'
  | 'skip_terminal'
  | 'skip_exhausted';

/**
 * The single precedence, over the job alone.
 *
 * Chain safety is decided before BOTH the terminal shortcut and the budget: a job whose
 * transaction is unaccounted for is held whatever its code says (a terminal
 * `confirmation_mismatch` is exactly such a job), and it can never be reaccepted because a
 * budget happened to remain.
 */
export function classifyRetryAction(job: PersistedFailedJob): FailedJobRetryAction {
  if (job.failure.resolution === 'retry_recovery') return 'blocked_recovery';
  if (isHeldForChainProof(job)) return 'blocked_pending_chain_proof';
  // A terminal failure with nothing to account for is not WAITING for anything — no lane,
  // operator action or fresh mandate re-arms it; only a clear removes it.
  if (!job.failure.retryable) return 'skip_terminal';
  if (job.retries.retryCount >= job.retries.maxRetries) return 'skip_exhausted';
  return 'reaccept';
}

/** The read view of {@link classifyRetryAction}: the same action, plus the operator's knob. */
export function describeRetryProjection(
  job: PersistedFailedJob,
  options: { readonly autoRetryEnabled: boolean },
): LiftJobRetryProjection {
  const autoRetryEligible = isAutomaticallyRetryableLiftJob(job, options);
  return { autoRetryEligible, ...waitingReasonOf(classifyRetryAction(job), autoRetryEligible) };
}

function waitingReasonOf(
  action: FailedJobRetryAction,
  autoRetryEligible: boolean,
): { waitingReason?: LiftJobRetryWaitingReason } {
  switch (action) {
    case 'blocked_recovery':
      return { waitingReason: 'recovery' };
    case 'blocked_pending_chain_proof':
      return { waitingReason: 'pending_chain_proof' };
    case 'skip_exhausted':
      return { waitingReason: 'exhausted' };
    case 'skip_terminal':
      return {};
    case 'reaccept':
      // The ONE place the operator's kill-switch is allowed to matter: it separates a retry the
      // node performs itself from one that waits for an operator or a client re-submit.
      return { waitingReason: autoRetryEligible ? 'backoff' : 'operator' };
    default: {
      // A new action must decide its own reason here rather than inherit a silent default.
      const unhandled: never = action;
      return unhandled;
    }
  }
}

/**
 * {@link describeRetryProjection} for any job. A job that has not failed has no retry
 * projection: nothing is eligible, and it is not waiting on a retry.
 */
export function deriveLiftJobRetryProjection(
  job: LiftJob,
  options: { readonly autoRetryEnabled: boolean },
): LiftJobRetryProjection {
  if (!isFailedJob(job)) return { autoRetryEligible: false };
  return describeRetryProjection(job, options);
}
