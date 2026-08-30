import type {
  AdmissionJournalEntry,
  KnowledgeAssetVmPublishRequest,
  LiftJob,
  PersistedLiftJob,
  LiftJobBroadcast,
  LiftJobClaimed,
  LiftJobClaimMetadata,
  LiftJobFinalizationInput,
  LiftJobIncluded,
  LiftJobInclusionMetadata,
  LiftJobHex,
  LiftJobState,
  LiftJobValidationMetadata,
  LiftPublishRequestMetadata,
  LiftPublishSnapshotRequest,
} from './lift-job.js';
import type {
  LiftJobRetryProjection,
} from './async-lift-retry-disposition.js';
import type { DKGPublisher } from './dkg-publisher.js';
import type { PublishOptions, PublishResult } from './publisher.js';
import type { AsyncLiftPublishFailureInput } from './async-lift-publish-result.js';
import type { AsyncPreparedPublishPayload, LiftResolvedPublishSlice } from './async-lift-publish-options.js';
import type { WorkspacePublicSnapshotStore } from './workspace-snapshot-store.js';
import type { PublishTransactionObservation } from '@origintrail-official/dkg-chain';
import type { TargetedLiftJobClearOptions, TerminalJobClearOutcome } from './terminal-job-clear.js';

export class AsyncLiftJobConflictError extends Error {
  readonly code = 'ASYNC_LIFT_JOB_CONFLICT';

  constructor(
    message: string,
    readonly existingJobId: string,
  ) {
    super(message);
    this.name = 'AsyncLiftJobConflictError';
  }
}

/**
 * GH#2270 — admission refused to republish a failed job that may already have submitted a
 * transaction. The job is untouched and keeps its lifecycle subject (`existingJobId`).
 *
 * PR #2300 r1 (🟡 3809054821) — `retryable` is JOB-SPECIFIC now, computed at the throw site from
 * the policy module's `hasAutomaticRecoveryExit`: `true` promises that an automatic lane exists
 * that can move THIS job (canonical recognition, or the create-only absence release), so
 * re-submitting converges without an operator; `false` says the record has no automatic exit —
 * only the operator's by-id clear moves it — and a client that keeps retrying will keep getting
 * the 503 forever. A constant `true` made that promise to jobs the lane can never touch.
 */
export class LiftJobPendingChainProofError extends Error {
  readonly code = 'LIFT_JOB_PENDING_CHAIN_PROOF';

  constructor(
    message: string,
    readonly existingJobId: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LiftJobPendingChainProofError';
  }
}

/**
 * The worker that started an execution no longer owns the persisted claim.
 *
 * A fresh claim token is written on every wallet acquisition. Recovery may
 * legitimately expire and replace that claim while an older asynchronous
 * frame is still unwinding. That frame must stop without changing the newer
 * job; this typed error is the ownership-boundary signal consumed by
 * `processNext()`.
 */
export class StaleLiftJobClaimError extends Error {
  override readonly name = 'StaleLiftJobClaimError';

  constructor(
    readonly jobId: string,
    reason: string,
  ) {
    super(`Stale LiftJob claim for ${jobId}: ${reason}`);
  }
}

/**
 * A newly acquired queue claim with ownership fields required at the type boundary.
 *
 * The persisted job shape keeps claim tokens optional for legacy records. A live worker must
 * never operate on that broad shape: acquisition upgrades it to this handle, and every
 * worker-side mutation carries the same immutable wallet/token pair back to the queue.
 */
export type ActiveLiftJobClaim = LiftJobClaimed & {
  readonly claim: LiftJobClaimMetadata & {
    readonly claimToken: string;
    readonly claimLeaseExpiresAt: number;
  };
};

/**
 * The mutation authority for one acquired claim.
 *
 * Runtime workers retain this session rather than a bare job id. Every mutation is fenced by
 * the immutable wallet/token pair in {@link claim}; a recovered or re-claimed job therefore
 * rejects the stale session before it can change queue truth.
 */
export interface ActiveLiftJobClaimSession {
  readonly claim: ActiveLiftJobClaim;
  update(status: LiftJobState, data?: Partial<LiftJob>): Promise<void>;
  recordPublishResult(
    publishResult: PublishResult,
    options?: { publicByteSize?: number },
  ): Promise<LiftJob>;
  recordExecutionFailure(failedFromState: LiftJobState, error: unknown): Promise<LiftJob>;
}

/** Explicit by-id compatibility surface for control-plane callers, never runtime workers. */
export interface AsyncLiftAdministrativeMutations {
  updateById(jobId: string, status: LiftJobState, data?: Partial<LiftJob>): Promise<void>;
  recordPublishResultById(
    jobId: string,
    publishResult: PublishResult,
    options?: { publicByteSize?: number },
  ): Promise<LiftJob>;
  recordPublishFailureById(jobId: string, failure: AsyncLiftPublishFailureInput): Promise<LiftJob>;
}

/** #1828 — the immutable facts a client retains to recover a lost VM-publish admission. */
export interface IntentLookupInput {
  readonly contextGraphId: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly agentAddress?: string;
  /** Optional exactness qualifier; sets `exactIntentMatch` on the result. */
  readonly intentKey?: string;
}

