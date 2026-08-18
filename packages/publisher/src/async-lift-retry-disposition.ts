/**
 * GH#2270 — the canonical owner of FAILED-JOB POLICY: what a failed lift job may still do, and
 * why it is sitting where it is. Every predicate whose answer depends on another's lives here, in
 * ONE documented precedence — spread across modules they were exactly the kind of helpers that
 * drift apart, each reading the same job and each free to disagree about it.
 *
 * The precedence, read top to bottom:
 *   1. {@link isProvenIneffectiveLiftFailure} — does the failure code PROVE the transaction had
 *      no effect? Then nothing below needs to account for it.
 *   2. {@link isHeldForChainProof} — otherwise, is a transaction unaccounted for? A held job is
 *      never republished, keeps its lifecycle subject, and survives bulk cleanup.
 *   3. {@link classifyRetryAction} — the WRITE decision for a retry pass, over the job alone.
 *   4. {@link isOccupyingLifecycleJob} / {@link isBulkClearableTerminalLiftJob} — the admission
 *      and cleanup consequences of 2.
 *   5. {@link describeRetryProjection} — the READ view of 3, plus the operator's kill-switch.
 *
 * `async-lift-publisher-utils.ts` keeps the STRUCTURAL helpers (is this job failed, what does it
 * persist, how is it rebuilt). Nothing here is persisted, and the persisted job shape
 * (`lift-job-types.ts`) stays free of derived fields.
 */
import {
  compareAcceptedJobs,
  getLiftJobTransactionEvidence,
  isFailedJob,
  type PersistedFailedJob,
} from './async-lift-publisher-utils.js';
import { getLiftJobFailurePolicy, isTerminalLiftJobState } from './lift-job.js';
import type { LiftJob, LiftJobFailureCode } from './lift-job.js';

/**
 * Might a transaction have been submitted for this job? Keyed on persisted EVIDENCE, never on the
 * failure code's `resolution`: `rpc_unavailable` is the broadcast-phase catch-all and carries
 * `reset_to_accepted`, yet a transaction that LANDED and merely failed to record locally arrives
 * under exactly that code — resolution cannot separate the two.
 *
 * Evidence is a persisted transaction hash from either carrier (the live `broadcast` metadata, or
 * `recovery.txHashChecked`, which survives a reset that dropped the broadcast metadata), plus an
 * `included` origin, which by definition had a transaction.
 *
 * It is deliberately NOT keyed on `failedFromState ∈ {broadcast, included}`: `quorum_unmet`'s only
 * allowed state is 'broadcast' while its producer sits before the publish tx is signed (see the
 * `autoRetry` qualification in lift-job-failures.ts), so a state-keyed predicate would classify
 * every quorum failure as evidence-bearing and strand the GH#1620 lane. Pre-send-safe failures
 * persist no txHash, and that is what makes them safe to re-run.
 *
 * Which hash a job carries is structural ({@link getLiftJobTransactionEvidence}); what carrying one
 * MEANS is policy, which is why this lives here rather than beside the field accessor.
 */
export function hasBroadcastEvidence(job: PersistedFailedJob): boolean {
  return Boolean(getLiftJobTransactionEvidence(job))
    || job.failure.failedFromState === 'included';
}

/**
 * Does this failure code PROVE the transaction had no effect, so the evidence such a job carries
 * needs no further accounting?
 *
 * The decision itself lives in the failure registry (`provenIneffective`, required on every
 * built-in entry), so a new code cannot be added without stating its chain effect — the same
 * table-only strictness `autoRetry` uses. This function is just the reader; see the field's doc
 * for the guarantee each `true` rests on.
 */
export function isProvenIneffectiveLiftFailure(code: LiftJobFailureCode): boolean {
  return getLiftJobFailurePolicy(code).provenIneffective === true;
}

/**
 * A failed job that may have a transaction on chain, with no proof either way. ONE property behind
 * FIVE surfaces, so they cannot answer differently: admission keeps the job bound to its lifecycle
 * subject (a re-submit gets `LiftJobPendingChainProofError` rather than a replacement job), the
 * reaccept writer refuses it, a retry pass reports it as `blockedPendingRecovery`, bulk clear
 * leaves it alone — and, since GH#2270 PR-3, the proof-first dispatcher takes exactly this
 * population as its WORK QUEUE.
 *
 * That last one is what makes the hold releasable without an operator, and it is why the predicate
 * must stay a single definition: the four surfaces that REFUSE to move a held job and the one that
 * resolves it have to agree on which jobs those are, or a job could be chased by recovery while
 * admission still treats it as free, or held forever by admission while nothing asks the chain.
 *
 * NOT limited to retryable failures. A TERMINAL diagnosis like `confirmation_mismatch` is precisely
 * a job whose transaction is unaccounted for; letting its subject fall vacant is how the next
 * re-submit publishes the same KA a second time.
 */
export function isHeldForChainProof(job: PersistedFailedJob): boolean {
  return hasBroadcastEvidence(job) && !isProvenIneffectiveLiftFailure(job.failure.code);
}

