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
  liftJobOperationKindMarker,
  isFailedJob,
  pinnedPublishIdentityKaId,
  isKnowledgeAssetVmPublishJobRequest,
  queuedLiftOperationKind,
  type PersistedFailedJob,
} from './async-lift-publisher-utils.js';
import { knowledgeAssetAgentAddressesEqual } from '@origintrail-official/dkg-core';
import { getLiftJobFailurePolicy, isTerminalLiftJobState } from './lift-job.js';
import type { LiftJob, LiftJobFailureCode } from './lift-job.js';
// Type-only, and erased at emit — the reverse edge (types importing `LiftJobRetryProjection`
// from here) is type-only too, so nothing circular survives into the JavaScript. The verdict
// vocabulary stays defined once, beside the resolver contract that produces it.
import type { AsyncLiftChainProofResolution } from './async-lift-publisher-types.js';

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
  // A live broadcast record is unconditional: this job signed that transaction itself and nothing
  // has accounted for it. Same for an `included` origin — inclusion implies a transaction.
  if (job.broadcast?.txHash) return true;
  if (job.failure.failedFromState === 'included') return true;
  // GH#2270 PR-3 r3 — the INHERITED hash, carried in the recovery record by an earlier reset. It
  // is evidence only while it remains an open question. Once the proof-first dispatcher has
  // established the transaction's fate and released the job on the strength of it, the hash stays
  // for audit but stops holding anything: continuing to read it as unaccounted would strand the
  // job forever, because it can never be proven a second time — nothing new was ever sent.
  const recovery = job.recovery;
  if (!recovery?.txHashChecked) return false;
  // Only a RESET record can carry the accounted mark; a finalized-from-chain record is not a
  // job that is still waiting on anything.
  return recovery.action !== 'reset_to_accepted' || recovery.txHashAccounted !== true;
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
 * PR #2300 r1 (🟡 3809054821) — does an AUTOMATIC lane exist that can move THIS held job, or is
 * the operator's by-id clear its only exit? The pending-chain-proof 503 advertises `retryable`
 * from this answer, per job, instead of a constant `true` that promised convergence to jobs no
 * automatic lane can ever touch.
 *
 * The matrix, from the record alone (chain truth — did the transaction actually mine, was the
 * slot consumed — is not observable here, and the cells say what each answer PROMISES):
 *
 *  - CREATE with a recorded nonce and a pinned identity → TRUE, and the promise is
 *    unconditional: if the transaction mined, canonical recognition finalizes it; if it can never
 *    mine, the three-proof absence release re-runs it. Every chain-truth world has an exit.
 *  - CREATE without a recorded nonce (legacy pre-write-ahead records, inherited hashes) or
 *    without a pinned identity → FALSE: recognition would move it only in the world where the
 *    transaction mined, and no absence proof exists to release it in the other — a dropped
 *    transaction leaves it holding until an operator clears it, so `retryable: true` would be a
 *    promise the lane cannot keep.
 *  - UPDATE whose recognition question is fully formed (pinned identity + intended root) → TRUE,
 *    but the promise is CONDITIONAL and documented as such: canonical recognition converges iff
 *    the transaction actually mined. An update has no absence lane at all (the ABA hazard), so a
 *    dropped update keeps answering 503 until the operator acts — the record cannot distinguish
 *    that world from the about-to-converge one, and this cell is where the honest per-job answer
 *    bottoms out.
 *  - UPDATE without a derivable recognition identity, and any job whose lookup cannot even be
 *    formed (no hash, no wallet) → FALSE: nothing automatic can ever ask a question about it.
 */
