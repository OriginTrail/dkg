import type {
  AdmissionJournalEntry,
  KnowledgeAssetVmPublishRequest,
  LiftJob,
  LiftJobBroadcast,
  LiftJobFinalizationMetadata,
  LiftJobIncluded,
  LiftJobInclusionMetadata,
  LiftJobHex,
  LiftJobState,
  LiftJobValidationMetadata,
  LiftPublishRequestMetadata,
  LiftPublishSnapshotRequest,
} from './lift-job.js';
import type { LiftJobRetryProjection } from './async-lift-retry-disposition.js';
import type { DKGPublisher } from './dkg-publisher.js';
import type { PublishOptions, PublishResult } from './publisher.js';
import type { AsyncLiftPublishFailureInput } from './async-lift-publish-result.js';
import type { AsyncPreparedPublishPayload, LiftResolvedPublishSlice } from './async-lift-publish-options.js';
import type { WorkspacePublicSnapshotStore } from './workspace-snapshot-store.js';
import type { TerminalJobClearOutcome } from './terminal-job-clear.js';

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
  | { readonly kind: 'active'; readonly job: LiftJob; readonly superseded: LiftJob[]; readonly exactIntentMatch?: boolean }
  | { readonly kind: 'superseded'; readonly jobs: LiftJob[]; readonly exactIntentMatch?: boolean }
  | { readonly kind: 'conflict'; readonly jobs: LiftJob[] };

export interface AsyncLiftPublisher {
  enqueueKnowledgeAssetVmPublish(request: KnowledgeAssetVmPublishRequest): Promise<string>;
  claimNext(walletId: string): Promise<LiftJob | null>;
  update(jobId: string, status: LiftJobState, data?: Partial<LiftJob>): Promise<void>;
  getStatus(jobId: string): Promise<LiftJob | null>;
  list(filter?: { status?: LiftJobState }): Promise<LiftJob[]>;
  inspectPreparedPayload(jobId: string): Promise<AsyncPreparedPublishPayload | null>;
  processNext(walletId: string): Promise<LiftJob | null>;
  recordPublishResult(jobId: string, publishResult: PublishResult, options?: { publicByteSize?: number }): Promise<LiftJob>;
  recordPublishFailure(jobId: string, failure: AsyncLiftPublishFailureInput): Promise<LiftJob>;
  recover(): Promise<number>;
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

/**
 * GH#2270 — the reporting counterpart of `retry()`. Segregated off the base contract (like the
 * #1828/#1829/#1837 capabilities): the wire-stable count stays on `AsyncLiftPublisher`, and the
 * paths that report to an operator read the full disposition here.
 */
export interface AsyncLiftDetailedRetrier {
  retryDetailed(filter?: { status?: 'failed' }): Promise<AsyncLiftRetryOutcome>;
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
  describeConfiguredRetryState(job: LiftJob): LiftJobRetryProjection;
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
  clearTerminalJob(jobId: string): Promise<TerminalJobClearOutcome>;
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

export interface AsyncLiftPublisherRecoveryResult {
  inclusion: LiftJobInclusionMetadata;
  finalization: LiftJobFinalizationMetadata;
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
  readonly job: LiftJob;
  /**
   * GH#2270 PR-3 r3 — the transaction facts, typed, from whichever carrier the record has. The
   * consumer needs the queued tx hash to bind the resolved receipt to it, and a failed job held
   * on the recovery carrier alone has no `broadcast` to read it off.
   */
  readonly lookup: AsyncLiftChainProofLookup;
  readonly recovery: AsyncKnowledgeAssetVmPublishRecoveryEvidence;
  readonly publisher?: DKGPublisher;
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
  /** The chain carries a publish, mapped to evidence this node can finalize with. */
  | { status: 'recovered'; recovery: AsyncLiftPublisherRecoveryResult }
  /** Mined with a failure receipt: the transaction is accounted for and published nothing. */
  | { status: 'reverted' }
  /** Mined and successful, but carrying no publish the adapter recognizes. Not absence. */
  | { status: 'unrecognized' }
  /** The node holds the transaction and has not mined it. Never absence. */
  | { status: 'pending' }
  /** The node was asked for the TRANSACTION and does not have it: the only proven absence. */
  | { status: 'not-found' }
  /** Nothing was established. Never absence, never proof. */
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
 * A lookup whose operation kind could not be derived — hand-built legacy callers only; the
 * publisher's own builders ALWAYS stamp a kind ({@link queuedLiftOperationKind} errs toward
 * 'update', because a create misread as an update only narrows what can settle it). Explicit
 * variant rather than optional soup, so the unclassified population is visible at the type level:
 * it is treated as create-shaped for recognition and carries nothing update-only.
 */
export interface AsyncLiftUnclassifiedChainProofLookup extends AsyncLiftChainProofLookupBase {
  readonly operationKind?: undefined;
  readonly intendedUpdateRoot?: undefined;
}

export type AsyncLiftChainProofLookup =
  | AsyncLiftCreateChainProofLookup
  | AsyncLiftUpdateChainProofLookup
  | AsyncLiftUnclassifiedChainProofLookup;

export type AsyncLiftPublisherRecoveryResolver = (
  lookup: AsyncLiftChainProofLookup,
) => Promise<AsyncLiftChainProofResolution>;

export type AsyncKnowledgeAssetVmPublishRecoveryResolver = (
  job: LiftJob,
  lookup: AsyncLiftChainProofLookup,
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
  knowledgeAssetVmPublishRecoveryResolver?: AsyncKnowledgeAssetVmPublishRecoveryResolver;
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