/**
 * The ONE gate of the automatic retry lane, shared by the scheduler (`scheduleRetryIfEligible`),
 * the claim-time sweep (`reacceptDueFailedJobs`) and the read-only status projection, so what the
 * projection reports and what the lane does cannot drift.
 *
 * `autoRetryEnabled` is the operator kill-switch; the rest is registry policy, the shared retry
 * budget, and the hold — a job whose transaction is unaccounted for is never reaccepted
 * automatically, whatever the registry says about its code.
 */
export function isAutomaticallyRetryableLiftJob(
  job: PersistedFailedJob,
  options: { readonly autoRetryEnabled: boolean },
): boolean {
  return options.autoRetryEnabled
    && getLiftJobFailurePolicy(job.failure.code).autoRetry === true
    && job.failure.retryable
    && job.failure.resolution === 'reset_to_accepted'
    && job.retries.retryCount < job.retries.maxRetries
    && !isHeldForChainProof(job);
}

/**
 * #1828 — whether a job still OCCUPIES its lifecycle subject: any non-terminal state, or a failed
 * job admission would still bind rather than replace. Admission dedup
 * (findActiveKnowledgeAssetVmPublishJob) and the intent-recovery lookup MUST both partition on this
 * so they cannot drift — an occupying job is the live one to bind; everything else (finalized, and
 * a failed job that is neither retryable nor held) is superseded.
 *
 * GH#2270 — neither the retry BUDGET nor the retryable flag alone decides occupancy any more:
 *  - a RETRYABLE failed job holds its subject even with the budget spent, because a fresh client
 *    re-submit re-arms one budget on the SAME jobId (admission's fresh-mandate reaccept);
 *  - a job {@link isHeldForChainProof} holds it whatever its code says, INCLUDING a terminal
 *    diagnosis: admission must answer that re-submit with a retryable pending-chain-proof
 *    rejection, and the alternative is minting a REPLACEMENT job for a lifecycle whose transaction
 *    may already be on chain — the double publish GH#2270 exists to prevent.
 * A failure that proves its transaction had no effect (reverted, refused pre-acceptance) is not
 * held, so it supersedes normally and the KA can be published again.
 */
export function isOccupyingLifecycleJob(job: LiftJob): boolean {
  if (!isTerminalLiftJobState(job.status)) return true;
  return isFailedJob(job) && (job.failure.retryable || isHeldForChainProof(job));
}

/**
 * GH#2270 — which records may BIND each lifecycle, grouped BY that lifecycle.
 *
 * {@link isOccupyingLifecycleJob} answers "could this job bind a subject" from the job alone, which
 * is not enough once a key has history: an ordinary FAILED job records what already happened, so a
 * strictly NEWER record for the same key means the lifecycle moved on without it. Without that
 * rule the widened occupancy resurrects history — a store written before this PR could let an
 * exhausted failed job's subject fall vacant and mint a successor, and afterwards BOTH records read
 * as occupying, so admission would fresh-mandate a superseded job back to life beside its own
 * successor.
 *
 * A job {@link isHeldForChainProof} is EXEMPT from that demotion, and this is the sharp edge: a
 * newer sibling is not chain proof. Whatever else happened on this lifecycle afterwards, that
 * record's transaction is still unaccounted for, and the only things that may release it are
 * recovery proving the transaction's fate or an operator clearing that exact job by id. So a held
 * record keeps binding its lifecycle and keeps answering `LiftJobPendingChainProofError` — even
 * behind a finalized successor, which is a completed publish, not evidence about the held one.
 *
 * Non-terminal jobs are never demoted either: two live jobs on one key is the broken invariant
 * #1828 exists to surface as a conflict, not something to silently pick a winner from.
 *
 * The lifecycle KEY is the caller's to define, and it is a PARAMETER rather than a precondition in
 * prose: a caller handing this a mixed list cannot make one lifecycle demote a record of another.
 * `lifecycleKeyOf` returns null for a job that has no key (a non-VM or malformed request), which
 * drops it from every group. Within a group the binding jobs are ordered so the FIRST is the one
 * admission must answer for: held records first (they block), then the newest.
 */
export function selectLifecycleBindingJobs(
  jobs: readonly LiftJob[],
  lifecycleKeyOf: (job: LiftJob) => string | null,
): Map<string, LiftJob[]> {
  const groups = new Map<string, LiftJob[]>();
  for (const job of jobs) {
    const key = lifecycleKeyOf(job);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }

  const binding = new Map<string, LiftJob[]>();
  for (const [key, group] of groups) {
    const newest = group.reduce((a, b) => (compareAcceptedJobs(a, b) >= 0 ? a : b));
    const held = (job: LiftJob): boolean => isFailedJob(job) && isHeldForChainProof(job);
    binding.set(key, group
      .filter((job) => isOccupyingLifecycleJob(job)
        && !(isFailedJob(job) && !held(job) && compareAcceptedJobs(job, newest) < 0))
      .sort((a, b) => (held(a) === held(b) ? compareAcceptedJobs(b, a) : (held(a) ? -1 : 1))));
  }
  return binding;
}