/**
 * #1828 — deterministic result of an intent lookup. At most one ACTIVE job can
 * exist per lifecycle subject (admission dedup invariant), so `active` is the
 * live job to bind; `superseded` carries terminal jobs sharing the subject;
 * `conflict` (>1 active) signals a broken invariant. `exactIntentMatch` (only
 * when the caller passed `intentKey`) reports whether the returned job's stored
 * intent equals it.
 */
export type IntentLookupResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'active'; readonly job: PersistedLiftJob; readonly superseded: PersistedLiftJob[]; readonly exactIntentMatch?: boolean }
  | { readonly kind: 'superseded'; readonly jobs: PersistedLiftJob[]; readonly exactIntentMatch?: boolean }
  | { readonly kind: 'conflict'; readonly jobs: PersistedLiftJob[] };

/**
 * Queue-layer facts about an admission, supplied alongside the operation request.
 *
 * Separate from the request on purpose (GH#2270 follow-up 🟡 3824743779): the authenticated
 * enqueuer authorizes later control-plane actions on the job and is not an input to the operation,
 * so execution and recovery never see it in the payload they act on.
 */
export interface AsyncLiftAdmissionContext {
  /**
   * The authenticated identity admitting the job. REQUIRED whenever a context is supplied
   * (3825162430): an authenticated admission has exactly one principal, so `{}` must not compile
   * into a job that is silently unowned. A caller with no principal omits the whole argument,
   * which is a different and visible statement.
   */
  readonly admittedByAgentAddress: string;
}

export interface AsyncLiftPublisher {
  enqueueKnowledgeAssetVmPublish(
    request: KnowledgeAssetVmPublishRequest,
    admission?: AsyncLiftAdmissionContext,
  ): Promise<string>;
  /** Legacy acquisition shape; fenced workers narrow this on ClaimSessionAsyncLiftPublisher. */
  claimNext(walletId: string): Promise<LiftJob | null>;
  /** Optional v10.0.15 worker-ownership capability; older structural implementations omit it. */
  openClaimSession?(claim: ActiveLiftJobClaim): ActiveLiftJobClaimSession;
  /** Optional v10.0.15 administrative capability; legacy by-id methods remain compatible. */
  readonly administrative?: AsyncLiftAdministrativeMutations;
  /**
   * Administrative/compatibility mutation by exact job id. Runtime workers use the owned-claim
   * session returned by {@link openClaimSession}, where the claim token is mandatory and
   * revalidated on every write.
   *
   * @deprecated Prefer `administrative.updateById`; workers must use `openClaimSession`.
   */
  update(jobId: string, status: LiftJobState, data?: Partial<LiftJob>): Promise<void>;
  getStatus(jobId: string): Promise<PersistedLiftJob | null>;
  list(filter?: { status?: LiftJobState }): Promise<PersistedLiftJob[]>;
  inspectPreparedPayload(jobId: string): Promise<AsyncPreparedPublishPayload | null>;
  processNext(walletId: string): Promise<PersistedLiftJob | null>;
  /** @deprecated Prefer `administrative.recordPublishResultById`; workers use a claim session. */
  recordPublishResult(jobId: string, publishResult: PublishResult, options?: { publicByteSize?: number }): Promise<LiftJob>;
  /** @deprecated Prefer `administrative.recordPublishFailureById`; workers use a claim session. */
  recordPublishFailure(jobId: string, failure: AsyncLiftPublishFailureInput): Promise<LiftJob>;
  /**
   * Run one reconciliation pass and report how many jobs it settled.
   *
   * CONCURRENCY CONTRACT: safe to call at any time, including concurrently with any other
   * in-flight pass. Every call performs its own pass over its own freshly read inventory —
   * passes are never coalesced. Inventory ACQUISITION, however, is FIFO-ordered: a concurrent
   * call's read starts only once the previous acquisition completes or exceeds its owner
   * lease ({@link AsyncLiftPublisherConfig.reconciliationAcquisitionLeaseMs}), so added
   * latency is bounded per predecessor and a hung read cannot block the seam indefinitely.
   */
  recover(): Promise<number>;
  /**
   * Reconcile interrupted work without restarting the runner. Older implementations can omit
   * it. Same concurrency contract as {@link recover}.
   */
  reconcileTransactions?(): Promise<number>;
  /** Wait until every receipt task detached after RPC acceptance has stopped. Older implementations can omit it. */
  drainDetachedExecutions?(): Promise<void>;
  /**
   * Demand-driven reconciliation scheduling. ONE optional capability rather than independent
   * optional methods, so a publisher cannot implement the wake-up without the outlook (or the
   * reverse) — the incoherent halves are unrepresentable. Older implementations omit the whole
   * capability and a caller that never subscribes loses nothing but latency.
   */
  readonly reconciliationScheduling?: {
    /**
     * EXCLUSIVE, ATOMIC attachment of the scheduling listeners — deliberately not pub/sub.
     * Scheduling has exactly one owner (the runner driving this publisher), so attaching TAKES
     * OVER both callbacks together: a later attachment supersedes the earlier one wholesale —
     * the safe handover when a new runner incarnation starts while its predecessor is still
     * stopping — and ownership can never be split between incarnations. The returned detach
     * releases only the caller's OWN attachment (a stale detach from a superseded owner is a
     * no-op).
     *
     * Both pokes are scheduling-only and establish nothing — the invited operation re-checks
     * its own guards. `onReconciliationDemand` fires when a tx-bearing job stops being
     * executor-owned (a detached receipt settles, or `processNext` hands back a live broadcast
     * after an ambiguous send) — only once the work is visible to a
     * {@link reconcileTransactions} pass. `onWalletRelease` fires with the wallet id the
     * moment that wallet's lock is DELETED (job finalized, proven ineffective and reset, or
     * swept as stale) — exactly when the wallet becomes claimable — so wallet turnover is
     * bounded by chain time rather than by the claim poll.
     */
    attachScheduler(scheduler: {
      onReconciliationDemand(): void;
      onWalletRelease(walletId: string): void;
    }): () => void;
    /**
     * Run one reconcile pass and report BOTH what it settled and whether actionable live work
     * remains — one operation, one atomic answer, computed during the pass's own walk rather
     * than by a second queue inventory. This is what the scheduling caller consumes per tick
     * to pick its next cadence: a separate post-pass outlook query could fail after the pass
     * succeeded and strand an already-served demand on the idle cadence. Identical pass
     * semantics to {@link reconcileTransactions}, which stays the wire-stable numeric surface
     * over the same pass.
     */
    reconcile(): Promise<{ reconciled: number; pendingWork: boolean }>;
    /**
     * Startup recovery with the same outcome shape: stale-wallet-lock sweep plus one reconcile
     * pass, so a starting caller seeds its cadence from the pass it already ran instead of
     * paying a second boot-time inventory. Identical recovery semantics to
     * {@link AsyncLiftPublisher.recover}, the wire-stable numeric surface over the same pass.
     */
    recover(): Promise<{ reconciled: number; pendingWork: boolean }>;
  };
  getStats(): Promise<Record<LiftJobState, number>>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(jobId: string): Promise<void>;
  /**
   * Reaccept every failed job the publisher may safely re-run, and return HOW MANY were
   * reaccepted — a stable operator-visible count, unchanged by GH#2270. Jobs left failed
   * (evidence-bearing, recovery-owned, terminal, exhausted) are reported by
   * {@link AsyncLiftDetailedRetrier.retryDetailed}, which this method delegates to; the
   * evidence safety is in that ONE shared path, never in the caller's choice of method.
   */
  retry(filter?: { status?: 'failed' }): Promise<number>;
  clear(status: 'finalized' | 'failed'): Promise<number>;
}