export function hasAutomaticRecoveryExit(job: PersistedFailedJob): boolean {
  if (!getLiftJobTransactionEvidence(job)) return false;
  // r15 (3814317413) — the promise must match what the DISPATCHER will actually do. It refuses to
  // finalize a record that cannot form a published-finalized job (claim and validation are part of
  // that shape), so a record missing them has no automatic exit however complete its proof looks:
  // every tick would resolve `recovered` and then decline, leaving the operator-only clear the
  // response said was unnecessary.
  if (!job.claim || !job.validation) return false;
  if (!(job.broadcast?.walletId ?? job.claim?.walletId)) return false;
  const pinnedId = pinnedPublishIdentityKaId(job);
  if (pinnedId === undefined) return false;
  // PR #2300 r5 (3812123691) — the exit is OPERATION-SPECIFIC, so it may only be promised on
  // authoritative evidence of which operation ran. `queuedLiftOperationKind` answers 'update' for
  // an unmarked record as a SAFE fallback, not as a fact: if such a record was really a create,
  // update recognition can never recognize it and update absence is deliberately inconclusive, so
  // every chain outcome leaves it held. Promising a retry there sends the client into a loop.
  // Unmarked means the operator's by-id clear, and the response now says so.
  if (liftJobOperationKindMarker(job) === undefined) return false;
  if (queuedLiftOperationKind(job) === 'create') {
    return job.broadcast?.nonce !== undefined;
  }
  const intendedRoot = (job.request as { knowledgeAssetVmPublish?: { sealMerkleRoot?: unknown } })
    .knowledgeAssetVmPublish?.sealMerkleRoot;
  return typeof intendedRoot === 'string' && intendedRoot.length > 0;
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
 * Can THIS node settle a held job itself — the CAPABILITY half of "does an automatic exit exist"?
 *
 * {@link hasAutomaticRecoveryExit} answers from the record alone (is there a question the chain
 * could settle). This answers whether the components that would ask and act are wired up, per
 * WALLET and per OPERATION, because both narrow what can actually be settled.
 *
 * 3825614002 — a publisher instance has a ROLE, and the role is now named and chosen ONCE, at
 * construction. It used to be inferred inside the decision method from which collaborators
 * happened to be installed, so the same oracle meant different things depending on whether a
 * resolver sat beside it and a reader had to reconstruct constructor combinations to know which.
 */
export type HeldJobSettlementCapability = (
  job: PersistedFailedJob,
  walletId: string,
  operationKind: 'create' | 'update' | undefined,
) => boolean;

/** Neither a local lane nor an oracle: this instance genuinely has no automatic exit to offer. */
export const NO_HELD_JOB_SETTLEMENT: HeldJobSettlementCapability = () => false;

/**
 * The ADMISSION role: this instance holds no resolvers of its own and runs no scheduler, but it is
 * the one that answers clients. It therefore asks the lane that would actually do the work, and
 * that oracle IS the answer — not a narrowing of local wiring it does not have. Consulting a
 * named-recovery resolver here would ask this instance about a collaborator only the runtime has.
 */
export function delegatedHeldJobSettlement(
  capableForWallet: (walletId: string, operationKind: 'create' | 'update' | undefined) => boolean,
): HeldJobSettlementCapability {
  return (_job, walletId, operationKind) => capableForWallet(walletId, operationKind);
}

/**
 * The RUNTIME role: this instance owns the lane. An oracle, when present, narrows the answer per
 * wallet and operation; the local wiring still has to be complete on top of that.
 *
 * r12 (3813505773) — a named job needs the named recovery resolver whatever its kind. The create
 * case looks exempt because the absence release is create-only and needs nothing but the reset, but
 * that is only ONE of its outcomes: if the transaction MINED, settling it means building canonical
 * evidence and repairing the lifecycle, which is exactly what that resolver does. Without it a
 * mined create is held forever while the response promised convergence.
 */
export function localHeldJobSettlement(options: {
  readonly capableForWallet?: (walletId: string, operationKind: 'create' | 'update' | undefined) => boolean;
  readonly hasNamedRecoveryResolver: boolean;
}): HeldJobSettlementCapability {
  return (job, walletId, operationKind) => {
    if (options.capableForWallet && !options.capableForWallet(walletId, operationKind)) return false;
    if (!isKnowledgeAssetVmPublishJobRequest(job.request)) return true;
    return options.hasNamedRecoveryResolver;
  };
}

/**
 * Pick the role from how this instance was wired. Deliberately the ONE place that reads collaborator
 * presence for this purpose: after construction the decision asks the returned policy directly.
 */
export function resolveHeldJobSettlementCapability(wiring: {
  readonly hasChainProofResolver: boolean;
  readonly capableForWallet?: (walletId: string, operationKind: 'create' | 'update' | undefined) => boolean;
  readonly hasNamedRecoveryResolver: boolean;
}): HeldJobSettlementCapability {
  if (!wiring.hasChainProofResolver) {
    return wiring.capableForWallet
      ? delegatedHeldJobSettlement(wiring.capableForWallet)
      : NO_HELD_JOB_SETTLEMENT;
  }
  return localHeldJobSettlement({
    ...(wiring.capableForWallet ? { capableForWallet: wiring.capableForWallet } : {}),
    hasNamedRecoveryResolver: wiring.hasNamedRecoveryResolver,
  });
}

/**
 * Does this caller own the job's admission lane?
 *
 * The pending-transaction override below is destructive and `/api/publisher/clear-job` is open to
 * every registered agent token, so the right to accept that risk is per JOB, not per node.
 *
 * The owner is the AUTHENTICATED ENQUEUER, not the resolved author: curated publishing lets those
 * differ (GH#1778), so a curator may submit for another author and it is the curator who admitted
 * the job. A record with no admission has nobody to match and is denied — falling back to the
 * author would grant the override to an identity that did not enqueue anything, and the risk being
 * accepted is a double publish.
 *
 * This boundary is generic over job kind on purpose (3824743779): it reads one typed job-level
 * field and never inspects an operation payload, so a new job variant needs no case here.
 *
 * Attribution comes ONLY from an explicit stamp made at admission (3825162149). There is
 * deliberately no fallback that reads the publish payload's `callerAgentAddress`: on the
 * agent's own publish path that field is the AUTHOR, so such a fallback silently handed the
 * destructive override to a curated-publish signer who enqueued nothing. A record with no
 * stamp is denied instead, which is the conservative answer and the one this doc has always
 * claimed.
 */
function ownsLiftJobAdmissionLane(job: LiftJob, agentAddress: string | undefined): boolean {
  if (!agentAddress) return false;
  const admittedBy = job.admission?.byAgentAddress;
  if (typeof admittedBy !== 'string' || admittedBy.length === 0) return false;
  // The REPOSITORY's identity equality, not a second definition. A bespoke
  // `toLowerCase()` folded case for legacy non-EVM identities (peer IDs) too, which the
  // canonical helper deliberately compares byte-for-byte: on a destructive authorization
  // boundary that silently widened who counts as the owner.
  return knowledgeAssetAgentAddressesEqual(admittedBy, agentAddress);
}

/**
 * What the TARGETED by-id clear may remove.
 *
 * #1837's base predicate treats transaction-bearing jobs as nonterminal-for-cleanup, because
 * periodic recovery may still finalize them from chain. That is right for bulk cleanup. The
 * explicit owner override is also the exit when an operator abandons one exact closed-run record:
 * it accepts a pre-broadcast `validated` record, a `retry_recovery` failure, or a live
 * `broadcast`/`included` record. The append-only journal remains, and no broad clear receives this
 * authority. A `claimed` record stays denied because it can still be running before validation;
 * an operator must stop the runner and let that claim resolve before clearing it.
 *
 * The exception is named rather than expressed as the base predicate's complement: written that
 * way it would silently absorb every future reason a terminal job becomes protected. Additions to
 * the base policy stay denied here until someone allows them on purpose.
 *
 * The caller must also be entitled to it — see {@link ownsLiftJobAdmissionLane}.
 */
export function isTargetedClearableLiftJob(
  job: LiftJob,
  options: {
    /**
     * The override as the CALLER made it: who requested it, not whether someone decided they
     * may have it (3825162663). Taking a boolean here reduced authenticated authority to a flag at
     * the call site and left the ownership check as a separate step a future targeted-clear
     * could forget while still reading the apparently canonical predicate.
     */
    readonly pendingTransactionOverride?: { readonly requestedBy?: string };
  } = {},
): boolean {
  if (isClearableTerminalLiftJob(job)) return true;
  const override = options.pendingTransactionOverride;
  if (!override) return false;
  // Authority and state eligibility are decided together, so neither can be granted alone.
  if (!ownsLiftJobAdmissionLane(job, override.requestedBy)) return false;
  if (job.status === 'validated' || job.status === 'broadcast' || job.status === 'included') return true;
  return isTerminalLiftJobState(job.status)
    && isFailedJob(job)
    && job.failure.resolution === 'retry_recovery';
}

/**
 * What BULK `clear(status)` may delete: terminal-clearable, MINUS a job {@link isHeldForChainProof}.
 *
 * Deleting a held job turns admission's `LiftJobPendingChainProofError` back into a fresh job for
 * the same KA, so bulk cleanup is safe by default and the targeted lane above is where an operator
 * accepts that risk deliberately, for one named job.
 *
 * A job whose failure PROVES its transaction had no effect is not held, so routine cleanup of
 * reverted and unfunded attempts keeps working. Nothing is lost either way: the #1829 journal is
 * append-only and a clear never touches it, so the txHash outlives the job record.
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

/**
 * GH#2270 PR-3 — what the dispatcher DOES with one held job once the chain has answered.
 *
 * The command, not the effect. Persistence, wallet locks and journal writes stay in the publisher;
 * what is decided here is the mapping from a chain fact to a disposition, which is failed-job
 * policy and belongs beside the predicates that define the hold in the first place. Splitting it
 * out is also what makes the decision testable without a store: every row below is a pure
 * (job, verdict) pair.
 */
export type ChainProofDisposition =
  /** The chain carries the publish. Finalize this job from the evidence the verdict carries. */
  | { readonly action: 'finalize' }
  /**
   * Nothing of this job's is on chain. Release it for a re-run under the same jobId, through the
   * evidence-preserving reset — proven absence, or a revert of a transaction some EARLIER attempt
   * sent (this job failed before signing anything of its own).
   */
  | { readonly action: 'reset' }
  /**
   * This job's OWN transaction reverted. Re-record it as `tx_reverted`: the registry's
   * proven-ineffective verdict releases the hold through {@link isProvenIneffectiveLiftFailure},
   * and the job stays terminal rather than being re-run on the node's money.
   */
  | { readonly action: 'refail_reverted'; readonly failedFromState: 'broadcast' | 'included' }
  /** Nothing was established. Keep holding; the next pass asks again. */
  | { readonly action: 'hold' };

/**
 * The dispatcher's decision table, over the job and the chain's verdict alone.
 *
 * `reverted` is the only verdict whose disposition depends on the JOB, and the question it asks is
 * whose transaction reverted. A job that failed from 'broadcast'/'included' signed that one
 * itself, so `tx_reverted` is a true statement about it and releases the hold the registry's way.
 * A job holding an INHERITED hash failed before signing anything — the reverted transaction
 * belongs to an earlier attempt, `LIFT_JOB_FAILURE_ALLOWED_STATES` rejects `tx_reverted` from a
 * pre-send state for exactly that reason, and the honest release is the same reset a proven
 * absence gets.
 *
 * `unrecognized` sits with `pending`/`inconclusive` and not with the absences: a mined transaction
 * carrying no publish this adapter can parse is a fact about THAT transaction, not proof that no
 * publish happened — an adapter with unwired publish contracts lands there too.
 */
export function decideChainProofDisposition(
  job: PersistedFailedJob,
  verdict: AsyncLiftChainProofResolution['status'],
): ChainProofDisposition {
  switch (verdict) {
    case 'recovered':
      return { action: 'finalize' };
    case 'not-found':
      // GH#2270 PR-3 r4 — release-by-absence is CREATE-ONLY, enforced HERE because this is the
      // decision that authorises the reset write. The CLI resolver already refuses to earn a
      // `not-found` for an update, but the resolver is replaceable wiring; an embedder's resolver
      // that does not know the rule must not be able to release an update through this table. An
      // update has no monotone register to prove absence against — "the intended root is not
      // current" also describes our update landing and then being SUPERSEDED by a third party,
      // and a release would re-apply the stale root over newer state (the ABA hazard). Held, with
      // the operator's by-id clear as the exit.
      return queuedLiftOperationKind(job) === 'update' ? { action: 'hold' } : { action: 'reset' };
    case 'reverted':
      if (job.failure.failedFromState === 'broadcast' || job.failure.failedFromState === 'included') {
        return { action: 'refail_reverted', failedFromState: job.failure.failedFromState };
      }
      // r16 (3814610383) — the INHERITED-hash fall-through re-queues the job, and re-queuing an
      // update replays its immutable request. A revert proves the earlier transaction had no
      // effect; it says nothing about whether that request is still current, so replaying it can
      // write a stale root over a newer third-party version — the same ABA hazard the `not-found`
      // branch above refuses to take. The create-only rule therefore applies to both ways of
      // reaching a reset, not just to absence.
      return queuedLiftOperationKind(job) === 'update' ? { action: 'hold' } : { action: 'reset' };
    case 'pending':
    case 'unrecognized':
    case 'inconclusive':
      return { action: 'hold' };
    default: {
      // A new verdict must choose its disposition here rather than inherit a silent hold.
      const unhandled: never = verdict;
      return unhandled;
    }
  }
}