/**
 * #1837 — the single terminal-clear authority, reused by both `clear(status)` (bulk, through
 * {@link isBulkClearableTerminalLiftJob}) and `clearTerminalJob(jobId)` so they cannot drift. A job
 * is clearable iff it is in a native terminal state (finalized|failed) AND is not a
 * `retry_recovery`-failed job — those may still carry a pending on-chain tx that periodic recovery
 * will finalize, so NEITHER clear lane removes them (they leave the queue when `recover()`
 * finalizes them from chain). A `retry_recovery`-failed job is therefore treated as
 * NONTERMINAL-for-cleanup.
 */
export function isClearableTerminalLiftJob(job: LiftJob): boolean {
  return isTerminalLiftJobState(job.status)
    && !(isFailedJob(job) && job.failure.resolution === 'retry_recovery');
}

/**
 * GH#2270 — what BULK `clear(status)` may delete: terminal-clearable, MINUS a job
 * {@link isHeldForChainProof}. Deleting a held job is what turns admission's
 * `LiftJobPendingChainProofError` back into a fresh job for the same KA, so bulk cleanup is safe by
 * default; the by-jobId clear (`clearTerminalJob`) stays the operator's deliberate, targeted
 * override — there the operator names the exact job and owns the consequence.
 *
 * A job whose failure PROVES its transaction had no effect is not held, so routine cleanup of
 * reverted and unfunded attempts keeps working. Nothing is lost by clearing either: the #1829
 * journal is append-only and a clear never touches it, so the txHash outlives the job record.
 */
export function isBulkClearableTerminalLiftJob(job: LiftJob): boolean {
  return isClearableTerminalLiftJob(job) && !(isFailedJob(job) && isHeldForChainProof(job));
}

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
 * `blockedPendingRecovery`, both `skip_*` as `skipped`. INTERNAL vocabulary — the package's public
 * surface exposes the counts and the projection, never these strings.
 */
export type FailedJobRetryAction =
  | 'reaccept'
  | 'blocked_recovery'
  | 'blocked_pending_chain_proof'
  | 'skip_terminal'
  | 'skip_exhausted';

/**
 * Which count of one retry pass each action contributes to, co-located with the action it
 * aggregates. A `Record` over the union is exhaustive at COMPILE time: a sixth action cannot be
 * added without choosing its bucket here, where a reader can see the collapse, instead of falling
 * into whatever the aggregation loop happened to do last.
 */
export const FAILED_JOB_RETRY_ACTION_COUNT: Record<
  FailedJobRetryAction,
  'retried' | 'blockedPendingRecovery' | 'skipped'
> = {
  reaccept: 'retried',
  blocked_recovery: 'blockedPendingRecovery',
  blocked_pending_chain_proof: 'blockedPendingRecovery',
  skip_terminal: 'skipped',
  skip_exhausted: 'skipped',
};

/**
 * The WRITE decision, over the job alone: what a retry pass does with it. The operator's
 * `autoRetryEnabled` knob is not an input and the signature has nowhere to put it — a manual retry
 * does the same thing whether the automatic lane is on or off.
 *
 * Chain safety is decided before BOTH the terminal shortcut and the budget: a job whose transaction
 * is unaccounted for is held whatever its code says (a terminal `confirmation_mismatch` is exactly
 * such a job), and it can never be reaccepted because a budget happened to remain.
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

/**
 * The read view of {@link classifyRetryAction}: the same action, plus the operator's knob and the
 * job's actual SCHEDULE.
 *
 * Being allow-listed is not the same as being scheduled. The claim-time sweep only reaccepts a job
 * whose `nextRetryAt` is set and due, and that timestamp is assigned when the failure is RECORDED —
 * so a job that failed while the kill-switch was off, or one persisted by a build that predates the
 * lane, stays allow-listed forever and is never picked up. Reporting `backoff` there promises a
 * retry no sweep will run.
 *
 * The check belongs HERE and not in {@link isAutomaticallyRetryableLiftJob}: that predicate runs at
 * recording time, BEFORE the schedule exists, so requiring a schedule there would stop anything
 * from ever being scheduled at all.
 *
 * An unscheduled job therefore reads `{autoRetryEligible: false, waitingReason: 'operator'}` — the
 * honest answer, since nothing automatic will move it and `POST /api/publisher/retry` or a
 * re-submit re-arms it. The manual paths are untouched: {@link classifyRetryAction} never consults
 * the schedule, so a bulk retry still reaccepts such a job.
 */
export function describeRetryProjection(
  job: PersistedFailedJob,
  options: { readonly autoRetryEnabled: boolean },
): LiftJobRetryProjection {
  const autoRetryEligible = isAutomaticallyRetryableLiftJob(job, options)
    && job.timestamps.nextRetryAt !== undefined;
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
 * {@link describeRetryProjection} for any job. A job that has not failed has no retry projection:
 * nothing is eligible, and it is not waiting on a retry.
 */
export function deriveLiftJobRetryProjection(
  job: LiftJob,
  options: { readonly autoRetryEnabled: boolean },
): LiftJobRetryProjection {
  if (!isFailedJob(job)) return { autoRetryEligible: false };
  return describeRetryProjection(job, options);
}