/** Publisher with the fenced worker-session and explicit administrative capabilities. */
export interface ClaimSessionAsyncLiftPublisher extends AsyncLiftPublisher {
  claimNext(walletId: string): Promise<ActiveLiftJobClaim | null>;
  openClaimSession(claim: ActiveLiftJobClaim): ActiveLiftJobClaimSession;
  readonly administrative: AsyncLiftAdministrativeMutations;
}

/** GH#2270 — full disposition of one `retry()` pass. The three counts partition the failed set. */
export interface AsyncLiftRetryOutcome {
  /** Reaccepted (failed → accepted), same jobId, retry budget consumed. */
  readonly retried: number;
  /**
   * Left failed because a transaction may exist: `retry_recovery`-resolved jobs (which
   * `recover()` owns) and evidence-bearing jobs awaiting chain proof. Operator-actionable, and
   * the work queue the proof-first dispatcher will drain.
   */
  readonly blockedPendingRecovery: number;
  /** Left failed with nothing to reaccept: terminal failures and spent retry budgets. */
  readonly skipped: number;
}

/** Selection contract shared by bulk and exact failed-job retry callers. */
export interface AsyncLiftRetryFilter {
  readonly status?: 'failed';
  /** When present, inspect and transition only this exact persisted job. */
  readonly jobId?: string;
}

/**
 * GH#2270 — the reporting counterpart of `retry()`. Segregated off the base contract (like the
 * #1828/#1829/#1837 capabilities): the wire-stable count stays on `AsyncLiftPublisher`, and the
 * paths that report to an operator read the full disposition here.
 */
export interface AsyncLiftDetailedRetrier {
  retryDetailed(filter?: AsyncLiftRetryFilter): Promise<AsyncLiftRetryOutcome>;
}

/**
 * GH#2270 — the read-only retry projection of a job the publisher ALREADY returned. It lives on
 * the publisher (not on the caller) because the derivation reads the effective `autoRetryEnabled`
 * this instance resolved: a route that re-derived it from config would be free to disagree with
 * the lane that actually runs (the #1836 bug class). Synchronous — no store access, no writes.
 *
 * SCOPE, and the boundary a host must respect: this answers what the CONFIGURED lane would do with
 * this job. The queue cannot see whether a publisher RUNTIME exists to run that lane — no funded
 * wallet, a failed startup and a healthy node all look identical from in here — so a host that
 * knows its runtime state must narrow the answer before serving it (the daemon does exactly that
 * in its job-detail route). Reporting `backoff` on a node with nothing running promises a retry
 * that will never fire.
 */
export interface AsyncLiftRetryStateReader {
  describeConfiguredRetryState(job: PersistedLiftJob): LiftJobRetryProjection;
}

/**
 * #1828 — a publisher that also exposes the read-only durable-admission intent
 * recovery lookup. Kept OFF the base {@link AsyncLiftPublisher} runtime queue
 * contract so runner/adapter implementations that never serve recovery are not
 * forced to implement it (the exported contract stays minimal). The daemon's
 * `createPublisherControlFromStore` returns this; the recovery route depends on
 * it. PR3/PR4 add their own feature reads on their own extended interfaces —
 * the base contract does not grow.
 */
export interface VmPublishIntentRecoveryPublisher extends AsyncLiftPublisher {
  /** #1828 — read-only recovery lookup by lifecycle facts (+ optional intentKey). */
  lookupKnowledgeAssetVmPublishJobByIntent(facts: IntentLookupInput): Promise<IntentLookupResult>;
}

/** #1829 — read query for the append-only journal (facts-pure, or by jobId). */
export interface JournalReadInput {
  readonly contextGraphId: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly agentAddress?: string;
  /** Optional per-version filter WITHIN the lineage; never the lineage key itself. */
  readonly intentKey?: string;
}

/**
 * #1829 — result of a journal read. `entries` are seq-ordered; `maxSeq` is -1 for an
 * empty lineage. `complete` = `entries.length === maxSeq + 1` (no seq gap) — authoritative
 * on oxigraph-worker; best-effort on external SPARQL backends (no fsync, so the
 * highest-seq entry can be lost on a crash without a gap being visible). `txHashes` are
 * ATTEMPTED submissions — a reconciler MUST verify each against chain; a hash here is
 * never proof the tx was sent (a pre-flush 'broadcast' entry can survive a rolled-back
 * attempt).
 */
export interface JournalReadResult {
  readonly entries: readonly AdmissionJournalEntry[];
  readonly maxSeq: number;
  readonly complete: boolean;
  readonly txHashes: readonly string[];
}

/**
 * #1829 — read-only append-only journal reader. Segregated off the base contract (like
 * the #1828 recovery lookup): only the daemon control instance serves it.
 */
export interface VmPublishAdmissionJournalReader {
  /** Facts-pure lineage read (derives lineageKey from facts, never the ephemeral index). */
  readJournalByIntent(facts: JournalReadInput): Promise<JournalReadResult>;
  /** All journal entries bearing this jobId (a successor job continues the lineage seq). */
  readJournalByJob(jobId: string): Promise<JournalReadResult>;
}

/**
 * #1837 — atomic by-jobId terminal cleanup. Segregated off the base contract (like the
 * #1828/#1829 capabilities); a MUTATION/admin capability, not a query. Clears the exact
 * job ONLY when it is in a native terminal state, rejects otherwise without mutation,
 * and is idempotent for an absent job. Never broadens to other jobs. On the lift side
 * this preserves the #1829 append-only journal by construction (subject-scoped delete
 * in the control-plane graph only).
 */
export interface VmPublishTerminalJobClearer {
  /**
   * GH#2270 follow-up (🔴 3823952704) — `allowPendingTransaction` opts in to clearing a job whose
   * transaction may still land. It is OFF by default: an agent must own this job's admission lane,
   * while an authenticated node operator may accept the risk for any job in the node's queue.
   */
  clearTerminalJob(
    jobId: string,
    options?: TargetedLiftJobClearOptions,
  ): Promise<TerminalJobClearOutcome>;
}

/**
 * #1828 — one-shot storage maintenance: (re)build the ephemeral intent index for
 * VM-publish jobs admitted before it existed. This is a boot-time repair, not a
 * runtime publisher behaviour, so it lives on its OWN narrow interface — the
 * daemon boot backfill depends only on this, never on the publisher contract.
 */
export interface VmPublishIntentIndexBackfiller {
  /** Idempotent additive backfill; returns the number of jobs (re)indexed. */
  ensureVmPublishIntentIndex(): Promise<number>;
}

/**
 * #1889 — the composite VM-publisher control surface returned by the daemon factory
 * (`createPublisherControlFromStore`) and held by `RequestContext.publisherControl`. Names
 * the capability set the daemon depends on, so the factory return type and the context field
 * are a single named contract instead of an ad-hoc intersection. The four base interfaces
 * remain the narrow contracts for callers that need a smaller surface (e.g. the boot
 * backfill depends only on `VmPublishIntentIndexBackfiller`).
 */
export interface VmPublisherControl
  extends VmPublishIntentRecoveryPublisher,
    VmPublishIntentIndexBackfiller,
    VmPublishAdmissionJournalReader,
    VmPublishTerminalJobClearer,
    AsyncLiftDetailedRetrier,
    AsyncLiftRetryStateReader {}

/**
 * PR #2300 r2 (🟡 3809616683) — the canonical facts UPDATE recognition established for the
 * `recovered` verdict, carried ON the verdict so the named finalizer consumes the SAME
 * verification instead of re-proving the transaction. This is what replaced the shared-verifier
 * memo: no cache, no shared instance, no temporal coupling — the evidence travels with the
 * verdict that earned it. The CREATE side deliberately does NOT get an equivalent: its
 * `publishProof` remains the finalizer's own canonical-receipt read (settled position).
 */
export interface CanonicalUpdateEvidence {
  /** The chain-verified new root — already proven equal to the root the queued seal intended. */
  readonly onChainRoot: LiftJobHex;
  /** The receipt's canonical block hash, when the verification produced one. */
  readonly blockHash?: LiftJobHex;
  /** The receipt's transaction index, when the verification produced one. */
  readonly txIndex?: number;
  /**
   * PR #2300 r5 (3812275749) — WHICH update in the asset's history this transaction wrote, as a
   * decimal string. Merkle roots are not version identifiers: a history of A → B → A makes the
   * FIRST update's root equal the latest one, so root equality cannot tell "still current" from
   * "superseded by a later update that happens to restore the same root". The position can.
   */
  readonly merkleRootCount?: string;
}

export interface AsyncLiftPublisherRecoveryResult {
  inclusion: LiftJobInclusionMetadata;
  finalization: LiftJobFinalizationInput;
  /** Present exactly when the verdict came from canonical UPDATE recognition. */
  canonicalUpdate?: CanonicalUpdateEvidence;
}

/** Required immutable transaction evidence for named-KA lifecycle recovery. */
export interface AsyncKnowledgeAssetVmPublishRecoveryEvidence
  extends AsyncLiftPublisherRecoveryResult {
  readonly inclusion: LiftJobInclusionMetadata & {
    readonly blockHash: LiftJobHex;
  };
  readonly publishProof: {
    readonly merkleRoot: LiftJobHex;
    readonly authorAddress: LiftJobHex;
    readonly txIndex: number;
    /**
     * PR #2300 r5 — the position this transaction wrote in the asset's update history, decimal.
     * The finalizer decides supersession from it when present, because a root that reappears
     * later in the history (A → B → A) makes root equality say "current" about an OLD update.
     */
    readonly merkleRootCount?: string;
    /**
     * r15 — which operation this proof was resolved FOR. The finalizer needs it to know when a
     * missing position is fatal: an update's currency cannot be settled by root bytes (repeated
     * roots), while a create's identity is minted once and never restored.
     */
    readonly operationKind?: 'create' | 'update';
  };
}

export interface AsyncLiftPublishExecutionInput {
  readonly walletId: string;
  readonly publishOptions: PublishOptions;
}

export interface AsyncKnowledgeAssetVmPublishExecutionInput {
  readonly walletId: string;
  readonly request: KnowledgeAssetVmPublishRequest;
  readonly snapshot: LiftPublishSnapshotRequest;
  readonly snapshotMetadata: LiftPublishRequestMetadata;
  readonly validation: LiftJobValidationMetadata;
  readonly resolved: LiftResolvedPublishSlice;
  readonly publishOptions: PublishOptions;
  readonly publisher?: DKGPublisher;
}

export interface AsyncKnowledgeAssetVmPublishPreflightInput {
  readonly walletId: string;
  readonly request: KnowledgeAssetVmPublishRequest;
  readonly snapshot: LiftPublishSnapshotRequest;
  readonly snapshotMetadata: LiftPublishRequestMetadata;
  readonly publisher?: DKGPublisher;
}

/**
 * Chain-confirmed recovery input for a named Knowledge Asset publish that was
 * interrupted after the transaction hash had been durably recorded.
 *
 * The finalizer is intentionally separate from the normal executor: recovery
 * must reconcile local VM/lifecycle state without submitting a second
 * transaction.
 */
export interface AsyncKnowledgeAssetVmPublishRecoveryInput {
  readonly walletId: string;
  readonly request: KnowledgeAssetVmPublishRequest;
  /**
   * GH#2270 PR-3 r3 — the PERSISTED record, whatever state it is actually in.
   *
   * It used to be typed as broadcast-or-included, which the failed-job dispatcher could only
   * satisfy by fabricating one: restore a synthetic status, rebuild the broadcast metadata a reset
   * had dropped, and cast. The boundary now takes the record as it is, and the facts a caller
   * needs about the transaction arrive separately and typed.
   */
  readonly job: PersistedLiftJob;
  /**
   * GH#2270 PR-3 r3 — the transaction facts, typed, from whichever carrier the record has. The
   * consumer needs the queued tx hash to bind the resolved receipt to it, and a failed job held
   * on the recovery carrier alone has no `broadcast` to read it off.
   */
  readonly lookup: AsyncLiftChainProofLookup;
  readonly recovery: AsyncKnowledgeAssetVmPublishRecoveryEvidence;
  readonly publisher?: DKGPublisher;
  /**
   * GH#2270 PR #2300 r25 — the pass deadline, so a handler that reaches the chain can cancel its
   * reads rather than leak them once per timed-out pass. The publisher additionally bounds this
   * whole phase in one race, so the ceiling does not depend on the handler honouring this.
   */
  readonly signal?: AbortSignal;
}

export type AsyncKnowledgeAssetVmPublishPreflightResult =
  | { readonly action: 'execute' }
  | { readonly action: 'noop'; readonly reason?: string };

/** Cohesive lifecycle boundary for one named-KA async queue job. */
export interface AsyncKnowledgeAssetVmPublishJobHandler {
  execute(input: AsyncKnowledgeAssetVmPublishExecutionInput): Promise<PublishResult>;
  preflight?(
    input: AsyncKnowledgeAssetVmPublishPreflightInput,
  ): Promise<AsyncKnowledgeAssetVmPublishPreflightResult>;
  finalizeRecovered?(input: AsyncKnowledgeAssetVmPublishRecoveryInput): Promise<void>;
}

/**
 * GH#2270 — what the chain established about one job's transaction.
 *
 * This resolver used to answer `AsyncLiftPublisherRecoveryResult | null`, and that `null` fused
 * "the chain proved this transaction does not exist" with "we could not find out". The
 * proof-first dispatcher turns on exactly that difference: a resend is safe on the first and a
 * double publish on the second, so the two cannot share an answer.
 *
 * The contract lives HERE, in the publisher, because the publisher is what decides on it — the
 * adapter and the runner that reads it are downstream implementers, and the publisher cannot
 * import from either. Whoever supplies the resolver owns one rule the union cannot express: an
 * absence must be ESTABLISHED. A lookup that failed, an adapter that cannot see the mempool, a
 * wallet with no publisher — all of those are `inconclusive`, never `not-found`.
 *
 * `inconclusive` is the fail-closed member: the dispatcher holds on it forever rather than
 * guessing, which is why nothing may collapse into it that the chain actually answered.
 */
export type AsyncLiftChainProofResolution =
  /** The chain carries a publish, mapped to evidence this node can finalize with — the
   *  publisher-side image of the chain contract's `confirmed`. */
  | { status: 'recovered'; recovery: AsyncLiftPublisherRecoveryResult }
  /**
   * The observation variants whose meaning is identical on both surfaces are the CHAIN
   * contract's named sub-type, not a copy (r2 3879930, narrowed r7 3882283837): `reverted`,
   * `unrecognized`, and both pending shapes pass through resolvers verbatim.
   */
  | PublishTransactionObservation
  /**
   * PROOF-QUALIFIED absence, publisher-owned (r7 3882283837 — deliberately NOT inherited from
   * the chain contract's weaker `not-found`): the resolver may only answer this behind the
   * finality-snapshot absence rules (nonce consumed, token unminted at a canonical pinned
   * block), because the disposition table authorizes a CREATE resend on it. A chain adapter's
   * bare "I have neither receipt nor transaction" is NOT this and must be mapped deliberately.
   */
  | { status: 'not-found' }
  /** Publisher-only: nothing was established. Never absence, never proof. */
  | { status: 'inconclusive' };

/**
 * GH#2270 PR-3 — everything a chain-proof lookup needs, and nothing else.
 *
 * The resolver used to take the JOB, which forced the dispatcher to hand it a failed record cast
 * to `LiftJobBroadcast`. That cast was a lie for one real population: a job held on the recovery
 * carrier alone has no `broadcast` at all, and the production resolver dereferenced
 * `job.broadcast.walletId` straight through it, threw, and killed the whole recovery tick for
 * every job behind it. A resolver must not be handed a shape its caller cannot guarantee.
 *
 * The caller now derives these facts ONCE, from whichever carrier holds them, and a job whose hash
 * or wallet cannot be derived is never looked up at all — it stays held. Nothing here is cast to
 * something it is not.
 */
interface AsyncLiftChainProofLookupBase {
  /** The transaction to ask about, from either evidence carrier. */
  readonly txHash: LiftJobHex;
  /** The wallet that signed it — the account whose nonce proves consumption. */
  readonly walletId: string;
  /**
   * The nonce that transaction reserved, when the record carries one. Absent for records written
   * before the field existed and for inherited hashes; a resolver must then refuse to report a
   * proven absence, because without it a null lookup is not proof.
   */
  readonly nonce?: number;
  /**
   * GH#2270 PR-3 r2 — the knowledge asset id a re-run of this job would mint, as a decimal string,
   * when the job's request FIXES one.
   *
   * Nonce consumption proves the recorded transaction hash can never mine. It does NOT prove the
   * publish did not happen: a same-calldata replacement (a fee bump from outside this process, a
   * shared signer) consumes the same slot and performs the publish. This is what closes that —
   * asking whether the identity is already on chain, rather than asking about a hash.
   *
   * Present only when the request pins the id (the seal's `reservedKaId`). A job that would
   * allocate a FRESH id on re-run has no identity to check and therefore no safe release by
   * absence: the resolver holds it instead.
   */
  readonly publishIdentityKaId?: string;
}

/**
 * PR #2300 r1 (🟡 3809054838) — a lookup for a queued CREATE. What the queued transaction was
 * TRYING to do decides which proofs can ever settle the job, so the kind is the DISCRIMINANT of
 * the union rather than optional soup: update-only facts live on the update variant, and a
 * create lookup carrying an intended update root stops compiling instead of silently carrying a
 * fact no lane may read.
 */
export interface AsyncLiftCreateChainProofLookup extends AsyncLiftChainProofLookupBase {
  readonly operationKind: 'create';
  readonly intendedUpdateRoot?: undefined;
}

/**
 * A lookup for a queued UPDATE. A mined update carries `KnowledgeAssetUpdated`, which the publish
 * parser reports `unrecognized` — canonical recognition goes through the update-verification
 * machinery instead, bound to {@link intendedUpdateRoot}. The absence release is CREATE-ONLY: an
 * update has no monotone register to prove absence against ("the intended root is not current"
 * also describes our update landing and being superseded — the ABA hazard), so an update lookup
 * can never authorise a release by absence.
 */
export interface AsyncLiftUpdateChainProofLookup extends AsyncLiftChainProofLookupBase {
  readonly operationKind: 'update';
  /**
   * The assertion root the queued seal intended to install (the request's `sealMerkleRoot`).
   * Canonical update recognition requires the chain-verified new root to equal exactly this; an
   * update lookup without it can never be recognized and stays held.
   */
  readonly intendedUpdateRoot?: LiftJobHex;
}

/**
 * PR #2300 r3 — TWO variants, and no escape hatch. An earlier draft carried an 'unclassified'
 * member for callers that could not derive a kind; it immediately weakened the boundary it was
 * added to (it made resolver branches non-exhaustive and let the fact that governs absence-release
 * be omitted), and nothing constructed it: {@link queuedLiftOperationKind} always answers, from the
 * durable marker or from the safe default. A caller that genuinely cannot classify must DECLINE to
 * build a lookup — the job then stays held — rather than pass an undiscriminated one.
 */
export type AsyncLiftChainProofLookup =
  | AsyncLiftCreateChainProofLookup
  | AsyncLiftUpdateChainProofLookup;

/**
 * GH#2270 PR-3 r19 (🔴 3816490904) — the resolver receives the pass DEADLINE as an abort signal.
 * r18's time budget only gated whether the next lookup STARTED, which is not a ceiling at all: one
 * resolver that never settles keeps `recover()` — and the startup that awaits it — pending forever,
 * the exact condition the budget was introduced for.
 *
 * The parameter is optional so an existing resolver still type-checks, but a resolver that ignores
 * it is NOT bounded by its own doing; the publisher additionally stops WAITING at the deadline, so
 * the pass completes either way. Abandoning a call is strictly worse than cancelling one, which is
 * why the signal is passed rather than the promise merely detached — a resolver that honours it
 * releases its socket instead of leaking it for the length of the RPC timeout.
 *
 * Aborting establishes nothing, so the job's disposition is unchanged: it stays held and is asked
 * again on a later pass. A deadline can never authorize a resend.
 */
export type AsyncLiftPublisherRecoveryResolver = (
  lookup: AsyncLiftChainProofLookup,
  options?: { readonly signal?: AbortSignal },
) => Promise<AsyncLiftChainProofResolution>;

export type AsyncKnowledgeAssetVmPublishRecoveryResolver = (
  job: PersistedLiftJob,
  lookup: AsyncLiftChainProofLookup,
  /**
   * PR #2300 r2 — the dispatcher's verdict recovery, when this finalize follows one. For an
   * UPDATE whose verdict carried {@link CanonicalUpdateEvidence}, the resolver consumes it
   * directly instead of re-verifying the transaction; the LIVE interrupted lane passes nothing
   * (no verdict ran) and the resolver verifies once itself.
   */
  verdictRecovery?: AsyncLiftPublisherRecoveryResult,
  /**
   * GH#2270 PR #2300 r24 — the PASS DEADLINE. r23 bounded how long the dispatcher WAITS on this
   * resolver, which stops `recover()` hanging but leaves the resolver's own chain reads running
   * after the pass gave up. Handed through so a cooperating resolver cancels its reads instead of
   * leaking them once per timed-out pass. Aborting establishes nothing, so the job stays held.
   */
  options?: { readonly signal?: AbortSignal },
) => Promise<AsyncKnowledgeAssetVmPublishRecoveryEvidence | null>;

export interface AsyncLiftPublisherConfig {
  graphUri?: string;
  maxRetries?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
  /**
   * GH#2270 — operator kill-switch for the publisher's OWN retry lane (registry `autoRetry`
   * codes). OFF collapses the lane to pre-#2270 behaviour: nothing is scheduled and nothing
   * already scheduled is swept. Manual `retry()` and admission reaccept are unaffected.
   * Defaults to ON.
   */
  autoRetryEnabled?: boolean;
  /**
   * GH#2270 — symmetric multiplicative jitter ratio `r` for the retry backoff:
   * `delay · (1 + r·(2·rand()−1))`, so `r` is the fraction of the delay the jitter may add or
   * subtract. Must satisfy `0 ≤ r < 1` (at `r = 1` the delay can collapse to zero). Defaults
   * to 0.2.
   */
  retryJitterRatio?: number;
  recoveryLookupTimeoutMs?: number;
  now?: () => number;
  idGenerator?: () => string;
  /** Defaults to `crypto.randomUUID()`. Must return a fresh value for every wallet claim. */
  claimTokenGenerator?: () => string;
  /** Jitter source, injectable for determinism exactly like `now`/`idGenerator`. Defaults to Math.random. */
  rand?: () => number;
  /**
   * GH#2270 PR-3 — the chain-proof resolver. RENAMED from `chainRecoveryResolver` in r2 along
   * with its signature: it now takes an {@link AsyncLiftChainProofLookup} and answers a
   * VERDICT, where the old field took a job and answered `result | null`. A config still
   * carrying the old key is REJECTED at construction rather than ignored — see the constructor
   * guard. Both changes are silent at runtime in JavaScript, and a publisher that quietly lost
   * its resolver would hold every job forever with nothing to say why.
   */
  chainProofResolver?: AsyncLiftPublisherRecoveryResolver;
  /**
   * GH#2270 PR-3 r18 (🔴 3816322914) — the chain-proof sweep costs one RPC round trip per held
   * job, and `AsyncLiftRunner.start()` awaits `recover()`. Unbounded, an incident that leaves a
   * large held population behind slow endpoints turns startup into `held jobs x RPC timeout` and
   * re-pays it every cadence. A pass therefore resolves at most this many jobs, resuming where
   * the previous pass stopped so coverage stays round-robin rather than always re-asking the head
   * of the list.
   */
  chainProofDispatchBatchSize?: number;
  /**
   * The wall-clock ceiling for one chain-proof pass. The batch size bounds RPC COUNT; this bounds
   * TIME, which is what startup readiness actually depends on when each call is slow. A pass that
   * exhausts the budget stops and the remaining jobs are asked on the next cadence.
   */
  chainProofDispatchTimeBudgetMs?: number;
  /**
   * The owner LEASE on the serialized inventory-acquisition seam: how long one acquisition may
   * execute (measured from its execution start) before the next queued acquisition is promoted
   * past it. Acquisitions are FIFO-ordered; a queued burst therefore waits up to one lease per
   * predecessor ahead of it, and one hung store read degrades ordering, never availability.
   * Default 30s.
   */
  reconciliationAcquisitionLeaseMs?: number;
  /**
   * GH#2270 PR-3 r20 (🔴 3815617109) — can the chain-proof lane actually settle a job signed by
   * THIS wallet? A node may mix adapters, and the presence of a resolver is a node-wide fact while
   * the ability to answer is per adapter: with one capable wallet and one legacy wallet, a
   * node-wide boolean advertises an automatic exit for jobs that will never get one.
   *
   * Absent, every wallet is treated as capable — the single-adapter case, where the resolver's own
   * presence is the whole answer.
   */
  chainProofCapableForWallet?: (
    walletId: string,
    operationKind: 'create' | 'update' | undefined,
  ) => boolean;
  knowledgeAssetVmPublishRecoveryResolver?: AsyncKnowledgeAssetVmPublishRecoveryResolver;
  /**
   * Return a named-KA queue job as soon as the RPC has accepted its signed transaction, leaving
   * receipt/finality ownership to {@link TripleStoreAsyncLiftPublisher.reconcileTransactions}.
   *
   * This is deliberately opt-in. A direct library consumer without an independently scheduled
   * reconciliation lane must keep the historical `processNext()` contract and await the executor
   * result, otherwise an accepted transaction would remain parked in `broadcast` forever.
   * Production publisher runtimes enable this only when chain-proof recovery is configured.
   */
  detachReceiptReconciliation?: boolean;
  publishExecutor?: (input: AsyncLiftPublishExecutionInput) => Promise<PublishResult>;
  knowledgeAssetVmPublishHandler?: AsyncKnowledgeAssetVmPublishJobHandler;
  /** @deprecated Use knowledgeAssetVmPublishHandler.execute. */
  knowledgeAssetVmPublishExecutor?: (
    input: AsyncKnowledgeAssetVmPublishExecutionInput,
  ) => Promise<PublishResult>;
  /** @deprecated Use knowledgeAssetVmPublishHandler.preflight. */
  knowledgeAssetVmPublishPreflight?: (
    input: AsyncKnowledgeAssetVmPublishPreflightInput,
  ) => Promise<AsyncKnowledgeAssetVmPublishPreflightResult>;
  /** @deprecated Use knowledgeAssetVmPublishHandler.finalizeRecovered. */
  knowledgeAssetVmPublishRecoveryFinalizer?: (
    input: AsyncKnowledgeAssetVmPublishRecoveryInput,
  ) => Promise<void>;
  resolvedSliceOverrides?: Partial<LiftResolvedPublishSlice>;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  /**
   * #1829 — enable append-only admission/transaction journal writes. DAEMON-ONLY:
   * left OFF for the CLI inspector and standalone `dkg publisher run` so a second
   * OS process on the same store never races the node-local per-lineageKey seq
   * allocation. Reads never require this flag. Defaults to OFF.
   */
  journalWrites?: boolean;
}
