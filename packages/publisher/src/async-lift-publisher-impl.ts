import type { PreBroadcastRecord } from './publisher.js';
import { bestEffortNotify } from './best-effort-notify.js';
import { resolveWithinAbort } from './abort-boundary.js';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  LegacyKnowledgeAssetReadOnlyError,
  createGraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import type { PhaseCallback, PublishResult } from './publisher.js';
import { resolveEffectiveAsyncLiftRetryTuning } from './async-lift-retry-tuning.js';
import {
  LIFT_JOB_STATES,
  assertLiftJobTransition,
  createLiftJobFailureMetadata,
  type LiftJob,
  type LiftJobFailureCode,
  type LiftJobAccepted,
  type LiftJobClaimed,
  type LiftJobBroadcast,
  type LiftJobBroadcastMetadata,
  type LiftJobHex,
  type LiftJobIncluded,
  type LiftJobInclusionMetadata,
  type LiftJobFinalizationMetadata,
  type LiftJobRecoveryMetadata,
  type LiftJobRequest,
  type LiftJobState,
  type KnowledgeAssetVmPublishRequest,
  type LiftPublishRequestMetadata,
  type LiftPublishSnapshotRequest,
  type AdmissionJournalEntry,
  type JournalKind,
} from './lift-job.js';
import type {
  AsyncKnowledgeAssetVmPublishJobHandler,
  ActiveLiftJobClaim,
  ActiveLiftJobClaimSession,
  AsyncLiftAdministrativeMutations,
  AsyncKnowledgeAssetVmPublishRecoveryResolver,
  AsyncLiftDetailedRetrier,
  AsyncLiftPublisherConfig,
  AsyncLiftChainProofLookup,
  AsyncLiftChainProofResolution,
  AsyncLiftAdmissionContext,
  AsyncKnowledgeAssetVmPublishRecoveryEvidence,
  AsyncLiftPublisherRecoveryResolver,
  AsyncLiftPublisherRecoveryResult,
  AsyncLiftRetryOutcome,
  AsyncLiftRetryStateReader,
  IntentLookupInput,
  IntentLookupResult,
  JournalReadInput,
  JournalReadResult,
  VmPublishIntentRecoveryPublisher,
  VmPublishIntentIndexBackfiller,
  VmPublishAdmissionJournalReader,
  VmPublishTerminalJobClearer,
} from './async-lift-publisher-types.js';
import {
  AsyncLiftClaimCoordinator,
  type AsyncLiftClaimProcessingRelease,
  type LiftJobTransitionScope,
} from './async-lift-claim-session.js';
import {
  AsyncLiftJobConflictError,
  LiftJobPendingChainProofError,
  StaleLiftJobClaimError,
} from './async-lift-publisher-types.js';
import {
  FAILED_JOB_RETRY_ACTION_COUNT,
  classifyRetryAction,
  deriveLiftJobRetryProjection,
  isAutomaticallyRetryableLiftJob,
  isBulkClearableTerminalLiftJob,
  isClearableTerminalLiftJob,
  isTargetedClearableLiftJob,
  decideChainProofDisposition,
  hasAutomaticRecoveryExit,
  resolveHeldJobSettlementCapability,
  type HeldJobSettlementCapability,
  isHeldForChainProof,
  selectLifecycleBindingJobs,
  type LiftJobRetryProjection,
} from './async-lift-retry-disposition.js';
import { type TerminalJobClearOutcome } from './terminal-job-clear.js';
import { isSafeJobId } from './job-id.js';
import { replaceSubjectAtomicallyOrFallback } from './subject-atomic-write.js';
import {
  isDefinitivePreAcceptanceSendFailure,
  isPermanentAuthorCapabilityFailure,
  mapPublishExceptionToLiftJobFailure,
  mapPublishResultToLiftJobSuccess,
  type AsyncLiftPublishFailureInput,
} from './async-lift-publish-result.js';
import { prepareAsyncPublishPayload, type AsyncPreparedPublishPayload, type LiftResolvedPublishSlice } from './async-lift-publish-options.js';
import { validateLiftPublishPayload } from './async-lift-validation.js';
import { computePrivateRootV10 } from './merkle.js';
import { subtractFinalizedExactQuads } from './async-lift-subtraction.js';
import { isKnowledgeAssetWorkspaceHeadCorruptError, resolveLiftWorkspaceSlice } from './workspace-resolution.js';
import {
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  DEFAULT_GRAPH_URI,
  DEFAULT_JOURNAL_GRAPH_URI,
  JOURNAL_SEQ,
  JOURNAL_LIFECYCLE_KEY,
  JOURNAL_JOB_ID,
  PAYLOAD_PREDICATE,
  STATUS_PREDICATE,
  CONTROL_LIFECYCLE_KEY,
  knowledgeAssetVmPublishLifecycleKey,
  serializeJournalEntry,
  parseJournalEntry,
  serializeVmPublishIntentIndex,
  compareAcceptedJobs,
  createKnowledgeAssetVmPublishSnapshotMetadata,
  createKnowledgeAssetVmPublishSnapshotRequest,
  createKnowledgeAssetVmPublishJobRequest,
  createJobSlug,
  expectBindings,
  getLiftJobTransactionEvidence,
  isKnowledgeAssetVmPublishJobRequest,
  isFailedJob,
  liftJobCheckedNonce,
  liftJobCheckedSigner,
  liftJobOperationKindMarker,
  assertNoImmutableLiftJobFieldChange,
  normalizePersistedLiftJobRequest,
  buildLiftJobAcceptedReset,
  pinnedPublishIdentityKaId,
  queuedLiftOperationKind,
  resetFailedLiftJobToAccepted,
  rawLiftRequestFromJobRequest,
  jobSubject,
  literal,
  parseIntegerLiteral,
  parseLiteral,
  requestSubject,
  serializeJobRecord,
  type PersistedFailedJob,
} from './async-lift-publisher-utils.js';

/**
 * #1864 — outcome of the KA VM-publish pre-send write-ahead boundary
 * (`recordDurableBroadcastBeforeSend`), tracked by the broadcast recorder's closure and
 * read by the `processKnowledgeAssetVmPublish` catch to decide recovery vs terminal —
 * replacing the prior inference from a mutable `executorReturned` flag + a post-hoc
 * `getStatus` re-read. A transient control-flow value, deliberately kept out of the
 * persisted `LiftJobState` model.
 * - `'not-reached'`          the write-ahead hook never fired (no tx was signed or sent).
 * - `'recorded-durable'`     `'broadcast'` was fsync-durably recorded; the tx is being/was sent.
 * - `'rolled-back-pre-send'` the write-ahead was attempted but the fsync/transition failed
 *                            and was rolled back to `'validated'`; the tx was never sent.
 */
/**
 * GH#2270 PR-3 r18 (🔴 3816322914) — the chain-proof backoff schedule. Not configurable: these
 * govern how often a HELD job is re-asked, which is a protocol-pacing question rather than a
 * deployment one, and the two knobs that do vary by deployment (batch size, time budget) are on
 * the config. The ceiling matters as much as the growth — a job held across a long incident must
 * still be asked periodically, never deferred to effectively never.
 */
const CHAIN_PROOF_BACKOFF_BASE_MS = 30_000;
const CHAIN_PROOF_BACKOFF_MAX_MS = 10 * 60_000;
/** Jitter as a FRACTION of the computed backoff, so spread scales with the wait it spreads. */
const CHAIN_PROOF_BACKOFF_JITTER = 0.25;

type PreSendOutcome = 'not-reached' | 'recorded-durable' | 'rolled-back-pre-send';

type BusinessOperationResult<T> =
  | { readonly kind: 'succeeded'; readonly value: T }
  | { readonly kind: 'failed'; readonly error: unknown };

/** A publish result is business-invalid; persistence and ownership failures remain unwrapped. */
class InvalidLiftPublishResultError extends Error {
  override readonly name = 'InvalidLiftPublishResultError';
}

/** Corrupt durable state is distinct from an absent job so ownership always fails closed. */
class MalformedLiftJobPayloadError extends Error {
  override readonly name = 'MalformedLiftJobPayloadError';
}

/**
 * GH#2270 — why a failed job is being reaccepted, stated by the caller rather than inferred.
 *  - `retry` CONSUMES one attempt of the shared budget: the automatic sweep and the operator's
 *    `retry()` are both bounded by it, which is what stops a failing job looping forever.
 *  - `freshClientMandate` RE-ARMS it: a client re-submitting a byte-identical request is new
 *    authority to publish, and the alternative — minting a replacement job for a subject whose
 *    budget is spent — is the durability violation GH#2270 forbids.
 */
type ReacceptIntent = { readonly kind: 'retry' } | { readonly kind: 'freshClientMandate' };

/**
 * #1828 / GH#2270 — the lifecycle key a persisted job belongs to, or null when it has none: a
 * non-VM-publish request, or a malformed legacy one (a pre-guard admission whose name carries
 * U+001F). A malformed PERSISTED job must never abort a scan and block an unrelated admission,
 * so it simply drops out of every group.
 */
function lifecycleKeyOfJob(job: LiftJob): string | null {
  if (!isKnowledgeAssetVmPublishJobRequest(job.request)) return null;
  try {
    return knowledgeAssetVmPublishLifecycleKey(job.request.knowledgeAssetVmPublish);
  } catch {
    return null;
  }
}

/**
 * GH#2270 PR-3 r2 — a config carrying the pre-rename `chainRecoveryResolver` key is REJECTED, not
 * ignored.
 *
 * The repo does not ship backwards-compatibility shims, and this is not one: nothing accepts the
 * old key. But the rename is invisible to JavaScript, and BOTH halves changed — the field name and
 * the callback's signature — so a consumer that missed it would construct a publisher with no
 * resolver at all and lose chain recovery in total silence, or pass one that is handed a lookup
 * where it expects a job and throws mid-tick. An explicit failure at construction names the
 * replacement and the issue, and happens before any job can be held on a lane that will not run.
 */
function assertNoLegacyChainRecoveryResolver(config: AsyncLiftPublisherConfig): void {
  if (!Object.prototype.hasOwnProperty.call(config, 'chainRecoveryResolver')) return;
  throw new Error(
    'AsyncLiftPublisherConfig.chainRecoveryResolver was removed in GH#2270 PR-3: use '
    + '`chainProofResolver`, whose resolver takes an AsyncLiftChainProofLookup '
    + '({ txHash, walletId, nonce }) and returns an AsyncLiftChainProofResolution verdict '
    + '(recovered / reverted / unrecognized / pending / not-found / inconclusive) instead of '
    + 'taking a job and returning a recovery result or null.',
  );
}

// PR #2300 r1 — `pinnedPublishIdentityKaId` moved to async-lift-publisher-utils.ts: the
// retryability policy in the disposition module reads the same derivation now, and two copies of
// "which id would a re-run mint" is how they would drift.

/**
 * GH#2270 PR-3 r4 — finish a chain-proof lookup with the operation facts: what the queued
 * transaction was trying to DO, and (for an update) the root it intended to install. The kind
 * derivation is {@link queuedLiftOperationKind}; the intended root is the seal root the update
 * would have committed, read from the same immutable request. Both lookup builders finish here,
 * so the live lane and the failed-job dispatcher cannot describe the same job differently — and
 * (PR #2300 r1) the lookup is a discriminated union now, so each kind is CONSTRUCTED as its own
 * variant rather than spread into optional soup.
 */
/**
 * PR #2300 r4 (3811993677) — ONE identity for a lookup, derived from the lookup itself.
 *
 * The stale-verdict guard used to re-list the fields it cared about, and had already fallen behind
 * the discriminated model: two update lookups differing only in `intendedUpdateRoot` compared
 * EQUAL, so a verdict resolved for one could be applied to the other. Fingerprinting every field
 * the builder can produce means adding a field cannot silently bypass the guard — the same
 * field-dropping hazard this PR removed from the agent's option pipeline.
 */
export function chainProofLookupFingerprint(lookup: AsyncLiftChainProofLookup): string {
  // r5 (3812123515) — derived from the WHOLE lookup, not a list someone has to remember to grow.
  // Keys are sorted so the string is deterministic, and `undefined` is dropped so an absent field
  // and an explicitly-undefined one agree. A field added to the union is included the moment it is
  // populated, which is the property a hand-written list kept failing to provide.
  return JSON.stringify(
    Object.entries(lookup as unknown as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function finishChainProofLookup(
  job: LiftJob,
  base: {
    readonly txHash: LiftJobHex;
    readonly walletId: string;
    readonly nonce?: number;
    readonly publishIdentityKaId?: string;
  },
): AsyncLiftChainProofLookup {
  const operationKind = queuedLiftOperationKind(job);
  if (operationKind === 'create') return { ...base, operationKind };
  const root = (job.request as { knowledgeAssetVmPublish?: { sealMerkleRoot?: LiftJobHex } })
    .knowledgeAssetVmPublish?.sealMerkleRoot;
  return { ...base, operationKind, ...(root ? { intendedUpdateRoot: root } : {}) };
}

/**
 * GH#2270 PR-3 r3 — where a chain-proof recovery is finalizing FROM, stated rather than inferred.
 *
 * The two lanes carry the same two facts in different places. A live interrupted job has its
 * origin in `status` and its transaction in `broadcast`; a FAILED one has them in
 * `failure.failedFromState` and in whichever evidence carrier survived a reset. The finalize path
 * used to read them off the record, which only worked for the first shape — so the failed-job
 * dispatcher fabricated the first shape to hand over: a synthetic status, a rebuilt `broadcast`,
 * and a cast that asserted a record was something it was not.
 *
 * Deriving them at the call site instead lets every caller pass its record exactly as persisted.
 */
type ChainRecoveryOrigin = {
  readonly recoveredFromStatus: 'broadcast' | 'included';
  readonly txHash: LiftJobHex;
  readonly lookup: AsyncLiftChainProofLookup;
};

/**
 * The origin of a LIVE interrupted job: it is still in the state it is recovering from, and its
 * transaction is still on its broadcast metadata. The failed-job dispatcher derives the same two
 * facts from `failure.failedFromState` and the evidence carrier instead.
 */
function liveChainRecoveryOrigin(job: LiftJobBroadcast | LiftJobIncluded): ChainRecoveryOrigin {
  return {
    recoveredFromStatus: job.status,
    txHash: job.broadcast.txHash,
    lookup: finishChainProofLookup(job, {
      txHash: job.broadcast.txHash,
      walletId: job.broadcast.walletId,
      nonce: job.broadcast.nonce,
      publishIdentityKaId: pinnedPublishIdentityKaId(job),
    }),
  };
}

type AsyncLiftJobHandler = {
  readonly inspectPreparedPayload: (job: LiftJob) => Promise<AsyncPreparedPublishPayload | null>;
  readonly process: (session: ActiveLiftJobClaimSession) => Promise<LiftJob>;
  readonly recoverInterrupted: (
    job: LiftJob,
    scope: LiftJobTransitionScope,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<boolean>;
  readonly canRetryFailedRecovery: (job: PersistedFailedJob) => boolean;
  /**
   * GH#2270 — finalize a FAILED job the dispatcher has proven published, in this job type's own
   * vocabulary. Raw lift finalizes straight from the generic recovery evidence the verdict
   * carries; the named lane needs its canonical receipt and its lifecycle repair, so it reads its
   * own resolver. Returning `false` means "not finalized" — the caller leaves the job held rather
   * than inventing a disposition it has no proof for.
   */
  readonly finalizeProvenPublish: (
    job: PersistedFailedJob,
    scope: LiftJobTransitionScope,
    origin: ChainRecoveryOrigin,
    recovery: AsyncLiftPublisherRecoveryResult,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<boolean>;
  readonly shouldPromoteFinalizedPrivateStaging: (job: LiftJob) => boolean;
};

// #1829 — journal kind for a generic update()-driven transition (total over
// LiftJobState, never throws). 'accepted' is unreachable via update()
// (assertActiveClaimLock + all 'accepted' writes go through writeJob directly with
// explicit admission/reaccept/recover-reset kinds), but is mapped safely.
function statusToKind(status: LiftJobState): JournalKind {
  switch (status) {
    case 'accepted':
      return 'admission';
    case 'claimed':
      return 'claimed';
    case 'validated':
      return 'validated';
    case 'broadcast':
      return 'broadcast';
    case 'included':
      return 'included';
    case 'finalized':
      return 'finalized';
    case 'failed':
      return 'failed';
  }
}

function assertGraphScopedLiftSnapshot(request: LiftPublishSnapshotRequest): void {
  if (request.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    throw new LegacyKnowledgeAssetReadOnlyError();
  }
  if (request.roots.length !== 0) {
    throw new Error('Graph-scoped async publish must not contain root entities');
  }
  if (request.entityProofs === true) {
    throw new Error('Graph-scoped async publish does not support entityProofs');
  }
  if (
    request.kaUal === undefined
    || request.assertionVersion === undefined
    || request.publicTripleCount === undefined
    || request.privateTripleCount === undefined
  ) {
    throw new Error('Graph-scoped async publish requires a complete KA content envelope');
  }
  createGraphKnowledgeAssetScope(request.kaUal, request.assertionVersion);
  if (
    !Number.isSafeInteger(request.publicTripleCount)
    || request.publicTripleCount < 0
    || !Number.isSafeInteger(request.privateTripleCount)
    || request.privateTripleCount < 0
    || (request.publicTripleCount === 0 && request.privateTripleCount === 0)
  ) {
    throw new Error('Graph-scoped async publish has invalid public/private triple counts');
  }
  if (
    request.privateTripleCount > 0
    && !/^0x[0-9a-f]{64}$/i.test(request.privateMerkleRoot ?? '')
  ) {
    throw new Error('Graph-scoped async publish with private content requires one 32-byte privateMerkleRoot');
  }
  if (request.privateTripleCount === 0 && request.privateMerkleRoot !== undefined) {
    throw new Error('Graph-scoped async publish privateMerkleRoot requires private content');
  }
  const accessPolicy = request.accessPolicy
    ?? (request.privateTripleCount > 0 ? 'ownerOnly' : 'public');
  const allowedPeers = [...new Set(
    (request.allowedPeers ?? []).map((peerId) => peerId.trim()).filter(Boolean),
  )];
  if (accessPolicy === 'allowList' && allowedPeers.length === 0) {
    throw new Error('Graph-scoped async publish allowList policy requires allowedPeers');
  }
  if (accessPolicy !== 'allowList' && allowedPeers.length > 0) {
    throw new Error('Graph-scoped async publish allowedPeers requires allowList policy');
  }
}

function resolveKnowledgeAssetVmPublishHandler(
  config: AsyncLiftPublisherConfig,
): AsyncKnowledgeAssetVmPublishJobHandler | undefined {
  if (config.knowledgeAssetVmPublishHandler) {
    return config.knowledgeAssetVmPublishHandler;
  }
  if (!config.knowledgeAssetVmPublishExecutor) {
    return undefined;
  }
  return {
    execute: config.knowledgeAssetVmPublishExecutor,
    preflight: config.knowledgeAssetVmPublishPreflight,
    finalizeRecovered: config.knowledgeAssetVmPublishRecoveryFinalizer,
  };
}

export class TripleStoreAsyncLiftPublisher
  implements VmPublishIntentRecoveryPublisher, VmPublishIntentIndexBackfiller, VmPublishAdmissionJournalReader, VmPublishTerminalJobClearer, AsyncLiftDetailedRetrier, AsyncLiftRetryStateReader {
  // #1829 — dedicated per-lineageKey journal mutex, SEPARATE from the coordinator's claim
  // queue, so the read-modify-write seq allocation is atomic without touching the claim lock (lock
  // order is always claim→journal; appendJournal never calls writeJob → no reentrancy).
  private static readonly journalQueues = new Map<string, Promise<void>>();
  private static readonly DEFAULT_RECOVERY_LOOKUP_TIMEOUT_MS = 15 * 60 * 1000;
  private static readonly DEFAULT_MAX_RETRIES = 10;
  // Backoff/jitter defaults live in async-lift-retry-tuning.ts (the shared,
  // exported owner) so the daemon config boundary validates against the SAME
  // values this constructor applies.
  /**
   * GH#2270 — upper bound on reaccepts per claim-time sweep. The sweep runs INSIDE the claim
   * lock, so its cost is paid by every enqueue/claim/retry; and re-enabling `autoRetryEnabled`
   * releases every job that accumulated a past-due `nextRetryAt` at once. Capping the burst
   * loses no job: `nextRetryAt` stays in the past, so the remainder is reaccepted by the
   * following sweeps.
   */
  private static readonly MAX_REACCEPTS_PER_SWEEP = 5;

  private readonly graphUri: string;
  private readonly journalGraphUri: string;
  private readonly journalWrites: boolean;
  private readonly maxRetries: number;
  private readonly retryBackoffBaseMs: number;
  private readonly retryBackoffMaxMs: number;
  private readonly autoRetryEnabled: boolean;
  private readonly retryJitterRatio: number;
  private readonly recoveryLookupTimeoutMs: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly rand: () => number;
  private readonly chainProofResolver?: AsyncLiftPublisherRecoveryResolver;
  private readonly chainProofCapableForWallet?: (
    walletId: string,
    operationKind: 'create' | 'update' | undefined,
  ) => boolean;
  private readonly chainProofDispatchBatchSize: number;
  private readonly chainProofDispatchTimeBudgetMs: number;
  /**
   * r18 (🔴 3816322914) — when a held job's turn establishes nothing, asking again on the very
   * next tick spends another round trip for the same answer. This defers it, so a large held
   * population rotates through the batch instead of the head of the list monopolizing every pass.
   *
   * Deliberately IN-MEMORY, not persisted: a due time on disk would be a durable-shape change on
   * records already on running nodes, and it is not needed for the bound. A restart simply makes
   * everything due again, which is safe — asking the chain is idempotent — and still costs at most
   * one batch per pass. What must never happen is the inverse, and does not: skipping a job is a
   * pure no-op, so a DELAYED lookup can never itself authorize a resend.
   */
  private readonly chainProofNextDueAt = new Map<string, { dueAt: number; attempts: number }>();
  /**
   * r26 (🔴 3821028709) — jobs whose MUTATING recovery repair is currently running. A deadline
   * may stop the dispatcher waiting, but it must never let a second pass enter the same repair
   * while the first is still writing.
   */
  private readonly finalizationsInFlight = new Set<string>();
  /** Receipt tasks that continue after the RPC-acceptance fast return. */
  private readonly detachedExecutions = new Map<string, Promise<void>>();
  /**
   * GH#2359 item 2 — executor receipt SCHEDULING hints, by jobId. An entry records only that
   * the executor reported a confirmed receipt for `txHash`; it authorizes nothing. The early
   * release lane validates the hash against the job's PERSISTED write-ahead evidence and then
   * runs the reconciler's own canonical chain proof — only that proof releases the wallet.
   * After a successful early release the entry carries the proof, so the settle-time finalize
   * consumes it instead of re-paying the chain reads. Bounded FIFO; entries are dropped on
   * consumption, invalidation (hash mismatch / terminal disposition), or eviction.
   */
  private readonly executorProofHints = new Map<string, {
    readonly txHash: string;
    proof?: {
      readonly recovery: AsyncLiftPublisherRecoveryResult;
      readonly resolved: AsyncKnowledgeAssetVmPublishRecoveryEvidence;
    };
    /** r8 (3877817604) — contained transition/release failures for THIS hint, see the catch. */
    transitionFailures?: number;
  }>();
  private static readonly EXECUTOR_PROOF_HINT_CAP = 512;
  /** r8 (3877817604) — contained retries of the write/release window before escalating. */
  private static readonly EXECUTOR_HINT_TRANSITION_RETRY_LIMIT = 3;
  private executorHintPassOffset = 0;
  /** r15 (3878098525) — which lane leads the next pass; alternates so an overrun in one lane
   * cannot repeatedly consume the other lane's opportunity. Hints lead first for latency. */
  private hintLaneLeads = true;
  /** Poked when a tx-bearing job stops being executor-owned; see setReconciliationDemandListener. */
  /** The one atomically-attached scheduling owner; see attachScheduler. */
  private schedulerListener?: {
    onReconciliationDemand(): void;
    onWalletRelease(walletId: string): void;
  };
  /**
   * Rotates the live-lane iteration start across passes. The pass deadline may truncate the walk,
   * and `list()` order is stable, so without rotation the same head jobs would be re-asked every
   * pass while the tail starved behind a slow resolver. In-memory for the same reason as
   * `chainProofNextDueAt`: a restart resetting the rotation is safe, skipping is a pure no-op.
   */
  private reconcilePassOffset = 0;
  private readonly knowledgeAssetVmPublishRecoveryResolver?: AsyncKnowledgeAssetVmPublishRecoveryResolver;
  private readonly detachReceiptReconciliation: boolean;
  /** 3825614002 — this instance's ROLE, resolved once from its wiring. */
  private readonly heldJobSettlement: HeldJobSettlementCapability;
  private readonly publishExecutor?: AsyncLiftPublisherConfig['publishExecutor'];
  private readonly knowledgeAssetVmPublishHandler?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler'];
  private readonly resolvedSliceOverrides?: Partial<LiftResolvedPublishSlice>;
  private readonly publicSnapshotStore?: AsyncLiftPublisherConfig['publicSnapshotStore'];
  private readonly graphManager: GraphManager;
  private readonly claimCoordinator: AsyncLiftClaimCoordinator;
  private paused = false;
  private graphEnsured = false;

  private readonly rawLiftJobHandler: AsyncLiftJobHandler = {
    inspectPreparedPayload: (job) => this.inspectRawLiftPreparedPayload(job),
    process: (session) => this.processRawLift(session),
    recoverInterrupted: (job, scope, options) => this.recoverRawLiftInterrupted(job, scope, options),
    // GH#2270 PR-3 r1 — the same held predicate the named lane uses. It SUPERSETS the legacy
    // `retry_recovery` + live-broadcast gate: every job that gate admitted persists a txHash and
    // is therefore held, while the gate missed jobs that equally have a transaction unaccounted
    // for — a post-write-ahead `tx_submit_timeout`, or anything held on the recovery carrier
    // alone. One definition of "this job's transaction is unaccounted for" across both lanes, so
    // raw lift and named KA cannot answer differently about the same evidence.
    canRetryFailedRecovery: (job) =>
      rawLiftRequestFromJobRequest(job.request) !== null && isHeldForChainProof(job),
    finalizeProvenPublish: async (job, scope, origin, recovery) =>
      await scope.commitProofFinalization(async () => {
        const finalized = this.finalizeRecoveredJob(
          job,
          origin,
          recovery.inclusion,
          recovery.finalization,
        );
        await this.promoteFinalizedPrivateStaging(finalized);
        return finalized;
      }) !== null,
    shouldPromoteFinalizedPrivateStaging: () => true,
  };

  private readonly knowledgeAssetVmPublishJobHandler: AsyncLiftJobHandler = {
    inspectPreparedPayload: async () => null,
    process: (session) => this.processKnowledgeAssetVmPublish(session),
    recoverInterrupted: (job, scope, options) =>
      this.recoverKnowledgeAssetVmPublishInterrupted(job, scope, options),
    // GH#2270 — the named lane used to answer `false` here, which is what made a held KA VM job
    // unresolvable without an operator: nothing ever re-asked the chain about it. PR-2's held
    // population IS this lane's work queue, so the eligibility test is exactly that predicate —
    // one definition of "this job's transaction is unaccounted for", shared with admission, the
    // reaccept writer, the retry projection and bulk clear, rather than a second rule that could
    // disagree with them.
    canRetryFailedRecovery: (job) => isHeldForChainProof(job),
    finalizeProvenPublish: async (job, scope, origin, recovery, options) =>
      await this.finalizeProvenKnowledgeAssetVmPublish(
        job,
        scope,
        origin,
        recovery,
        options,
      ) === 'finalized',
    shouldPromoteFinalizedPrivateStaging: () => false,
  };

  constructor(
    private readonly store: TripleStore,
    config: AsyncLiftPublisherConfig = {},
  ) {
    this.graphUri = config.graphUri ?? DEFAULT_GRAPH_URI;
    this.journalGraphUri = DEFAULT_JOURNAL_GRAPH_URI;
    this.journalWrites = config.journalWrites ?? false;
    this.maxRetries = config.maxRetries ?? TripleStoreAsyncLiftPublisher.DEFAULT_MAX_RETRIES;
    // ONE validation owner for the retry knobs (shared with the daemon config
    // boundary): ranges, the boolean kill-switch type, and the cross-field
    // backoff invariant checked against the EFFECTIVE (explicit-or-default)
    // pair. A non-boolean autoRetryEnabled (e.g. the string "false") throws
    // here instead of silently enabling the lane.
    const retryTuning = resolveEffectiveAsyncLiftRetryTuning(config, 'Async lift publisher');
    this.retryBackoffBaseMs = retryTuning.retryBackoffBaseMs;
    this.retryBackoffMaxMs = retryTuning.retryBackoffMaxMs;
    this.autoRetryEnabled = retryTuning.autoRetryEnabled;
    this.retryJitterRatio = retryTuning.retryJitterRatio;
    this.recoveryLookupTimeoutMs = config.recoveryLookupTimeoutMs ?? TripleStoreAsyncLiftPublisher.DEFAULT_RECOVERY_LOOKUP_TIMEOUT_MS;
    this.now = config.now ?? (() => Date.now());
    this.idGenerator = config.idGenerator ?? (() => crypto.randomUUID());
    this.rand = config.rand ?? (() => Math.random());
    assertNoLegacyChainRecoveryResolver(config);
    this.chainProofResolver = config.chainProofResolver;
    this.chainProofCapableForWallet = config.chainProofCapableForWallet;
    this.chainProofDispatchBatchSize = config.chainProofDispatchBatchSize ?? 25;
    this.chainProofDispatchTimeBudgetMs = config.chainProofDispatchTimeBudgetMs ?? 15_000;
    this.knowledgeAssetVmPublishRecoveryResolver = config.knowledgeAssetVmPublishRecoveryResolver;
    this.detachReceiptReconciliation = config.detachReceiptReconciliation ?? false;
    this.publishExecutor = config.publishExecutor;
    this.knowledgeAssetVmPublishHandler = resolveKnowledgeAssetVmPublishHandler(config);
    this.resolvedSliceOverrides = config.resolvedSliceOverrides;
    this.publicSnapshotStore = config.publicSnapshotStore;
    this.heldJobSettlement = resolveHeldJobSettlementCapability({
      hasChainProofResolver: config.chainProofResolver !== undefined,
      ...(config.chainProofCapableForWallet
        ? { capableForWallet: config.chainProofCapableForWallet }
        : {}),
      hasNamedRecoveryResolver: config.knowledgeAssetVmPublishRecoveryResolver !== undefined,
    });
    this.graphManager = new GraphManager(store);
    this.claimCoordinator = new AsyncLiftClaimCoordinator(
      store,
      {
        graphUri: this.graphUri,
        walletLockGraphUri: DEFAULT_WALLET_LOCK_GRAPH_URI,
        now: this.now,
        claimTokenGenerator: config.claimTokenGenerator ?? (() => crypto.randomUUID()),
      },
      {
        ensureGraph: async () => await this.ensureGraph(),
        isPaused: () => this.paused,
        getStatus: async (jobId) => await this.getStatus(jobId),
        listAccepted: async () =>
          (await this.list({ status: 'accepted' })).filter(
            (job): job is LiftJobAccepted => job.status === 'accepted',
          ),
        reacceptDueFailedJobs: async (now) => await this.reacceptDueFailedJobs(now),
        toClaimed: (current, walletId) =>
          this.mergeJob(current, 'claimed', { claim: { walletId } }),
        writeJob: async (job, kind) => await this.writeJob(job, kind),
        deleteJob: async (jobId) => await this.deleteJob(jobId),
        assertJobMatchesStatus: (job) => this.assertJobMatchesStatus(job),
        resetInterruptedClaim: (job) => {
          if (job.status !== 'claimed' && job.status !== 'validated') {
            throw new Error(`Cannot reset non-pre-broadcast claim ${job.jobId} from ${job.status}`);
          }
          return this.resetJobToAccepted(
            job,
            job.status,
            getLiftJobTransactionEvidence(job),
          );
        },
        notifyWalletRelease: (walletId) => this.notifyWalletRelease(walletId),
        mutations: {
          update: async (current, scope, status, data = {}) =>
            await this.applyClaimUpdateTransition(current, scope, status, data),
          recordPublishResult: async (current, scope, publishResult, options = {}) =>
            await this.applyPublishResultTransition(current, scope, publishResult, options),
          recordExecutionFailure: async (current, scope, failedFromState, error) =>
            await this.applyExecutionFailureTransition(current, scope, failedFromState, error),
        },
      },
    );
  }

  async enqueueKnowledgeAssetVmPublish(
    request: KnowledgeAssetVmPublishRequest,
    admission?: AsyncLiftAdmissionContext,
  ): Promise<string> {
    return this.claimCoordinator.runClaimTransaction(async () => {
      await this.ensureGraph();
      if (!request.shareOperationId.trim()) {
        throw new Error('Knowledge asset VM publish requires a shareOperationId');
      }
      assertGraphScopedLiftSnapshot(request);
      const existing = await this.findActiveKnowledgeAssetVmPublishJob(request);
      if (existing?.compatible) {
        if (isFailedJob(existing.job)) {
          const reaccepted = await this.reacceptRetryableFailedKnowledgeAssetVmPublishJob(existing.job);
          return reaccepted.jobId;
        }
        return existing.job.jobId;
      }
      if (existing?.job) {
        throw new AsyncLiftJobConflictError(
          `Knowledge asset VM publish is already queued for "${request.name}" in context graph "${request.contextGraphId}" with a different share intent`,
          existing.job.jobId,
        );
      }
      const jobRequest = createKnowledgeAssetVmPublishJobRequest(request);
      const now = this.now();
      const jobId = this.idGenerator();
      const job: LiftJobAccepted = {
        jobId,
        jobSlug: createJobSlug(jobRequest),
        request: jobRequest,
        ...(admission ? { admission: { byAgentAddress: admission.admittedByAgentAddress } } : {}),
        status: 'accepted',
        timestamps: { acceptedAt: now, updatedAt: now },
        retries: { retryCount: 0, maxRetries: this.maxRetries },
        controlPlane: { jobRef: jobSubject(jobId) },
      };
      await this.writeJob(job, 'admission');
      return jobId;
    });
  }


  async claimNext(walletId: string): Promise<ActiveLiftJobClaim | null> {
    return await this.claimCoordinator.claimNext(walletId);
  }

  readonly administrative: AsyncLiftAdministrativeMutations = {
    updateById: async (jobId, status, data = {}) => {
      await this.transitionJob(jobId, status, data);
    },
    recordPublishResultById: async (jobId, publishResult, options = {}) =>
      await this.recordPublishResultById(jobId, publishResult, options),
    recordPublishFailureById: async (jobId, failure) =>
      await this.recordPublishFailureById(jobId, failure),
  };

  openClaimSession(claim: ActiveLiftJobClaim): ActiveLiftJobClaimSession {
    return this.claimCoordinator.openSession(claim);
  }

  async update(jobId: string, status: LiftJobState, data: Partial<LiftJob> = {}): Promise<void> {
    await this.administrative.updateById(jobId, status, data);
  }

  private async applyClaimUpdateTransition(
    current: LiftJob,
    scope: LiftJobTransitionScope,
    status: LiftJobState,
    data: Partial<LiftJob> = {},
  ): Promise<void> {
    const next = this.mergeJob(current, status, data);
    this.assertJobMatchesStatus(next);
    if (next.status === 'finalized') {
      await this.promoteFinalizedPrivateStaging(next);
    }
    await scope.commit(next, statusToKind(next.status));
  }

  private async transitionJob(
    jobId: string,
    status: LiftJobState,
    data: Partial<LiftJob>,
  ): Promise<void> {
    await this.ensureGraph();
    await this.claimCoordinator.transitionAdministrative(jobId, async (current, scope) => {
      const next = this.mergeJob(current, status, data);
      this.assertJobMatchesStatus(next);
      if (next.status === 'finalized') {
        await this.promoteFinalizedPrivateStaging(next);
      }
      await scope.commit(next, statusToKind(next.status));
    });
  }

  async getStatus(jobId: string): Promise<LiftJob | null> {
    await this.ensureGraph();
    const result = await this.store.query(
      `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { <${jobSubject(jobId)}> <${PAYLOAD_PREDICATE}> ?payload } }`,
      { source: 'publisher.asyncLift.getStatus' },
    );
    const rows = expectBindings(result);
    if (rows.length === 0) return null;
    return this.parseJobPayload(rows[0]?.['payload']);
  }

  async lookupKnowledgeAssetVmPublishJobByIntent(facts: IntentLookupInput): Promise<IntentLookupResult> {
    await this.ensureGraph();
    const key = knowledgeAssetVmPublishLifecycleKey(facts);
    // Object-bound triple pattern (not a FILTER) so the store resolves it via the
    // index instead of scanning every job. Read-only: no lock, no write, no reaccept.
    //
    // #1863 — writeJob now persists the job subject via the atomic
    // tryReplaceSubjectAtomically capability (one commit boundary), so a lookup
    // racing a state transition sees the subject fully prior-or-fully-next and
    // this index row never transiently disappears: no false `none`. On a store
    // that cannot guarantee one commit boundary (no replaceSubject, or a
    // non-transactional endpoint that refuses it) writeJob falls back to
    // delete-then-insert, which retains the bounded pre-#1863 window; there
    // admission's claim-locked findActive remains the authoritative dedup guard,
    // so a transient false `none` cannot by itself create a duplicate active job.
    const result = await this.store.query(
      `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { ?job <${CONTROL_LIFECYCLE_KEY}> ${literal(key)} ; <${PAYLOAD_PREDICATE}> ?payload } }`,
      { source: 'publisher.asyncLift.lookupVmPublishIntent' },
    );
    const jobs = expectBindings(result)
      .map((row) => this.parseJobPayload(row['payload']))
      .filter((job): job is LiftJob => job !== null);
    if (jobs.length === 0) return { kind: 'none' };
    // Partition via the SHARED selector that admission dedup
    // (findActiveKnowledgeAssetVmPublishJob) also uses, so the two partitions are identical by
    // construction: a binding job is the live one for the subject; everything else is superseded.
    // GH#2270 — the selector is sibling-aware, so a failed job that a NEWER record for this key
    // has moved past reports as superseded here instead of shadowing that newer record.
    const active = selectLifecycleBindingJobs(jobs, lifecycleKeyOfJob).get(key) ?? [];
    const superseded = jobs.filter((job) => !active.includes(job));
    const intentKeyOf = (job: LiftJob): string | undefined =>
      isKnowledgeAssetVmPublishJobRequest(job.request)
        ? job.request.knowledgeAssetVmPublish.intentKey
        : undefined;
    const exact = (candidates: LiftJob[]): { exactIntentMatch?: boolean } =>
      facts.intentKey === undefined
        ? {}
        : { exactIntentMatch: candidates.some((job) => intentKeyOf(job) === facts.intentKey) };
    if (active.length > 1) return { kind: 'conflict', jobs: active };
    if (active.length === 1) {
      return { kind: 'active', job: active[0]!, superseded, ...exact(active) };
    }
    return { kind: 'superseded', jobs: superseded, ...exact(superseded) };
  }

  /**
   * #1828 — idempotently backfill the ephemeral lifecycle index for VM-publish
   * jobs admitted before the index existed. Reads the subjects already carrying
   * the index and inserts ONLY the missing ones (additive insert; never
   * deletes/rewrites, so it cannot race the runner), returning the real number
   * of jobs repaired rather than a full-reindex count. Run once at boot.
   */
  async ensureVmPublishIntentIndex(): Promise<number> {
    await this.ensureGraph();
    const vmPublishJobs = (await this.list()).filter((job) =>
      isKnowledgeAssetVmPublishJobRequest(job.request),
    );
    if (vmPublishJobs.length === 0) return 0;
    // Subjects that already carry the lifecycle index. Object-unbound read of the
    // one predicate — no job-payload scan — so we diff in JS and insert only the
    // jobs missing it (VM-publish filtered above, never via a SPARQL MINUS, which
    // would over-select raw-lift jobs).
    const indexed = await this.store.query(
      `SELECT ?job WHERE { GRAPH <${this.graphUri}> { ?job <${CONTROL_LIFECYCLE_KEY}> ?lifecycleKey } }`,
      { source: 'publisher.asyncLift.ensureVmPublishIntentIndex' },
    );
    const alreadyIndexed = new Set(
      expectBindings(indexed)
        .map((row) => row['job'])
        .filter((subject): subject is string => typeof subject === 'string'),
    );
    const missing = vmPublishJobs.filter((job) => !alreadyIndexed.has(jobSubject(job.jobId)));
    const quads = missing.flatMap((job) => serializeVmPublishIntentIndex(job, this.graphUri));
    if (quads.length > 0) await this.store.insert(quads);
    return missing.length;
  }

  async list(filter: { status?: LiftJobState } = {}): Promise<LiftJob[]> {
    await this.ensureGraph();
    const statusFilter = filter.status ? `FILTER (?status = ${literal(filter.status)})` : '';
    const result = await this.store.query(
      `SELECT ?payload ?status WHERE { GRAPH <${this.graphUri}> { ?job <${STATUS_PREDICATE}> ?status ; <${PAYLOAD_PREDICATE}> ?payload . ${statusFilter} } }`,
      { source: 'publisher.asyncLift.list' },
    );
    return expectBindings(result)
      .map((row) => this.parseJobPayload(row['payload']))
      .filter((job): job is LiftJob => job !== null)
      .sort(compareAcceptedJobs);
  }

  async inspectPreparedPayload(jobId: string): Promise<AsyncPreparedPublishPayload | null> {
    await this.ensureGraph();
    const job = await this.getStatus(jobId);
    if (!job) {
      return null;
    }
    return this.jobHandlerFor(job.request).inspectPreparedPayload(job);
  }

  private async inspectRawLiftPreparedPayload(job: LiftJob): Promise<AsyncPreparedPublishPayload | null> {
    const request = rawLiftRequestFromJobRequest(job.request);
    if (!request) {
      throw new Error(`LiftJob ${job.jobId} is not a raw lift job`);
    }
    const resolved = await resolveLiftWorkspaceSlice({
      store: this.store,
      graphManager: this.graphManager,
      request,
      publicSnapshotStore: this.publicSnapshotStore,
    });
    const validated = validateLiftPublishPayload({
      request,
      resolved: {
        ...resolved,
        ...this.resolvedSliceOverrides,
      },
    });
    const subtracted = await subtractFinalizedExactQuads({
      store: this.store,
      graphManager: this.graphManager,
      request,
      validation: validated.validation,
      resolved: validated.resolved,
    });

    return {
      ...prepareAsyncPublishPayload({
        request,
        validation: validated.validation,
        resolved: subtracted.resolved,
      }),
      subtraction: {
        alreadyPublishedPublicCount: subtracted.alreadyPublishedPublicCount,
        alreadyPublishedPrivateCount: subtracted.alreadyPublishedPrivateCount,
      },
    };
  }

  async processNext(walletId: string): Promise<LiftJob | null> {
    const outcome = await this.claimCoordinator.processClaim(
      walletId,
      async (session) => await this.jobHandlerFor(session.claim.request).process(session),
      (release) => this.onClaimProcessingReleased(release),
    );
    return outcome.kind === 'idle' ? null : outcome.job;
  }

  private onClaimProcessingReleased(release: AsyncLiftClaimProcessingRelease): void {
    // The coordinator invokes this only AFTER deleting its processing marker. An invited pass can
    // therefore act immediately. Fault/stale paths poke unconditionally because their durable
    // state may be unreadable; the reconciliation pass remains the canonical judge.
    if (release.kind === 'faulted' || release.kind === 'stale') {
      this.notifyReconciliationDemand();
      return;
    }
    if (this.isReconciliationActionable(release.job)) {
      this.notifyReconciliationDemand();
    }
  }

  /**
   * Catch only failures raised by a business/executor operation. A claim fence failure is not a
   * publish failure: it is the one ownership-control signal handled by processNext(). Keeping that
   * distinction here removes stale-claim branches from every individual operation catch.
   */
  private async runBusinessOperation<T>(operation: () => T | Promise<T>): Promise<BusinessOperationResult<T>> {
    try {
      return { kind: 'succeeded', value: await operation() };
    } catch (error) {
      if (error instanceof StaleLiftJobClaimError) throw error;
      return { kind: 'failed', error };
    }
  }

  private async processRawLift(session: ActiveLiftJobClaimSession): Promise<LiftJob> {
    const claim = session.claim;
    const claimed = claim;
    const walletId = claim.claim.walletId;
    const validationAttempt = await this.runBusinessOperation(async () => {
      if (!this.publishExecutor) {
        throw new Error('Async lift publisher processNext requires a configured publishExecutor');
      }
      const request = rawLiftRequestFromJobRequest(claimed.request);
      if (!request) {
        throw new Error(`LiftJob ${claimed.jobId} is not a raw lift job`);
      }
      const resolved = await resolveLiftWorkspaceSlice({
        store: this.store,
        graphManager: this.graphManager,
        request,
        publicSnapshotStore: this.publicSnapshotStore,
      });
      const validated = validateLiftPublishPayload({
        request,
        resolved: {
          ...resolved,
          ...this.resolvedSliceOverrides,
        },
      });
      return { request, validated };
    });
    if (validationAttempt.kind === 'failed') {
      return await session.recordExecutionFailure('claimed', validationAttempt.error);
    }

    const { request, validated } = validationAttempt.value;
    await session.update('validated', { validation: validated.validation });

    const preparationAttempt = await this.runBusinessOperation(async () => {
      const subtracted = await subtractFinalizedExactQuads({
        store: this.store,
        graphManager: this.graphManager,
        request,
        validation: validated.validation,
        resolved: validated.resolved,
      });

      if (subtracted.resolved.quads.length === 0 && (subtracted.resolved.privateQuads?.length ?? 0) === 0) {
        return null;
      }

      return prepareAsyncPublishPayload({
        request,
        validation: validated.validation,
        resolved: subtracted.resolved,
      });
    });
    if (preparationAttempt.kind === 'failed') {
      return await session.recordExecutionFailure('validated', preparationAttempt.error);
    }
    const prepared = preparationAttempt.value;
    if (!prepared) return await this.finalizeNoopPublish(claim);

    const publicByteSize = this.computePublicByteSize(prepared.publishOptions.quads);
    // GH#2270 — the same pre-send write-ahead KA VM publish has taken since #1864. The
    // executor's typed pre-send hook records the signed hash durably before it goes on the wire.
    const broadcastRecorder = this.createPreSendBroadcastRecorder({ claim, publicByteSize });
    const publishAttempt = await this.runBusinessOperation(() => this.publishExecutor!({
      walletId,
      publishOptions: {
        ...prepared.publishOptions,
        onBeforeBroadcast: broadcastRecorder.onBeforeBroadcast,
      },
    }));
    if (publishAttempt.kind === 'failed') {
      return await session.recordExecutionFailure('broadcast', publishAttempt.error);
    }
    return await this.recordWorkerPublishResult(session, publishAttempt.value, { publicByteSize });
  }

  private async processKnowledgeAssetVmPublish(session: ActiveLiftJobClaimSession): Promise<LiftJob> {
    const claim = session.claim;
    const claimed = claim;
    const walletId = claim.claim.walletId;
    const handler = this.knowledgeAssetVmPublishHandler;
    if (!handler) {
      throw new Error('Async knowledge asset VM publish requires a configured knowledgeAssetVmPublishHandler');
    }
    if (!isKnowledgeAssetVmPublishJobRequest(claimed.request)) {
      throw new Error(`LiftJob ${claimed.jobId} is not a knowledge asset VM publish job`);
    }
    const request = claimed.request.knowledgeAssetVmPublish;
    const snapshot = createKnowledgeAssetVmPublishSnapshotRequest(request);
    const snapshotMetadata = createKnowledgeAssetVmPublishSnapshotMetadata(request);
    const preflightInput = { walletId, request, snapshot, snapshotMetadata };

    const initialPreflight = await this.runBusinessOperation(() => handler.preflight?.(preflightInput));
    if (initialPreflight.kind === 'failed') {
      return await session.recordExecutionFailure('claimed', initialPreflight.error);
    }
    if (initialPreflight.value?.action === 'noop') {
      return await this.finalizeKnowledgeAssetVmPublishNoop(claim, snapshot, snapshotMetadata);
    }

    const validationAttempt = await this.runBusinessOperation(async () => {
      const resolved = await resolveLiftWorkspaceSlice({
        store: this.store,
        graphManager: this.graphManager,
        request: snapshot,
        publicSnapshotStore: this.publicSnapshotStore,
      });
      return validateLiftPublishPayload({
        request: snapshot,
        metadata: snapshotMetadata,
        resolved: {
          ...resolved,
          ...this.resolvedSliceOverrides,
        },
      });
    });
    if (validationAttempt.kind === 'failed') {
      return await session.recordExecutionFailure('claimed', validationAttempt.error);
    }
    const validated = validationAttempt.value;
    await session.update('validated', { validation: validated.validation });

    const preparationAttempt = await this.runBusinessOperation(() =>
      prepareAsyncPublishPayload({
        request: snapshot,
        metadata: snapshotMetadata,
        validation: validated.validation,
        resolved: validated.resolved,
      }));
    if (preparationAttempt.kind === 'failed') {
      return await session.recordExecutionFailure('claimed', preparationAttempt.error);
    }
    const prepared = preparationAttempt.value;

    const publicByteSize = this.computePublicByteSize(prepared.publishOptions.quads);
    const broadcastRecorder = this.createPreSendBroadcastRecorder({
      claim,
      merkleRoot: request.sealMerkleRoot,
      publicByteSize,
    });
    const finalPreflight = await this.runBusinessOperation(() => handler.preflight?.(preflightInput));
    if (finalPreflight.kind === 'failed') {
      return await this.failKnowledgeAssetVmPublishExecution(session, finalPreflight.error);
    }
    if (finalPreflight.value?.action === 'noop') {
      return await this.finalizeKnowledgeAssetVmPublishNoop(claim, snapshot, snapshotMetadata);
    }

    const executionAttempt = await this.runBusinessOperation(async () => {
      let signalBroadcastAccepted!: (record: PreBroadcastRecord) => void;
      const broadcastAccepted = new Promise<PreBroadcastRecord>((resolve) => {
        signalBroadcastAccepted = resolve;
      });
      const inheritedBroadcastAccepted = prepared.publishOptions.onBroadcastAccepted;
      const inheritedPublishConfirmed = prepared.publishOptions.onPublishConfirmed;
      // Detachment eligibility is knowable BEFORE execution (wallet + queued operation kind),
      // and the internal receipt hint only means anything to detached-receipt reconciliation:
      // gating the recording here keeps non-detachable publishes from accreting dead hint
      // entries that could evict a still-useful proof (r1 3877430478).
      const canDetachReceiptReconciliation = this.detachReceiptReconciliation
        && this.chainProofResolver !== undefined
        && this.knowledgeAssetVmPublishRecoveryResolver !== undefined
        && (this.chainProofCapableForWallet?.(
          walletId,
          queuedLiftOperationKind(claimed),
        ) ?? true);
      // r9 (3877850638) — early release additionally requires a lifecycle finalizer: without
      // finalizeRecovered the settle path answers 'unsupported' and expects the wallet lock it
      // would otherwise synchronize, so a hint-driven release would strand an internally
      // inconsistent held job. Detachment itself is NOT gated on this (existing behavior).
      const canReleaseOnReceiptHint = canDetachReceiptReconciliation
        && handler.finalizeRecovered !== undefined;
      const executionInput = {
        walletId,
        request,
        snapshot,
        snapshotMetadata,
        validation: validated.validation,
        resolved: validated.resolved,
        publishOptions: {
          ...prepared.publishOptions,
          onBeforeBroadcast: broadcastRecorder.onBeforeBroadcast,
          // The endpoint has accepted the exact signed transaction recorded
          // above. Persist that fact before receipt polling is detached. The
          // wallet lock deliberately remains owned by this tx-bearing job:
          // only chain proof may release it for another nonce.
          onBroadcastAccepted: async (record: PreBroadcastRecord) => {
            await this.recordRpcAccepted(claim, record);
            try {
              await inheritedBroadcastAccepted?.(record);
            } finally {
              signalBroadcastAccepted(record);
            }
          },
          // GH#2359 item 2 — the executor's receipt-confirmed scheduling hint: recorded and
          // poked so a demanded pass can prove the transaction with the reconciler's OWN chain
          // reads while the executor finishes its local post-receipt tail. Never trusted as
          // evidence.
          onPublishConfirmed: (confirmation: { txHash: string }) => {
            if (canReleaseOnReceiptHint) {
              this.recordExecutorProofHint(claimed.jobId, confirmation);
            }
            // Scheduling-only: an inherited listener failure — synchronous or an async
            // rejection — must not touch the execution (r1 3877430465, r2 3877540214).
            bestEffortNotify(inheritedPublishConfirmed, confirmation);
          },
        },
      };
      const execution = handler.execute(executionInput);
      const outcome = await Promise.race([
        execution.then((result) => ({ kind: 'settled' as const, result })),
        broadcastAccepted.then(() => ({ kind: 'accepted' as const })),
      ]);
      if (outcome.kind === 'accepted' && canDetachReceiptReconciliation) {
        // Receipt success, revert, timeout, or temporary lookup failure is now
        // owned solely by chain-proof recovery. The execution continues so the
        // normal publisher can finish any local post-receipt work, but its
        // return value is intentionally not allowed to rewrite queue truth in
        // parallel with recovery.
        this.trackDetachedExecution(claimed.jobId, execution);
        return { kind: 'detached' as const, job: await this.getRequiredJob(claimed.jobId) };
      }
      const publishResult = outcome.kind === 'settled' ? outcome.result : await execution;
      // Inline completion: the normal result path owns this record from here, so a recorded
      // receipt hint has no consumer left (the early lane requires a DETACHED execution).
      this.executorProofHints.delete(claimed.jobId);
      return { kind: 'published' as const, publishResult };
    });
    if (executionAttempt.kind === 'failed') {
      const error = executionAttempt.error;
      // #1864 — switch on the typed pre-send boundary outcome (no `executorReturned` flag,
      // no `getStatus` re-read). The tx send happens strictly AFTER the write-ahead durably
      // records 'broadcast' (fsync inside recordDurableBroadcastBeforeSend, whose failure
      // rolls the transition back), so a 'recorded-durable' outcome means the tx may be on
      // the wire.
      if (broadcastRecorder.outcome === 'recorded-durable' && !isDefinitivePreAcceptanceSendFailure(error)) {
        // Ambiguous post-write-ahead failure — leave the job in 'broadcast' so recovery's
        // interrupted-broadcast path reconciles it on chain, never resend. Receipt timeout is
        // UNKNOWN, not failed. The tx-bearing job retains the wallet until
        // chain proof finalizes, proves a revert, or proves create absence. The reconciliation
        // demand poke for this job fires at the processNext ownership boundary, not here —
        // this frame still holds the coordinator's active-processing marker.
        return await this.getRequiredJob(claimed.jobId);
      }
      // #1867 — either the tx never left ('not-reached' / 'rolled-back-pre-send'), or a
      // DEFINITIVE pre-acceptance reject (e.g. insufficient funds at eth_sendRawTransaction)
      // on a durably-recorded broadcast: record an immediate terminal failure rather than a
      // ~15-min recovery chase. Its code comes from the publish mapper (insufficient_funds for
      // the whitelisted rejects), and GH#2270 PR-3 is why that matters more than it used to: a
      // failed KA VM job IS chain-recovery-chased now, but only while it is held, and
      // `insufficient_funds` is proven-ineffective — so a whitelisted reject lands terminal and
      // stays out of the dispatcher's queue instead of costing a chain read every tick.
      return await this.failKnowledgeAssetVmPublishExecution(session, error);
    }
    if (executionAttempt.value.kind === 'detached') {
      return executionAttempt.value.job;
    }
    // Queue mutations deliberately sit outside business catches. Ownership loss is control flow
    // for processNext(), while a local persistence fault must escape to recovery rather than be
    // reclassified as a publish failure.
    return await this.recordWorkerPublishResult(
      session,
      executionAttempt.value.publishResult,
      { publicByteSize },
    );
  }

  private async recordWorkerPublishResult(
    session: ActiveLiftJobClaimSession,
    publishResult: PublishResult,
    options: { publicByteSize?: number },
  ): Promise<LiftJob> {
    try {
      return await session.recordPublishResult(publishResult, options);
    } catch (error) {
      // Only a typed, deterministic result-contract violation is a business failure. A stale
      // session, store fault, or lock failure escapes untouched to processNext/recovery.
      if (!(error instanceof InvalidLiftPublishResultError)) throw error;
      return await session.recordExecutionFailure('broadcast', error);
    }
  }

  private async failKnowledgeAssetVmPublishExecution(
    session: ActiveLiftJobClaimSession,
    error: unknown,
  ): Promise<LiftJob> {
    const failedFromState: LiftJobState = this.isKnowledgeAssetPublishPreconditionFailure(error)
      ? 'validated'
      : 'broadcast';
    return await session.recordExecutionFailure(failedFromState, error);
  }

  /**
   * Durable post-send checkpoint. The pre-send `broadcast` record proves what
   * was signed; this timestamp proves an endpoint accepted those exact bytes.
   * It is diagnostic rather than resend authority: a missing checkpoint after
   * a crash remains ambiguous and therefore keeps the wallet reserved.
   */
  private async recordRpcAccepted(
    claim: ActiveLiftJobClaim,
    record: PreBroadcastRecord,
  ): Promise<void> {
    await this.claimCoordinator.runOwnedCheckpointTransaction(claim, async (checkpoint) => {
      const jobId = claim.jobId;
      if (checkpoint.kind === 'advanced') {
        // Independent reconciliation may have already advanced the exact transaction. This
        // branch is intentionally read-only; stale callbacks never regain mutation authority.
        if (
          checkpoint.current.broadcast?.txHash === record.txHash
        ) return;
        throw new Error(
          `RPC-accepted tx ${record.txHash} does not match advanced LiftJob ${jobId} transaction `
          + `${checkpoint.current.broadcast?.txHash ?? '(none)'}`,
        );
      }
      const { current, scope } = checkpoint;
      if (current.status !== 'broadcast') {
        throw new Error(`Cannot record RPC acceptance for LiftJob ${jobId} in state ${current.status}`);
      }
      if (current.broadcast.txHash !== record.txHash) {
        throw new Error(
          `RPC-accepted tx ${record.txHash} does not match persisted broadcast tx `
          + `${current.broadcast.txHash} for job ${jobId}`,
        );
      }
      if (
        current.broadcast.nonce !== undefined
        && record.nonce !== undefined
        && current.broadcast.nonce !== record.nonce
      ) {
        throw new Error(
          `RPC-accepted nonce ${record.nonce} does not match persisted broadcast nonce `
          + `${current.broadcast.nonce} for job ${jobId}`,
        );
      }
      if (current.timestamps.rpcAcceptedAt !== undefined) return;
      const acceptedAt = this.now();
      const next = {
        ...current,
        timestamps: {
          ...current.timestamps,
          rpcAcceptedAt: acceptedAt,
          updatedAt: acceptedAt,
        },
      } as LiftJobBroadcast;
      this.assertJobMatchesStatus(next);
      await scope.commit(next, 'rpc-accepted');
    });
  }

  private trackDetachedExecution(jobId: string, execution: Promise<unknown>): void {
    let tracked!: Promise<void>;
    tracked = execution.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.detachedExecutions.get(jobId) === tracked) {
        this.detachedExecutions.delete(jobId);
      }
      // The job just stopped being executor-owned (line-of-ownership: reconciliation skips jobs
      // in this map). Whatever the execution's outcome, only chain proof can settle the record
      // now, so invite the reconcile pass instead of leaving the job to the idle sweep.
      this.notifyReconciliationDemand();
    });
    this.detachedExecutions.set(jobId, tracked);
  }

  /**
   * GH#2359 item 2 — record the executor's receipt-confirmed hint and invite a demanded pass.
   * The entry stores the reported hash ONLY; consumption re-validates it against the job's
   * persisted write-ahead evidence under the transition lock, and release requires the
   * reconciler's own canonical proof. A re-fired hint for the same job replaces the entry
   * (consume-once per attempt); the map is bounded FIFO as a backstop.
   */
  private recordExecutorProofHint(jobId: string, confirmation: { readonly txHash?: unknown }): void {
    const txHash = confirmation?.txHash;
    if (typeof txHash !== 'string' || txHash.length === 0) return;
    this.executorProofHints.delete(jobId);
    while (this.executorProofHints.size >= TripleStoreAsyncLiftPublisher.EXECUTOR_PROOF_HINT_CAP) {
      const oldest = this.executorProofHints.keys().next().value;
      if (oldest === undefined) break;
      this.executorProofHints.delete(oldest);
    }
    this.executorProofHints.set(jobId, { txHash });
    this.notifyReconciliationDemand();
  }

  /**
   * GH#2359 item 2 — the early wallet-release lane. For a hinted job the executor still owns,
   * the pass may prove the transaction NOW (the reconciler's own two canonical reads, identical
   * to the settle path) and, on a `recovered` verdict, stamp `included` and free the wallet —
   * while the executor's local post-receipt tail keeps running. This applies the finalize
   * path's existing rule ("chain proof is sufficient to reuse the signing wallet; local
   * lifecycle repair can retry independently") at the earliest moment the proof can succeed,
   * instead of serializing the wallet behind the executor tail plus a later proof.
   *
   * The MUTATING repair (`finalizeRecovered`) deliberately stays at settle: it must never run
   * concurrently with a live executor (the r26 two-writer rule). The established proof is
   * cached on the hint so the settle-time finalize consumes it instead of re-asking the chain.
   *
   * Returns the number of hinted jobs whose proof is still unresolved (`pending`), so the pass
   * outcome can hold the active cadence for them.
   */
  private async releaseWalletsOnExecutorProofHints(
    inventory: readonly LiftJob[],
    signal?: AbortSignal,
  ): Promise<number> {
    if (this.executorProofHints.size === 0) return 0;
    // Rotated like the main tx-bearing walk (r1 3877430474): without this, a hinted job whose
    // chain lookup eats the pass budget would be re-asked first every pass and starve later
    // hints. Settle remains every hint's fallback, so starvation would cost latency, not
    // correctness — but the rotation removes even that.
    const candidates = inventory.filter((snapshot) => {
      const hint = this.executorProofHints.get(snapshot.jobId);
      return hint !== undefined && hint.proof === undefined
        && this.detachedExecutions.has(snapshot.jobId);
    });
    if (candidates.length === 0) return 0;
    const hintOffset = this.executorHintPassOffset++ % candidates.length;
    const rotatedCandidates = candidates.slice(hintOffset).concat(candidates.slice(0, hintOffset));
    let unresolved = 0;
    for (let i = 0; i < rotatedCandidates.length; i += 1) {
      const snapshot = rotatedCandidates[i];
      if (signal?.aborted) {
        // r4 (3877669330) — candidates the deadline cut off are still pending work: they are
        // deliberately invisible to the ordinary lane while executor-owned, so if they were
        // dropped here the coalesced wake would be consumed and the runner would fall back to
        // the idle cadence with hinted wallets still locked. Count the still-eligible ones.
        for (let j = i; j < rotatedCandidates.length; j += 1) {
          const skipped = this.executorProofHints.get(rotatedCandidates[j].jobId);
          if (skipped !== undefined && skipped.proof === undefined
            && this.detachedExecutions.has(rotatedCandidates[j].jobId)) {
            unresolved += 1;
          }
        }
        return unresolved;
      }
      const hint = this.executorProofHints.get(snapshot.jobId);
      if (!hint || hint.proof) continue;
      if (!this.detachedExecutions.has(snapshot.jobId)) continue;
      if (!isKnowledgeAssetVmPublishJobRequest(snapshot.request)) {
        this.executorProofHints.delete(snapshot.jobId);
        continue;
      }
      await this.claimCoordinator.runJobTransaction(snapshot.jobId, async (transaction) => {
          if (transaction.kind === 'missing') return;
          const { current, scope } = transaction;
          // 'included' is accepted deliberately (r2 3877540018): a prior attempt may have
          // persisted the included stamp and then failed the wallet-lock deletion. Restricting
          // the lane to 'broadcast' would strand that wallet until the executor tail settles.
          if (current.status !== 'broadcast' && current.status !== 'included') return;
          const recoverable = current as LiftJobBroadcast | LiftJobIncluded;
          const persistedTxHash = recoverable.broadcast?.txHash;
          if (!persistedTxHash || persistedTxHash.toLowerCase() !== hint.txHash.toLowerCase()) {
            // The hint describes an attempt that is not the persisted one (stale attempt after a
            // reset, or an executor that misreported). It must never influence this record.
            this.executorProofHints.delete(snapshot.jobId);
            return;
          }
          const origin = liveChainRecoveryOrigin(recoverable);
          const resolution = await this.resolveChainProofWithinSignal(origin.lookup, signal);
          if (resolution === null) { unresolved += 1; return; }
          if (resolution.status !== 'recovered') {
            if (resolution.status === 'pending' || resolution.status === 'inconclusive') {
              // Receipt not yet final at the operator's confirmation depth (or the read could
              // not settle): keep the hint and let the active cadence retry before settle does.
              unresolved += 1;
            } else {
              // reverted / not-found: the settle path owns that interpretation; the hint has
              // nothing left to say.
              this.executorProofHints.delete(snapshot.jobId);
            }
            return;
          }
          if (!this.knowledgeAssetVmPublishRecoveryResolver) return;
          // r1 (3877430460) — the same read-only deadline bound the settle-time finalize has:
          // a resolver that ignores the abort signal must not hold the whole pass (and every
          // other wallet) hostage. Timeout resolves null — no transition, pending, retry later.
          const resolved = await resolveWithinAbort(
            (sig) => this.knowledgeAssetVmPublishRecoveryResolver!(
              current,
              origin.lookup,
              resolution.recovery,
              sig ? { signal: sig } : undefined,
            ),
            signal,
          );
          if (!resolved) { unresolved += 1; return; }
          // r18 (3878212037) — the evidence must BIND to the persisted transaction before
          // anything durable happens with it: an inclusion for some other hash must never be
          // stamped into this record or cached. A mismatch is treated as unresolved — nothing
          // persisted, nothing cached — so the next pass performs fresh canonical reads.
          if (resolved.inclusion.txHash.toLowerCase() !== persistedTxHash.toLowerCase()) {
            unresolved += 1;
            return;
          }
          // The node has observed inclusion through its OWN canonical proof: stamp it
          // truthfully, then free the wallet (write-before-release — the poke must find
          // claim-visible state). A retry that already persisted 'included' skips the write.
          //
          // r6 (3877748379) — the containment is deliberately NARROW: only this
          // transition-and-release window is the retryable case (r2 3877540018 — a transient
          // store failure here must cost the candidate's turn, not the pass; the hint
          // survives and the next pass resumes). Resolver failures and programming errors
          // are NOT contained: they propagate out of the pass to the runner's error path,
          // where they are reported and backed off instead of becoming a silent active-cadence
          // retry loop — the same observability the canonical walk's failures have.
          try {
            const included = recoverable.status === 'broadcast'
              ? this.mergeJob(recoverable, 'included', { inclusion: resolved.inclusion })
              : recoverable;
            await scope.commitProofInclusion(included);
          } catch (error) {
            // r8 (3877817604) — transient is a HYPOTHESIS with a budget, not a verdict: the
            // first few failures are contained (the r2 retry case), but a persistently
            // failing write/release escalates out of the pass to the runner's error path -
            // reported and backoff-paced instead of silently repeating at the active cadence
            // forever. The hint survives either way, so the release stays retryable.
            hint.transitionFailures = (hint.transitionFailures ?? 0) + 1;
            if (hint.transitionFailures >= TripleStoreAsyncLiftPublisher.EXECUTOR_HINT_TRANSITION_RETRY_LIMIT) {
              throw error;
            }
            unresolved += 1;
            return;
          }
          hint.proof = { recovery: resolution.recovery, resolved };
        });
    }
    return unresolved;
  }

  async drainDetachedExecutions(): Promise<void> {
    while (this.detachedExecutions.size > 0) {
      await Promise.all([...this.detachedExecutions.values()]);
    }
  }

  readonly reconciliationScheduling = {
    // Exclusive, ATOMIC attachment: scheduling has exactly one owner (the runner); attaching
    // takes over BOTH callbacks together, so ownership can never be split between runner
    // incarnations. See the interface doc for the ownership/handover contract.
    attachScheduler: (scheduler: {
      onReconciliationDemand(): void;
      onWalletRelease(walletId: string): void;
    }): (() => void) => {
      this.schedulerListener = scheduler;
      return () => {
        // Detaches only THIS attachment — a stale detach from a superseded owner is a no-op.
        if (this.schedulerListener === scheduler) {
          this.schedulerListener = undefined;
        }
      };
    },
    // The scheduling caller's per-tick operation: one pass, one atomic answer.
    reconcile: (): Promise<{ reconciled: number; pendingWork: boolean }> => this.runReconciliationPass(),
    // Startup recovery with the outcome kept: the caller seeds its cadence from the pass it
    // already ran instead of paying a second boot-time inventory.
    recover: (): Promise<{ reconciled: number; pendingWork: boolean }> => this.runRecovery(),
  };

  /**
   * The ONE definition of "reconciliation can act on this job now": live tx-bearing state, no
   * executor ownership marker, and a lane that can actually move the record as THIS publisher
   * is wired. Shared by the outlook, the reconcile pass pre-filter, and the ownership-boundary
   * demand poke, so the three cannot drift. The deeper per-job re-checks under the transition
   * lock remain authoritative; this is the coherent pre-answer.
   */
  private isReconciliationActionable(job: LiftJob): boolean {
    return (
      (job.status === 'broadcast' || job.status === 'included')
      && !this.detachedExecutions.has(job.jobId)
      && !this.claimCoordinator.isProcessing(job.jobId)
      && this.canReconciliationProgress(job)
    );
  }

  /**
   * Whether any configured lane can ever TRANSITION this live record. A named-KA job with
   * neither the chain-proof resolver nor the named recovery resolver has no path that changes
   * it — it is deliberately held for safety — so advertising it as active work would pin the
   * scheduling caller to the active cadence (a full inventory per tick) forever, in exactly the
   * degraded configuration where recovery is unavailable. Such records stay eligible for the
   * idle crash-recovery sweep and become actionable the moment a resolver is configured again.
   * The raw lane always has a transition available (evidence-free reset, or the inconclusive
   * timeout into the held-failed state), so its jobs always count.
   */
  private canReconciliationProgress(job: LiftJob): boolean {
    if (isKnowledgeAssetVmPublishJobRequest(job.request)) {
      return this.chainProofResolver !== undefined
        || this.knowledgeAssetVmPublishRecoveryResolver !== undefined;
    }
    return true;
  }

  /**
   * A scheduling poke, not a state transition: it must never throw into a job's own control flow,
   * and it establishes nothing — the reconcile pass re-reads the queue and remains the only judge
   * of what is actionable.
   */
  private notifyReconciliationDemand(): void {
    try {
      this.schedulerListener?.onReconciliationDemand();
    } catch {
      // The listener belongs to the caller's scheduler; its failure must not touch job state.
    }
  }

  private async recoverRawLiftInterrupted(
    job: LiftJob,
    scope: LiftJobTransitionScope,
    options?: { readonly signal?: AbortSignal },
  ): Promise<boolean> {
    if (job.status !== 'broadcast' && job.status !== 'included') {
      return false;
    }
    if (!this.chainProofResolver) {
      // PR #2300 r8 (3812585483) — a 'broadcast' raw job used to be reset here on the reasoning
      // that it had probably not sent anything. The pre-send write-ahead this PR added makes that
      // reasoning false: reaching 'broadcast' now means a transaction was SIGNED and durably
      // recorded before the send, so a crash in that window leaves a record whose transaction may
      // be in the mempool or already mined. Resetting it hands the next worker a fresh signature
      // over the same content — the double publish this chain exists to prevent — and with no
      // resolver there is nothing that can establish the first transaction's fate. It therefore
      // stays where it is, transaction-bearing and unclaimable, until a node with a chain-proof
      // resolver reconciles it or an operator clears it by id.
      if (job.status === 'broadcast' && !getLiftJobTransactionEvidence(job)) {
        // Reset BEFORE release: the release poke is a one-shot claim invitation, so the
        // accepted state must already be claim-visible when it fires — the reverse order let
        // the woken loop find nothing and park while the reset committed unannounced.
        await scope.commitRecoveryReset(this.resetJobToAccepted(job, 'broadcast', undefined));
        return true;
      }
      // Evidence-bearing (or 'included'): keep the signing wallet reserved.
      // r25 (🔴 3820711322) — let the SAME timeout gate the resolver-bearing path uses
      // move it to a held failed state. Leaving it at 'broadcast' made the comment above false: a
      // non-terminal record is unclaimable, never times out, and `clearTerminalJob` rejects it as
      // nonterminal — so the operator exit this branch promised did not exist, and the job was
      // stuck until the deployment gained a resolver. Failing it inconclusively changes nothing
      // about the transaction (the evidence is preserved, nothing is resent, and it stays held for
      // chain proof), but it puts the record in the state the rest of the system can act on: the
      // operator's by-id clear works, and a node that later gains a resolver settles it through
      // the failed-job lane.
      const timedOut = job as LiftJobBroadcast | LiftJobIncluded;
      if (!this.hasInconclusiveRecoveryTimedOut(timedOut)) return false;
      const failed = this.failKnowledgeAssetInconclusiveRecovery(timedOut);
      await scope.commit(failed, 'failed');
      return true;
    }

    const recoverable = job as LiftJobBroadcast | LiftJobIncluded;
    // GH#2270 — the resolver now reports WHICH chain fact it found. This half deliberately acts on
    // `recovered` alone and lets every other verdict fall through to the timeout gate below: it
    // governs a job that is still LIVE ('broadcast'/'included'), where that gate is what bounds
    // time-to-declare-failure. Verdict-driven dispatch belongs to the FAILED-job lane, which only
    // starts once this gate has already fired.
    // A LIVE broadcast always has its metadata, so the lookup is direct here — no derivation
    // and nothing to fail to derive.
    const origin = liveChainRecoveryOrigin(recoverable);
    const resolution = await this.resolveChainProofWithinSignal(origin.lookup, options?.signal);
    if (resolution === null) return false;
    if (resolution.status === 'recovered') {
      await scope.commitProofFinalization(async () => {
        const finalized = this.finalizeRecoveredJob(
          recoverable,
          origin,
          resolution.recovery.inclusion,
          resolution.recovery.finalization,
        );
        await this.promoteFinalizedPrivateStaging(finalized);
        return finalized;
      });
      return true;
    }
    if (this.hasInconclusiveRecoveryTimedOut(recoverable)) {
      const failed = this.failInconclusiveRecovery(recoverable);
      await scope.commit(failed, 'failed');
      return true;
    }
    return false;
  }

  private async recoverKnowledgeAssetVmPublishInterrupted(
    job: LiftJob,
    scope: LiftJobTransitionScope,
    options?: { readonly signal?: AbortSignal },
  ): Promise<boolean> {
    if (job.status !== 'broadcast' && job.status !== 'included') return false;
    // The normal executor still owns this job. Recovery will retry after it
    // settles. This prevents two writers from finalizing the same lifecycle.
    if (this.detachedExecutions.has(job.jobId)) return false;

    const recoverable = job as LiftJobBroadcast | LiftJobIncluded;
    const origin = liveChainRecoveryOrigin(recoverable);
    if (this.chainProofResolver) {
      // GH#2359 item 2 — an early release already proved this transaction with this
      // reconciler's own reads; consume that proof instead of re-paying the chain. The hash
      // re-check makes a stale hint (reset + re-run between the passes) inert.
      const hint = this.executorProofHints.get(job.jobId);
      const cachedProof = hint?.proof !== undefined
        && hint.txHash.toLowerCase() === (recoverable.broadcast?.txHash ?? '').toLowerCase()
        ? hint.proof
        : undefined;
      const resolution = cachedProof
        ? { status: 'recovered' as const, recovery: cachedProof.recovery }
        : await this.resolveChainProofWithinSignal(origin.lookup, options?.signal);
      if (resolution === null) return false;
      if (resolution.status === 'recovered') {
        const outcome = await this.finalizeProvenKnowledgeAssetVmPublish(
          recoverable,
          scope,
          origin,
          resolution.recovery,
          options,
          cachedProof?.resolved,
        );
        if (outcome === 'finalized') this.executorProofHints.delete(job.jobId);
        // r18 (3878212037) — a deferred repair may mean the repair REJECTED this evidence, not
        // just that the store hiccuped. Cached evidence must not outlive that doubt: drop it so
        // the retry performs fresh canonical reads (a later corrected chain answer can then
        // repair the job instead of the cache replaying the rejected evidence forever).
        if (outcome === 'repair-deferred') this.executorProofHints.delete(job.jobId);
        return outcome === 'finalized';
      }
      // Any non-recovered verdict supersedes the hint: the chain (not the executor's claim)
      // owns this record's interpretation from here.
      this.executorProofHints.delete(job.jobId);
      if (resolution.status === 'reverted') {
        const failure = createLiftJobFailureMetadata({
          failedFromState: recoverable.status,
          code: 'tx_reverted',
          message:
            `Named knowledge asset VM publish job ${recoverable.jobId} transaction `
            + `${recoverable.broadcast.txHash} was proven reverted and published nothing.`,
          errorPayloadRef: `urn:dkg:publisher:error:${recoverable.jobId}:chain-proof-reverted`,
        });
        await scope.commitProofFailure(
          this.mergeJob(recoverable, 'failed', { failure: failure as any }),
        );
        return true;
      }
      if (resolution.status === 'not-found' && queuedLiftOperationKind(recoverable) === 'create') {
        // Reset BEFORE release — see the evidence-free reset above for why the order matters.
        await scope.commitRecoveryReset(
          buildLiftJobAcceptedReset(recoverable, {
            now: this.now(),
            recoveredFrom: recoverable.status,
            txHashChecked: recoverable.broadcast.txHash,
            txHashAccounted: true,
            stampRetriedAt: false,
            operationKind: 'create',
            walletIdChecked: recoverable.broadcast.walletId,
            ...(recoverable.broadcast.nonce !== undefined
              ? { nonceChecked: recoverable.broadcast.nonce }
              : {}),
          }),
        );
        return true;
      }
      // Pending, unrecognized, inconclusive, and update absence establish no
      // safe resend. Keep both the tx-bearing record and its wallet reservation.
      return false;
    }
    const outcome = await this.finalizeProvenKnowledgeAssetVmPublish(
      recoverable,
      scope,
      origin,
      undefined,
      options,
    );
    if (outcome === 'finalized') return true;
    // Chain success is authoritative, but local lifecycle repair may be temporarily blocked (for
    // example while SWM catch-up is still in progress). Keep the job tx-bearing and retry recovery
    // later; it is never safe to reset this job and submit a second transaction.
    if (outcome === 'repair-deferred') return false;
    if (outcome === 'unsupported') {
      // A chain resolver without the named-lifecycle finalizer cannot safely claim local recovery.
      // Preserve the explicit terminal diagnosis rather than silently marking the job finalized.
      const failed = this.failKnowledgeAssetInconclusiveRecovery(recoverable);
      await scope.commit(failed, 'failed');
      return true;
    }

    // No proof is not a failure. A receipt/canonical-finalization timeout leaves the transaction's
    // fate UNKNOWN, so preserve both the tx-bearing live state and its wallet reservation.
    return false;
  }

  /**
   * GH#2270 — the ONE way a named-KA job is finalized from chain proof, shared by the interrupted
   * lane above and the failed-job dispatcher in {@link recover}. The two used to be a candidate for
   * a second copy; they differ only in what they do with the non-finalized outcomes, which is why
   * this returns them rather than acting on them.
   *
   * The named lane needs the CANONICAL receipt (block hash, tx index, signed author — the
   * `publishProof` the generic lift recovery has no field for), so it asks
   * `knowledgeAssetVmPublishRecoveryResolver` even when the dispatcher has already established a
   * `recovered` verdict on the generic surface. Those are two different adapter reads by
   * construction (`resolvePublishTransaction` vs `resolveCanonicalFinalizationReceipt`), and the
   * second one is paid once, on the terminal transition only.
   */
  private async finalizeProvenKnowledgeAssetVmPublish(
    job: LiftJob,
    scope: LiftJobTransitionScope,
    origin: ChainRecoveryOrigin,
    // PR #2300 r2 — the dispatcher's verdict recovery, threaded through so a `recovered` update
    // verdict's canonical evidence is consumed at finalize rather than re-proven. The live
    // interrupted lane passes nothing (no verdict ran there) and the resolver verifies once.
    verdictRecovery?: AsyncLiftPublisherRecoveryResult,
    // r23 (🔴 3817474007) — the pass deadline, so this lane's own chain reads are bounded by
    // the same budget the proof was. Optional: the LIVE interrupted lane runs outside a
    // chain-proof pass and has no deadline to give.
    options?: { readonly signal?: AbortSignal },
    // GH#2359 item 2 — canonical evidence this reconciler already resolved at the early
    // wallet release; consuming it here skips the read-only phase's chain read entirely.
    preResolved?: AsyncKnowledgeAssetVmPublishRecoveryEvidence,
  ): Promise<'finalized' | 'unresolved' | 'repair-deferred' | 'unsupported'> {
    if (!this.knowledgeAssetVmPublishRecoveryResolver) return 'unresolved';
    // r26 (🔴 3821028709) — the race bounds the WAIT, it does not cancel the loser, and r25 put
    // the MUTATING repair inside it. My reasoning there was wrong in a specific way: I argued the
    // tolerance was the same as a crash in this window. It is not. A crash is fail-STOP; an
    // abandoned promise is fail-CONTINUE, and it keeps writing lifecycle state after the pass has
    // returned and released its serialization — overlapping a later pass or live queue work.
    //
    // So the split is by MUTABILITY, not by convenience:
    //   - evidence resolution is READ-ONLY, so abandoning it costs nothing but a wasted RPC. Raced.
    //   - `finalizeRecovered` MUTATES, so it is never abandoned. It is given the deadline signal
    //     and then AWAITED to termination, and an in-flight guard keeps a second pass from
    //     entering it concurrently even if something else goes wrong.
    //
    // The honest consequence, stated rather than hidden: a handler that ignores the signal and
    // never returns holds the pass open. That is deliberate. Blocking is strictly safer than a
    // repair racing the queue it was supposed to reconcile, and it is a handler defect we would
    // rather surface than paper over.
    // --- read-only phase: raced through the ONE lazy abort boundary, safe to abandon
    // (skipped when the early release already resolved the canonical evidence). A deadline
    // win and a resolver that answered null both mean the same thing here: unresolved, no
    // transition (r4 3877695872 — the former symbol sentinel distinguished two paths that
    // returned identically).
    const resolved = preResolved ?? await resolveWithinAbort(
      () => this.knowledgeAssetVmPublishRecoveryResolver!(job, origin.lookup, verdictRecovery, options),
      options?.signal,
    );
    if (!resolved) return 'unresolved';
    if (
      !this.knowledgeAssetVmPublishHandler?.finalizeRecovered
      || !isKnowledgeAssetVmPublishJobRequest(job.request)
    ) {
      return 'unsupported';
    }
    const finalizeRecovered = this.knowledgeAssetVmPublishHandler.finalizeRecovered;
    const request = job.request.knowledgeAssetVmPublish;

    let incompleteOutcome: 'unresolved' | 'repair-deferred' = 'unresolved';
    const finalized = await scope.commitProofFinalization(async () => {
      // --- mutating phase: never raced, never abandoned ---
      // Nothing STARTS past the deadline; that is what bounds the pass in the common case.
      if (options?.signal?.aborted) return null;
      if (this.finalizationsInFlight.has(job.jobId)) return null;
      this.finalizationsInFlight.add(job.jobId);
      try {
        await finalizeRecovered({
          walletId: origin.lookup.walletId,
          request,
          job,
          lookup: origin.lookup,
          recovery: resolved,
          signal: options?.signal,
        });
      } catch {
        // Local lifecycle repair is blocked for now. The caller keeps the job tx-bearing, but the
        // confirmed transaction no longer owns the wallet lock.
        incompleteOutcome = 'repair-deferred';
        return null;
      } finally {
        this.finalizationsInFlight.delete(job.jobId);
      }
      // GH#2270 follow-up (🔴 3823596367) — this used to return `unresolved` when the signal had
      // aborted while the repair ran. That was wrong, and it inverted the intent: the mutating
      // handler is deliberately AWAITED to termination and the production handler does not cancel
      // once it is past the read boundary, so a repair that starts at second 14 of a 15s budget and
      // succeeds at second 16 had genuinely completed — and was then discarded. The queue record
      // stayed held while the lifecycle was already repaired, and every later pass repeated the
      // materialization and discarded it again.
      //
      // The deadline's job is to stop a mutation STARTING late and to cancel read-only work. It has
      // no business erasing the result of a mutation it allowed to finish. A successful return is
      // therefore completion, whatever the clock says by then.

      // --- persistence: past the deadline's reach, and deliberately so ---
      return this.finalizeRecoveredJob(job, origin, resolved.inclusion, resolved.finalization);
    });
    return finalized === null ? incompleteOutcome : 'finalized';
  }

  private async findActiveKnowledgeAssetVmPublishJob(
    request: KnowledgeAssetVmPublishRequest,
  ): Promise<{ job: LiftJob; compatible: boolean } | null> {
    // Build the INCOMING key up front so a delimiter in the incoming facts fails the
    // admission closed. A malformed PERSISTED job (e.g. a legacy pre-guard admission
    // whose name carries U+001F) must NOT abort this scan and block an unrelated
    // admission, so each persisted job's key is built defensively.
    const requestKey = knowledgeAssetVmPublishLifecycleKey(request);
    // #1828 — occupancy and lifecycle grouping via the SHARED selector, so admission dedup and the
    // intent-recovery lookup partition jobs identically. GH#2270 — whether a record binds depends
    // on its SIBLINGS (an ordinary failed job behind a newer record is history; a HELD one is not,
    // since a sibling is not chain proof), so the selector groups the queue by lifecycle key and
    // admission reads its own group. The first entry is the record admission must answer for: a
    // held job before anything else, then the lifecycle's newest.
    const job = selectLifecycleBindingJobs(await this.list(), lifecycleKeyOfJob).get(requestKey)?.at(0);
    if (!job || !isKnowledgeAssetVmPublishJobRequest(job.request)) return null;
    return {
      job,
      compatible: job.request.knowledgeAssetVmPublish.intentKey === request.intentKey,
    };
  }

  /**
   * Admission's reaccept of a byte-identical re-submit. GH#2270 — the budget no longer gates it:
   * a client re-submit is a FRESH MANDATE, so an exhausted (but evidence-free) job is reaccepted
   * on the SAME jobId with the budget re-armed, never replaced by a second job for the same
   * lifecycle subject. `isOccupyingLifecycleJob` keeps such a job bound to its subject so
   * admission finds it here at all. Automatic retries and client mandates deliberately share the
   * one counter (matching `quorum_unmet`'s pre-existing semantics); the fresh mandate is the only
   * thing that re-arms it.
   *
   * An evidence-bearing job is refused by `reacceptFailedJob` with
   * {@link LiftJobPendingChainProofError} — a transient, retryable condition, not a conflict.
   */
  private async reacceptRetryableFailedKnowledgeAssetVmPublishJob(job: PersistedFailedJob): Promise<LiftJobAccepted> {
    if (!isKnowledgeAssetVmPublishJobRequest(job.request)) {
      throw new Error(`LiftJob ${job.jobId} is not a knowledge asset VM publish job`);
    }
    // Mirrors the occupancy contract that put this job in front of admission at all: retryable,
    // or held for chain proof. A held job falls through to `reacceptFailedJob`, which refuses it
    // with the typed pending-chain-proof error rather than this generic one.
    if (!job.failure.retryable && !isHeldForChainProof(job)) {
      throw new Error(`Knowledge asset VM publish job ${job.jobId} is not retryable`);
    }
    // A client re-submit spends the budget like any retry until the budget is gone; only THEN is
    // it a fresh mandate, which re-arms exactly one attempt on the same jobId rather than letting
    // a replacement job be minted for the subject.
    return this.reacceptFailedJob(job, job.retries.retryCount >= job.retries.maxRetries
      ? { kind: 'freshClientMandate' }
      : { kind: 'retry' });
  }

  /**
   * The ONE registration point for STRUCTURED (typed) KA VM-publish
   * precondition failures: a non-null result simultaneously (a) forces the
   * failure to be recorded from the pre-send 'validated' state — from
   * 'broadcast' the publish-side classifier's message sniffing lands e.g.
   * corrupt-head text containing 'mismatch' on terminal `confirmation_mismatch`,
   * and codes like `workspace_unavailable` are not even recordable there — and
   * (b) IS the persisted failure code. Registering a future structured
   * preflight error here cannot desynchronize state and code, which was
   * previously possible because the two decisions lived in independent
   * condition chains. Message-keyed legacy failures still flow through the
   * message chains below and in `recordExecutionFailure` (their consolidation
   * is #1974's scope).
   */
  private classifyKnowledgeAssetVmPublishPreconditionCode(error: unknown): LiftJobFailureCode | null {
    // GH#1786 — permanent author-capability refusal; no transaction was ever sent.
    if (isPermanentAuthorCapabilityFailure(error)) return 'authority_forbidden';
    let structuredCode: unknown;
    try {
      structuredCode = (error as { code?: unknown } | null | undefined)?.code;
    } catch {
      structuredCode = undefined;
    }
    if (structuredCode === 'PUBLISH_INTENT_STALE') return 'publish_intent_stale';
    // The EVM adapter rejects this before signing or broadcasting. Keep it in
    // the validated retry lane, where an operator can raise the cap or wait for
    // the base fee to fall. It must never create durable transaction evidence.
    if (structuredCode === 'FEE_CAP_BELOW_BASE_FEE') return 'fee_cap_below_base_fee';
    // GH#2273 — multi-valued SWM head: transient local corruption the sync
    // repair heals, NOT a stale intent; the queued request may still be
    // byte-identical to what the head certified at admission.
    if (isKnowledgeAssetWorkspaceHeadCorruptError(error)) return 'workspace_unavailable';
    // Structured admission/registration preconditions. Their persisted code
    // PRESERVES the pre-existing effective mapping: neither message ("is not
    // registered on-chain", "not a complete full share") matches any keyword
    // in the legacy chain, so both always fell through to
    // `canonicalization_failed`. Re-taxonomizing them is #1974's call — what
    // this helper guarantees is only that the code that ROUTES the failure to
    // the pre-send state is also the code that decides what gets persisted.
    if (structuredCode === 'PUBLISH_NOT_FULL_SHARE' || structuredCode === 'CG_NOT_REGISTERED') {
      return 'canonicalization_failed';
    }
    return null;
  }

  private isKnowledgeAssetPublishPreconditionFailure(error: unknown): boolean {
    if (this.classifyKnowledgeAssetVmPublishPreconditionCode(error) !== null) return true;
    const anyError = error as { code?: unknown; message?: unknown };
    const message = String(anyError?.message ?? error);
    return /is not finalized/i.test(message)
      || /No quads in shared memory/i.test(message)
      || /has no private payload/i.test(message)
      || /not a complete full share/i.test(message)
      || /cannot recover .*reservedKaId/i.test(message)
      || /seal binds/i.test(message);
  }

  async recordPublishResult(
    jobId: string,
    publishResult: PublishResult,
    options: { publicByteSize?: number } = {},
  ): Promise<LiftJob> {
    return await this.administrative.recordPublishResultById(jobId, publishResult, options);
  }

  private async recordPublishResultById(
    jobId: string,
    publishResult: PublishResult,
    options: { publicByteSize?: number } = {},
  ): Promise<LiftJob> {
    await this.ensureGraph();
    return await this.claimCoordinator.transitionAdministrative(jobId, async (current, scope) => {
      return await this.applyPublishResultTransition(current, scope, publishResult, options);
    });
  }

  private async applyPublishResultTransition(
    current: LiftJob,
    scope: LiftJobTransitionScope,
    publishResult: PublishResult,
    options: { publicByteSize?: number },
  ): Promise<LiftJob> {
    const jobId = current.jobId;
    if (!current.claim || !current.validation) {
      throw new Error(`LiftJob ${jobId} must be claimed and validated before recording publish results`);
    }

    let mappedResult: ReturnType<typeof mapPublishResultToLiftJobSuccess>;
    try {
      mappedResult = mapPublishResultToLiftJobSuccess({
        publishResult,
        walletId: current.claim.walletId,
        publicByteSize: options.publicByteSize,
      });
    } catch (error) {
      throw new InvalidLiftPublishResultError(error instanceof Error ? error.message : String(error));
    }
    // GH#2270 PR-3 r2 — the publish RESULT has no nonce to report; only the pre-send write-ahead
    // ever knew it. Every transition below replaces `broadcast` wholesale, so without this the
    // nonce recorded before the send is silently dropped the moment the executor returns — and a
    // job that later fails from 'included' would carry a hash with no way to prove its absence.
    // Carried only when the hash MATCHES, so a mismatched result (refused just below) can never
    // graft this job's nonce onto another transaction.
    // r3 — the branch MARKER travels with the nonce, and for the same reason: both are known only
    // at the write-ahead, both are wiped by a wholesale `broadcast` replacement, and recovery needs
    // both (the nonce to prove absence, the marker to know absence-release is even allowed).
    const preserved = current.broadcast?.txHash === mappedResult.broadcast?.txHash
      ? {
          ...(current.broadcast?.nonce !== undefined ? { nonce: current.broadcast.nonce } : {}),
          ...(current.broadcast?.operationKind ? { operationKind: current.broadcast.operationKind } : {}),
        }
      : {};
    const mapped = mappedResult.broadcast && Object.keys(preserved).length > 0
      ? { ...mappedResult, broadcast: { ...mappedResult.broadcast, ...preserved } }
      : mappedResult;

    let next: LiftJob = current;
    if (mapped.status === 'finalized' && mapped.finalization.mode === 'local') {
      next = this.mergeJob(next, 'finalized', {
        finalization: mapped.finalization,
      });
      this.assertJobMatchesStatus(next);
      await this.promoteFinalizedPrivateStaging(next);
      return await scope.commit(next, 'finalized');
    }

    if (!mapped.broadcast || !mapped.inclusion) {
      throw new InvalidLiftPublishResultError(
        `Async lift publish result ${mapped.status} is missing chain metadata`,
      );
    }

    if (
      (current.status === 'broadcast' || current.status === 'included')
      && current.broadcast.txHash !== mapped.broadcast.txHash
    ) {
      throw new InvalidLiftPublishResultError(
        `Async lift publish result tx ${mapped.broadcast.txHash} does not match persisted broadcast tx ` +
        `${current.broadcast.txHash} for job ${jobId}`,
      );
    }

    if (current.status === 'validated') {
      next = this.mergeJob(next, 'broadcast', { broadcast: mapped.broadcast });
      this.assertJobMatchesStatus(next);
      next = await scope.commit(next, 'broadcast');
    }

    if (mapped.status === 'included') {
      next = this.mergeJob(next, 'included', {
        broadcast: mapped.broadcast,
        inclusion: mapped.inclusion,
      });
      this.assertJobMatchesStatus(next);
      return await scope.commit(next, 'included');
    }

    if (next.status === 'broadcast') {
      next = this.mergeJob(next, 'included', {
        broadcast: mapped.broadcast,
        inclusion: mapped.inclusion,
      });
      this.assertJobMatchesStatus(next);
      next = await scope.commit(next, 'included');
    }

    next = this.mergeJob(next, 'finalized', {
      broadcast: mapped.broadcast,
      inclusion: mapped.inclusion,
      finalization: mapped.finalization,
    });
    this.assertJobMatchesStatus(next);
    await this.promoteFinalizedPrivateStaging(next);
    return await scope.commit(next, 'finalized');
  }

  async recordPublishFailure(jobId: string, failure: AsyncLiftPublishFailureInput): Promise<LiftJob> {
    return await this.administrative.recordPublishFailureById(jobId, failure);
  }

  private async recordPublishFailureById(
    jobId: string,
    failure: AsyncLiftPublishFailureInput,
  ): Promise<LiftJob> {
    await this.ensureGraph();
    return await this.claimCoordinator.transitionAdministrative(jobId, async (current, scope) => {
      return await this.applyPublishFailureTransition(current, scope, failure);
    });
  }

  private async applyPublishFailureTransition(
    current: LiftJob,
    scope: LiftJobTransitionScope,
    failure: AsyncLiftPublishFailureInput,
  ): Promise<LiftJob> {
    const next = this.scheduleRetryIfEligible(this.mergeJob(current, 'failed', {
      failure: mapPublishExceptionToLiftJobFailure(failure) as any,
    }));
    this.assertJobMatchesStatus(next);
    return await scope.commit(next, 'failed');
  }

  async recover(): Promise<number> {
    return (await this.runRecovery()).reconciled;
  }

  private async runRecovery(): Promise<{ reconciled: number; pendingWork: boolean }> {
    await this.ensureGraph();
    // Inventory is intentionally outside the global claim mutex. Each candidate takes the
    // global-claim -> job-transition locks only for its own re-read/delete turn, so a slow scan
    // cannot stop unrelated queue admission while replacement ownership stays protected.
    await this.claimCoordinator.sweepStaleOwnership();
    return await this.runReconciliationPass();
  }

  async reconcileTransactions(): Promise<number> {
    return (await this.runReconciliationPass()).reconciled;
  }

  /**
   * The ONE canonical pass: reports both what it settled and whether actionable live work
   * remains, computed DURING the walk (per-job, from the under-lock re-reads the pass already
   * pays for) — never by a second queue inventory afterwards. The scheduling caller consumes
   * this outcome atomically, so no separate outlook read exists to fail after a successful
   * pass and strand a served demand on the idle cadence. `reconcileTransactions`/`recover`
   * remain the wire-stable numeric surface over the same pass.
   */
  private async runReconciliationPass(): Promise<{ reconciled: number; pendingWork: boolean }> {
    await this.ensureGraph();
    // ONE queue inventory per pass, partitioned in memory across the three lanes — per-lane
    // full reads at an active cadence move the bottleneck into store/control-plane work. Each
    // lane re-reads its candidates under the transition lock before acting, so the shared
    // snapshot only selects candidates and staleness cannot change a disposition.
    const inventory = await this.list();
    let reconciled = await this.recoverInterruptedPreBroadcastJobs(inventory);
    // Same actionability rule the scheduling outlook answers with: executor-owned jobs are
    // skipped up front rather than each burning a transition-lock turn to be skipped deeper in.
    const txBearing = inventory.filter((job) => this.isReconciliationActionable(job));
    // The pass deadline below may truncate this walk, and `list()` order is stable — without
    // rotation a head job behind a slow resolver would be re-asked every pass while the tail
    // starved. Rotating the start bounds every job's wait to at most `txBearing.length` passes.
    // (The failed-job lane needs no rotation: its per-job due times already rotate the batch.)
    const offset = txBearing.length > 0 ? this.reconcilePassOffset++ % txBearing.length : 0;
    const rotatedTxBearing = txBearing.slice(offset).concat(txBearing.slice(0, offset));

    // Live jobs this pass could not settle: still awaiting proof after their turn, or not
    // reached before the deadline. Held-failed jobs are deliberately NOT counted — the
    // failed-job dispatcher paces itself with per-job due times.
    let remainingLive = 0;
    // Jobs the live lane settled THIS pass. A settle can be a transition INTO the held-failed
    // state (inconclusive timeout, proven revert), and the dispatcher below must see those in
    // the same pass — with only the shared start-of-pass snapshot they would wait out the idle
    // sweep holding their wallets, which per-lane inventories never made them do.
    const settledLive: string[] = [];
    const passBudgetMs = Math.max(0, this.chainProofDispatchTimeBudgetMs);
    const halfBudgetMs = Math.max(1, Math.floor(passBudgetMs / 2));
    // r15 (3878098525) — ONE absolute pass deadline: the configured budget is the operator's
    // latency ceiling, and no lane may LAUNCH chain reads past it. An already-started durable
    // transition still completes (never aborted mid-write); its overrun ends the pass. Fairness
    // across passes comes from alternation: the leading lane runs under a half-budget
    // sub-deadline, the trailing lane gets the remainder, and the lead alternates every pass —
    // an overrun costs the other lane at most one pass, its candidates reported pending for
    // the active cadence to retry.
    let hintedUnresolved = 0;
    const passDeadline = new AbortController();
    const passTimer = setTimeout(() => passDeadline.abort(), passBudgetMs);
    const leadSignal = (): { signal: AbortSignal; dispose: () => void } => {
      const lead = new AbortController();
      const leadTimer = setTimeout(() => lead.abort(), halfBudgetMs);
      const onPassAbort = () => lead.abort();
      passDeadline.signal.addEventListener('abort', onPassAbort, { once: true });
      return {
        signal: lead.signal,
        dispose: () => {
          clearTimeout(leadTimer);
          passDeadline.signal.removeEventListener('abort', onPassAbort);
          lead.abort();
        },
      };
    };
    const runHintLane = async (leading: boolean): Promise<void> => {
      const bounded = leading ? leadSignal() : undefined;
      try {
        hintedUnresolved = await this.releaseWalletsOnExecutorProofHints(
          inventory,
          bounded?.signal ?? passDeadline.signal,
        );
      } finally {
        bounded?.dispose();
      }
    };
    const runWalkLane = async (leading: boolean): Promise<void> => {
      const bounded = leading ? leadSignal() : undefined;
      const signal = bounded?.signal ?? passDeadline.signal;
      try {
        for (let i = 0; i < rotatedTxBearing.length; i += 1) {
          if (signal.aborted) {
            remainingLive += rotatedTxBearing.length - i;
            break;
          }
          const snapshot = rotatedTxBearing[i];
          await this.claimCoordinator.runJobTransaction(snapshot.jobId, async (transaction) => {
            if (transaction.kind === 'missing') return;
            const { current, scope } = transaction;
            // Settled or re-owned since the pre-filter: no longer this pass's remaining work.
            if (current.status !== 'broadcast' && current.status !== 'included') return;
            if (this.claimCoordinator.isProcessing(current.jobId)) return;
            if (
              await this.jobHandlerFor(current.request).recoverInterrupted(current, scope, { signal })
            ) {
              reconciled += 1;
              settledLive.push(current.jobId);
            } else {
              remainingLive += 1;
            }
          });
        }
      } finally {
        bounded?.dispose();
      }
    };
    // r20 (3878410728) — the half-budget split (and the lead toggle) apply only when BOTH
    // lanes actually have eligible work this pass: a lone lane gets the full absolute budget,
    // and empty passes do not consume alternation turns.
    const hintLaneHasWork = this.executorProofHints.size > 0
      && inventory.some((snapshot) => {
        const hint = this.executorProofHints.get(snapshot.jobId);
        return hint !== undefined && hint.proof === undefined
          && this.detachedExecutions.has(snapshot.jobId);
      });
    const walkLaneHasWork = rotatedTxBearing.length > 0;
    const lanesCompete = hintLaneHasWork && walkLaneHasWork;
    const hintLeads = this.hintLaneLeads;
    if (lanesCompete) this.hintLaneLeads = !this.hintLaneLeads;
    try {
      if (hintLeads) {
        if (hintLaneHasWork) await runHintLane(lanesCompete);
        if (walkLaneHasWork) await runWalkLane(false);
      } else {
        if (walkLaneHasWork) await runWalkLane(lanesCompete);
        if (hintLaneHasWork) await runHintLane(false);
      }
    } finally {
      clearTimeout(passTimer);
      passDeadline.abort();
    }

    // The dispatcher's view: the shared snapshot with this pass's own settlements made current
    // (a point read per settled job — zero on the common pass — not a second inventory).
    let dispatcherInventory: readonly LiftJob[] = inventory;
    if (settledLive.length > 0) {
      const refreshed = new Map<string, LiftJob | null>();
      for (const jobId of settledLive) {
        refreshed.set(jobId, await this.getStatus(jobId));
      }
      dispatcherInventory = inventory
        .map((job) => (refreshed.has(job.jobId) ? refreshed.get(job.jobId) ?? null : job))
        .filter((job): job is LiftJob => job !== null);
    }
    reconciled += await this.dispatchFailedJobsOnChainProof(dispatcherInventory);
    return { reconciled, pendingWork: remainingLive > 0 || hintedUnresolved > 0 };
  }

  private async resolveChainProofWithinSignal(
    lookup: AsyncLiftChainProofLookup,
    signal?: AbortSignal,
  ): Promise<AsyncLiftChainProofResolution | null> {
    if (!this.chainProofResolver) return null;
    // r4 (3877695872) — delegated to the ONE lazy abort boundary; the result semantics
    // (unbounded without a signal, null when pre-aborted or when the deadline wins) are the
    // helper's contract, no longer a local copy that can drift.
    return await resolveWithinAbort(
      (sig) => this.chainProofResolver!(lookup, sig ? { signal: sig } : undefined),
      signal,
    );
  }

  private async recoverInterruptedPreBroadcastJobs(inventory: readonly LiftJob[]): Promise<number> {
    // Candidates come from the pass's shared inventory snapshot; each is re-read under its
    // transition lock below before anything acts on it.
    const interrupted = inventory.filter(
      (job) => job.status === 'claimed' || job.status === 'validated',
    );
    let recovered = 0;
    for (const snapshot of interrupted) {
      await this.claimCoordinator.runJobTransaction(snapshot.jobId, async (transaction) => {
        if (transaction.kind === 'missing') return;
        const { current, scope } = transaction;
        if (current.status !== 'claimed' && current.status !== 'validated') return;
        if (this.claimCoordinator.isProcessing(current.jobId)) return;
        // Cross-instance ownership cannot rely on the in-memory processing marker: production has
        // distinct
        // executor/control publisher instances over the same durable queue. An unexpired,
        // token-matching wallet lock proves another instance still owns this pre-broadcast job.
        // Only a missing/expired/mismatched lock authorizes recovery to reset and reassign it.
        if (await this.claimCoordinator.isJobOwnershipActive(current)) return;
        // Reset BEFORE release — the release poke must find the accepted state claim-visible.
        await scope.commitRecoveryReset(
          this.resetJobToAccepted(current, current.status, getLiftJobTransactionEvidence(current)),
        );
        recovered += 1;
      });
    }
    return recovered;
  }

  /**
   * GH#2270 PR-3 — the proof-first dispatcher: for every failed job whose transaction is
   * unaccounted for, ask the chain and act on the ANSWER.
   *
   * Before this, the loop asked a two-state resolver and acted only on a success; every other
   * answer, including a chain that said the transaction does not exist, was the same `null` and
   * the job stayed failed. For the named lane it was worse — nothing asked at all
   * (`canRetryFailedRecovery` was `false`), so a held KA VM job could only be released by an
   * operator clearing it by id.
   *
   * NO TIME-BASED ESCAPE. The hold never expires into a reset. A held job is chased on the
   * recover() cadence for as long as it takes, at one chain read per held job per tick, and the
   * only exits are proof or an operator's by-id clear. The raw-lift lane's
   * `recoveryLookupTimeoutMs` gate is NOT adopted here and the difference is deliberate: that gate
   * bounds how long a LIVE broadcast may stay unresolved before it is declared failed, and it runs
   * while the job still holds its wallet. This lane starts AFTER that declaration. An expiry here
   * would have exactly one meaning — "we still have no proof, so resend anyway" — which is the
   * double publish this whole chain exists to prevent.
   */
  /**
   * PR #2300 r4 (3811993669) — can THIS publisher actually move that job, as configured?
   *
   * {@link hasAutomaticRecoveryExit} answers from the record alone: is there a question the chain
   * could settle. This adds the other half — whether the components that would ask and act are
   * wired up. Without a chain-proof resolver the dispatcher returns before it looks at anything,
   * and an UPDATE additionally needs the named recovery resolver to finalize what recognition
   * proves; a create's absence release needs only the reset this class already owns.
   */
  private automaticExitIsConfiguredFor(job: PersistedFailedJob): boolean {
    if (!hasAutomaticRecoveryExit(job)) return false;
    // r20 (🔴 3815617109) — per WALLET, not per node. A resolver's presence is node-wide, but the
    // ability to answer belongs to the adapter that signs for this job: on a node mixing a capable
    // adapter with a legacy one, a node-wide answer promised an automatic exit to jobs whose own
    // wallet could only ever return `inconclusive`. A job with no wallet at all cannot be asked
    // about either, which is the same answer for the same reason.
    // r23 (🔴 3817434406) — the SIGNER's adapter, from the same carrier as the hash. Reading the
    // claim here asked whether a wallet that never signed this transaction could settle it.
    const walletId = liftJobCheckedSigner(job);
    if (!walletId) return false;
    // 3825614002 — and per OPERATION KIND. Which policy answers was decided once, by role, when
    // this instance was built; this asks it directly rather than re-deriving the role from which
    // collaborators happen to be installed.
    return this.heldJobSettlement(job, walletId, liftJobOperationKindMarker(job));
  }

  private async dispatchFailedJobsOnChainProof(inventory: readonly LiftJob[]): Promise<number> {
    // The dispatcher RE-QUEUES work (a proven-absent job goes back to 'accepted') and spends a
    // chain read per held job per tick. `pause()` means this node is not driving publishes, so it
    // must not do either. The interrupted half above deliberately keeps running while paused: it
    // repairs jobs this node has ALREADY broadcast, where stopping would leave a live transaction
    // unreconciled — the phantom the pre-send write-ahead exists to make visible.
    if (this.paused || !this.chainProofResolver) return 0;

    // r18 (🔴 3816322914) — this pass costs one RPC round trip PER HELD JOB, and
    // `AsyncLiftRunner.start()` awaits `recover()`. Unbounded, an incident that leaves a large
    // held population behind slow endpoints turns startup into `held jobs x RPC timeout` and
    // re-pays it every cadence, with normal queue processing unable to begin meanwhile. Three
    // bounds apply, and none of them changes a job's DISPOSITION: a job that is not asked is left
    // exactly as held, so no bound can authorize a resend.
    const startedAt = this.now();
    // Candidates from the pass's shared inventory snapshot (one read per pass); dispositions
    // still act only on state re-read in each job's own turn.
    const heldJobs = inventory
      .filter((job) => job.status === 'failed')
      .filter(isFailedJob)
      .filter((job) => this.jobHandlerFor(job.request).canRetryFailedRecovery(job));

    // Bound 1 — only jobs whose backoff has elapsed. Jobs asked recently that established nothing
    // are deferred, so the population ROTATES through the batch rather than the head of the list
    // being re-asked every pass. No cursor is needed: the due times are the rotation.
    const dueJobs = heldJobs.filter((job) => (this.chainProofNextDueAt.get(job.jobId)?.dueAt ?? 0) <= startedAt);

    // r19 (🔴 3816490915) — the lookup is derived BEFORE the batch is taken, because a job that
    // cannot form one costs no round trip and must therefore cost no batch slot either. Deriving
    // it after the slice let unformable records — legacy or malformed held jobs, which are stably
    // ordered and so sit at the front pass after pass — consume the whole batch and starve every
    // actionable job behind them, permanently. That is strictly worse than the unbounded sweep it
    // replaced, which at least reached them. The derivation is pure and local, so paying it for
    // the whole due population buys the fix for nothing.
    const dispatchable = dueJobs
      .map((job) => ({ job, lookup: this.chainProofLookupFor(job) }))
      .filter((candidate): candidate is { job: PersistedFailedJob; lookup: AsyncLiftChainProofLookup } => candidate.lookup !== null);

    // r19 (🔴 3816490904) — one controller for the whole pass. Bound 3 as r18 shipped it only
    // gated whether the NEXT lookup started, which is not a ceiling: a resolver that never settles
    // kept `recover()` — and the startup awaiting it — pending forever, the very condition the
    // budget was introduced for. The signal is handed to the resolver so a cooperating one can
    // cancel and release its socket, and the publisher additionally stops WAITING at the deadline
    // so the pass completes even against a resolver that ignores it.
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(), Math.max(0, this.chainProofDispatchTimeBudgetMs));
    let dispatched = 0;
    try {
      // Bound 2 — at most one batch of RPCs per pass.
      for (const { job, lookup } of dispatchable.slice(0, Math.max(0, this.chainProofDispatchBatchSize))) {
        // Bound 3 — the wall-clock ceiling. Batch size bounds the CALL COUNT; when each call is slow
        // it is time that startup readiness actually depends on. Checked before each turn so a pass
        // cannot start a new round trip once the budget is spent; the rest are asked next cadence.
        if (this.now() - startedAt >= this.chainProofDispatchTimeBudgetMs) break;
        // One held job must never strand the rest of the pass. The resolver reaches the network and
        // the handlers reach the store, so either can throw; before this the exception propagated
        // out of recover() and every job queued behind this one silently stopped being reconciled.
        // A job whose turn ended in an exception simply stays held and is asked again next tick,
        // which is the same disposition as any other unestablished answer.
        try {
          const settled = await this.dispatchOneHeldJob(job, lookup, deadline);
          dispatched += settled;
          if (settled > 0) this.chainProofNextDueAt.delete(job.jobId);
          else this.deferNextChainProofAttempt(job.jobId);
        } catch {
          // An exception establishes nothing, exactly like an inconclusive verdict, so it earns the
          // same backoff — otherwise a job whose resolver reliably throws would consume a batch slot
          // every pass and crowd out jobs that could actually settle.
          this.deferNextChainProofAttempt(job.jobId);
          continue;
        }
      }
    } finally {
      // The timer must not keep the process alive past the pass, and the controller must not be
      // left un-aborted for a lookup that is still in flight after we stopped waiting on it.
      clearTimeout(deadlineTimer);
      deadline.abort();
    }
    return dispatched;
  }

  /**
   * r18 (🔴 3816322914) — a turn that established nothing defers the next one, capped and
   * jittered. Capped so a long-held job is still asked periodically rather than drifting to never;
   * jittered so a population held by ONE incident — which is how they arrive — does not come due
   * in lockstep and rebuild the thundering herd the batch bound exists to prevent.
   */
  private deferNextChainProofAttempt(jobId: string): void {
    const attempts = (this.chainProofNextDueAt.get(jobId)?.attempts ?? 0) + 1;
    const backoffMs = Math.min(
      CHAIN_PROOF_BACKOFF_BASE_MS * 2 ** (attempts - 1),
      CHAIN_PROOF_BACKOFF_MAX_MS,
    );
    this.chainProofNextDueAt.set(jobId, {
      dueAt: this.now() + backoffMs + Math.floor(this.rand() * backoffMs * CHAIN_PROOF_BACKOFF_JITTER),
      attempts,
    });
  }

  /** One held job's turn: ask the chain, then execute the disposition the policy module decides. */
  private async dispatchOneHeldJob(
    job: PersistedFailedJob,
    lookup: AsyncLiftChainProofLookup,
    deadline: AbortController,
  ): Promise<number> {
    if (!this.chainProofResolver) return 0;
    // r19 (🔴 3816490904) — the signal goes to the resolver AND the wait is bounded here. A
    // resolver that honours the signal settles promptly and releases its socket; one that ignores
    // it is abandoned rather than awaited, which is worse for that socket but leaves the ceiling
    // real. Either way the deadline establishes NOTHING, so the caller records it exactly like an
    // inconclusive verdict: the job stays held and is asked again later.
    // r7 (3877773504) — through the ONE lazy abort boundary: identical null-on-deadline
    // semantics, and a successful lookup now removes its listener from the shared pass
    // controller instead of leaving it attached until the pass aborts.
    const resolution = await resolveWithinAbort(
      (sig) => this.chainProofResolver!(lookup, sig ? { signal: sig } : undefined),
      deadline.signal,
    );
    if (resolution === null) return 0;

    // GH#2270 PR-3 r4 — the verdict was earned across an RPC await, against a SNAPSHOT of the
    // job. While it was in flight, an operator's `clearTerminalJob` or a client's fresh mandate
    // can have moved or removed the record; writing the disposition against the stale snapshot
    // would put the old record BACK — a cleared job resurrected by its own verdict, on top of
    // whatever exists now. So the disposition is applied under the SAME claim lock those
    // transitions serialize on, against a RE-READ of the record, and only when it is still the
    // identical held job the chain was asked about — same failure identity, same transaction
    // evidence. Anything else drops the verdict; the next tick asks about whatever now exists.
    return this.claimCoordinator.runClaimJobTransaction(job.jobId, async (transaction) => {
      if (transaction.kind === 'missing') return 0;
      const { current, scope } = transaction;
      if (!isFailedJob(current)) return 0;
      if (!this.isSameHeldFailedJob(job, current, lookup)) return 0;
      return this.applyChainProofDisposition(current, scope, lookup, resolution, deadline);
    });
  }

  /**
   * Is `current` still the exact held job the chain was asked about? Same failure identity (origin
   * state, code, and the failure timestamp — a re-failed successor gets a fresh `failedAt` from
   * the injected clock) and the same derived transaction evidence, compared field by field so an
   * inherited-hash successor with different nonce or pinned identity cannot inherit the verdict.
   */
  private isSameHeldFailedJob(
    before: PersistedFailedJob,
    current: PersistedFailedJob,
    lookup: AsyncLiftChainProofLookup,
  ): boolean {
    if (current.failure.failedFromState !== before.failure.failedFromState) return false;
    if (current.failure.code !== before.failure.code) return false;
    if (current.timestamps.failedAt !== before.timestamps.failedAt) return false;
    const currentLookup = this.chainProofLookupFor(current);
    return currentLookup !== null
      && chainProofLookupFingerprint(currentLookup) === chainProofLookupFingerprint(lookup);
  }

  /** Execute the disposition the policy module decides for a (re-verified) held job. */
  private async applyChainProofDisposition(
    job: PersistedFailedJob,
    scope: LiftJobTransitionScope,
    lookup: AsyncLiftChainProofLookup,
    resolution: AsyncLiftChainProofResolution,
    deadline: AbortController,
  ): Promise<number> {
    const disposition = decideChainProofDisposition(job, resolution.status);

    switch (disposition.action) {
      case 'finalize': {
        if (resolution.status !== 'recovered') return 0;
        // PR #2300 r9 (3812794019) — a published-finalized record REQUIRES claim, validation,
        // broadcast and inclusion, and both lanes finalize by rebuilding from the record they are
        // given. A held job can legitimately lack the first two: reset to a carrier-only record,
        // re-claimed, and failed again BEFORE validation. Finalizing that would persist a
        // `finalized` job that does not satisfy its own exported union, which every consumer is
        // entitled to rely on. There is nothing here to invent, so it stays held — the transaction
        // is still accounted for by the evidence it carries, and the by-id clear is the exit. The
        // LIVE lane cannot reach this state, which is why the check belongs here and not there.
        if (!job.claim || !job.validation) return 0;
        // The record goes to the handler AS PERSISTED. Where it is recovering from is stated
        // separately, from the two places a failed job actually keeps it — the failure's origin
        // state and the evidence carrier the lookup was derived from. Nothing is restored,
        // rebuilt or cast.
        const origin: ChainRecoveryOrigin = {
          recoveredFromStatus: job.failure.failedFromState === 'included' ? 'included' : 'broadcast',
          txHash: lookup.txHash,
          lookup,
        };
        // r23 (🔴 3817474007) — the budget bounded the PROOF and stopped there. Finalization
        // does its own chain reads and store writes, so a stalled provider inside it hung
        // `recover()` — and the startup awaiting it — indefinitely, which is exactly the ceiling
        // the budget exists to give. Two bounds, both needed:
        //   1. nothing STARTS once the deadline has passed. The job keeps its held state, the
        //      verdict is simply not applied this pass, and the next one re-establishes it. This
        //      is the bound that matters for the queue behind it.
        //   2. the deadline signal goes INTO the finalizer, so its own reads cancel rather than
        //      being abandoned. Only reads take it; the persistence step is not interrupted
        //      mid-write, so a timeout cannot leave a half-applied lifecycle.
        // The verdict is proof about the CHAIN, and the chain does not change because we ran out
        // of time — so declining to apply it is always safe, and never a resend.
        if (deadline.signal.aborted) return 0;
        const finalized = await this.jobHandlerFor(job.request)
          .finalizeProvenPublish(job, scope, origin, resolution.recovery, { signal: deadline.signal });
        return finalized ? 1 : 0;
      }
      case 'refail_reverted': {
        await scope.commitProofFailure(
          this.failProvenRevertedJob(job, disposition.failedFromState),
        );
        return 1;
      }
      case 'reset': {
        // The job may re-run, on the SAME jobId, through the one reset builder — which carries the
        // hash forward for audit, MARKED ACCOUNTED. This is the ONLY place that mark is written,
        // and it is what stops a released job from being re-held on a transaction this dispatcher
        // has just proven does not exist: it could never be proven a second time, because nothing
        // new was ever sent. A later attempt that actually signs something records fresh broadcast
        // evidence, and that holds unconditionally.
        // Reset BEFORE release — the release poke must find the accepted state claim-visible.
        await scope.commitRecoveryReset(
          resetFailedLiftJobToAccepted(job, this.now(), { txHashAccounted: true }),
        );
        return 1;
      }
      case 'hold':
        return 0;
      default: {
        // A new disposition must be executed here rather than silently do nothing.
        const unhandled: never = disposition;
        return unhandled;
      }
    }
  }

  async getStats(): Promise<Record<LiftJobState, number>> {
    const stats = Object.fromEntries(LIFT_JOB_STATES.map((state) => [state, 0])) as Record<LiftJobState, number>;
    for (const job of await this.list()) stats[job.status] += 1;
    return stats;
  }

  async pause(): Promise<void> {
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.paused = false;
  }

  async cancel(jobId: string): Promise<void> {
    await this.ensureGraph();
    await this.claimCoordinator.runJobTransaction(jobId, async (transaction) => {
      if (transaction.kind === 'missing') throw new Error(`LiftJob not found: ${jobId}`);
      if (transaction.current.status !== 'accepted') {
        throw new Error(
          `Only accepted LiftJobs can be cancelled. Current status: ${transaction.current.status}`,
        );
      }
      await transaction.scope.commitRemoval();
    });
  }

  /** Operator bulk retry. Wire-stable count of reaccepted jobs; see {@link retryDetailed}. */
  async retry(filter: { status?: 'failed' } = {}): Promise<number> {
    return (await this.retryDetailed(filter)).retried;
  }

  /**
   * GH#2270 — the ONE implementation behind both retry entry points, so an operator cannot pick a
   * less safe one. Jobs that may carry a transaction are counted, not reaccepted: `retry_recovery`
   * resolutions belong to `recover()`, and evidence-bearing jobs (a persisted txHash, or an
   * `included` origin) need chain proof first — the landed-transaction-recorded-locally-as-failed
   * case arrives under `rpc_unavailable`, whose `reset_to_accepted` resolution used to be taken at
   * face value here and blind-republished.
   *
   * The disposition comes from {@link classifyRetryAction}, the same action
   * {@link describeConfiguredRetryState} projects its reason from, so the counts an operator gets and
   * the reason shown per job are ONE partition rather than two orderings kept in step by hand.
   */
  async retryDetailed(filter: { status?: 'failed' } = {}): Promise<AsyncLiftRetryOutcome> {
    await this.ensureGraph();
    if (filter.status && filter.status !== 'failed') {
      return { retried: 0, blockedPendingRecovery: 0, skipped: 0 };
    }

    // #1837 — reaccept (failed→accepted) is a terminal→active transition; it MUST be
    // serialized with claimNext/enqueue AND with clearTerminalJob (which also runs under
    // withClaimLock) so a by-id clear that read a job as clearable-failed cannot be swept
    // after retry() flips it active. Without this lock the "a transitioning job cannot be
    // swept" guarantee does not hold.
    return this.claimCoordinator.runClaimTransaction(async () => {
      const counts = { retried: 0, blockedPendingRecovery: 0, skipped: 0 };
      for (const job of (await this.list({ status: 'failed' })).filter(isFailedJob)) {
        // The WRITE decision, taken over the job alone — the operator's kill-switch is not an
        // input here and the signature cannot accept one.
        const action = classifyRetryAction(job);
        // Reaccept is opted INTO explicitly; the count it lands in comes from the mapping declared
        // beside the action union, so a future action fails the BUILD until its bucket is chosen
        // rather than inheriting one from the shape of this loop.
        if (action === 'reaccept') await this.reacceptFailedJob(job, { kind: 'retry' });
        counts[FAILED_JOB_RETRY_ACTION_COUNT[action]] += 1;
      }
      return counts;
    });
  }

  /**
   * Bulk terminal cleanup. GH#2270 — the BULK lane is safe by default: it never deletes a failed
   * job that still holds its lifecycle subject while a transaction may be unaccounted for, since
   * that deletion is what turns admission's `LiftJobPendingChainProofError` back into a fresh job
   * for the same KA. `clearTerminalJob(jobId)` remains the deliberate targeted override.
   */
  async clear(status: 'finalized' | 'failed'): Promise<number> {
    await this.ensureGraph();
    const jobs = await this.list({ status });
    let cleared = 0;
    for (const snapshot of jobs) {
      await this.claimCoordinator.runJobTransaction(snapshot.jobId, async (transaction) => {
        if (transaction.kind === 'missing') return;
        const { current: job, scope } = transaction;
        // #1837 — the shared terminal-clear authority (skips retry_recovery-failed jobs, whose
        // pending tx recovery may still finalize), narrowed for the bulk lane by GH#2270's
        // evidence guard. `clearTerminalJob` keeps the unnarrowed predicate on purpose.
        if (!isBulkClearableTerminalLiftJob(job)) return;
        await scope.commitRemoval();
        cleared += 1;
      });
    }
    return cleared;
  }

  /**
   * #1837 — atomic by-exact-jobId terminal clear. Runs INSIDE withClaimLock so it is
   * serialized against claimNext/enqueue/reaccept and retry() (the only terminal→active
   * transitions) — a job transitioning cannot be swept, and concurrent clears are
   * deterministic (exactly one 'cleared', the rest 'already_absent'). deleteJob is
   * subject-scoped to the control-plane graph, so it never touches another job or the
   * #1829 journal. Never throws / never mutates on a reject.
   */
  async clearTerminalJob(
    jobId: string,
    options: { readonly pendingTransactionOverride?: { readonly requestedBy: string } } = {},
  ): Promise<TerminalJobClearOutcome> {
    // Reject an empty OR SPARQL-unsafe jobId as malformed BEFORE building the jobSubject
    // IRI — otherwise an attacker-controlled jobId (from the clear-job HTTP body) with a
    // space/'>'/'{' could break the query out of `<…>` and surface as a 500/injection
    // instead of the bounded outcome.
    if (!isSafeJobId(jobId)) return { outcome: 'rejected', reason: 'malformed' };
    // Lock order is global claim, then job transition. Claim/reaccept/clear use the
    // first lock; worker/recovery state changes use the second. Keeping this order
    // lets claim persist its job+wallet-lock ownership as one critical section
    // without deadlocking a concurrent targeted clear.
    try {
      return await this.claimCoordinator.runClaimJobTransaction(jobId, async (transaction) => {
        await this.ensureGraph();
        if (transaction.kind === 'missing') {
          // Distinguish an absent subject from a present but malformed payload while still under
          // the bound job lock. The coordinator's normal parsed read intentionally maps both to
          // null; this endpoint's wire contract has separate outcomes.
          const rows = expectBindings(
            await this.store.query(
              `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { <${jobSubject(jobId)}> <${PAYLOAD_PREDICATE}> ?payload } }`,
              { source: 'publisher.asyncLift.clearTerminalJob.missingCheck' },
            ),
          );
          return rows.length === 0
            ? { outcome: 'already_absent' }
            : { outcome: 'rejected', reason: 'malformed' };
        }
        const { current: job, scope } = transaction;
        if (!LIFT_JOB_STATES.includes(job.status)) return { outcome: 'rejected', reason: 'unknown' };
        // GH#2270 follow-up (🔴 3824098476, 🟡 3824098494) — ownership is resolved HERE, not at
        // the route. Doing it at the route meant an unsafe jobId reached a `getStatus` query before
        // this method's `isSafeJobId` guard ran, and the ownership read happened outside the claim
        // lock the clear itself takes — a TOCTOU on the record the decision is about.
        //
        // Inside, the job has already been validated and read under that lock, so the check is on
        // the same record that is about to be deleted. A caller that cannot be matched to the job's
        // admission lane simply does not get the override; the ordinary terminal clear is untouched.
        // 3825162663 — ONE decision: the policy takes the override as the caller made it and
        // settles authority and state eligibility together, so a call site cannot read the
        // canonical predicate while forgetting the ownership half.
        if (!isTargetedClearableLiftJob(job, options)) {
          return { outcome: 'rejected', reason: 'nonterminal' };
        }
        await scope.commitRemoval();
        return { outcome: 'cleared' };
      });
    } catch (error) {
      if (error instanceof MalformedLiftJobPayloadError) {
        return { outcome: 'rejected', reason: 'malformed' };
      }
      throw error;
    }
  }

  private async ensureGraph(): Promise<void> {
    if (this.graphEnsured) return;
    await this.store.createGraph(this.graphUri);
    await this.store.createGraph(DEFAULT_WALLET_LOCK_GRAPH_URI);
    await this.store.createGraph(this.journalGraphUri);
    this.graphEnsured = true;
  }

  private async writeJob(job: LiftJob, kind: JournalKind): Promise<void> {
    await this.persistJobRecord(job);
    await this.appendJournal(job, kind);
  }

  /**
   * #1863 — persist the job record as a single-subject atomic replace so a
   * lock-free reader racing a transition never observes the job subject
   * transiently empty. Every row for `jobSubject` — the payload, the status, and
   * the `CONTROL_LIFECYCLE_KEY` intent-index row (emitted inside `serializeJob`
   * via `serializeVmPublishIntentIndex`) — is replaced in ONE commit, so the
   * false `kind:'none'` intent-lookup miss / dedup gap that hinges on that index
   * row disappearing mid-write cannot occur.
   *
   * Routed through the shared writer `replaceSubjectAtomicallyOrFallback` (#1938),
   * which uses the storage capability `tryReplaceSubjectAtomically` (a
   * sibling of `replaceGraph` / `replaceGraphAndSubject`) rather than a raw
   * `update()` string: the storage layer owns the transaction boundary, literal
   * externalization, graph-set-index and changelog bookkeeping, and — crucially —
   * the reserved-plane guard applies to the TARGET GRAPH structurally instead of
   * scanning a serialized SPARQL string (a raw update would false-reject a job
   * whose quads merely reference a reserved IRI). `replaceSubject` is a STRICT
   * single-subject primitive (it rejects co-located subjects), so the two
   * subjects `serializeJob` emits — the mutable job subject and the immutable
   * request subject — are persisted separately:
   *
   *   1. INSERT the request rows FIRST (idempotent — the request is immutable,
   *      so this is a no-op re-assert on every transition after creation, and the
   *      defensive re-assert legacy/partial re-persist relies on).
   *   2. THEN atomically replace the job subject.
   *
   * The ordering is load-bearing: the request must be present before the job
   * subject becomes observable, or a lock-free reader at CREATION could see a job
   * referencing an absent request (dangling requestRef). The job-replace must
   * never land first. A store that cannot guarantee one commit boundary (no
   * `replaceSubject`, or a non-transactional SPARQL endpoint that refuses it)
   * takes the BOUNDED pre-#1863 delete-then-insert fallback (job subject only —
   * the request stays present): it still has the transient job window, but
   * admission's claim-locked `findActiveKnowledgeAssetVmPublishJob` remains the
   * authoritative dedup guard there. Durability (#1851 fsync) stays scoped to
   * `recordDurableBroadcastBeforeSend`, not here.
   */
  private async persistJobRecord(job: LiftJob): Promise<void> {
    // The serializer owns the split (and guards that a job record is exactly the
    // job + request subjects) — no ad-hoc subject filters on the write path.
    const { jobRef, jobQuads, requestQuads } = serializeJobRecord(job, this.graphUri);
    // (1) Request present BEFORE the job subject is observable — ordering matters.
    await this.store.insert(requestQuads);
    // (2) Atomically replace the mutable job subject via the shared writer (#1938),
    //     which owns the atomic-capable-vs-bounded-fallback policy for both queues.
    await replaceSubjectAtomicallyOrFallback(
      this.store,
      this.graphUri,
      jobRef,
      jobQuads,
      'publisher.asyncLift.writeJob',
    );
  }

  /**
   * #1829 — append one immutable journal entry for this transition. DEFENSIVE by
   * construction (mirrors serializeVmPublishIntentIndex): it runs inside writeJob,
   * which re-persists arbitrary persisted/legacy jobs, so it must NEVER throw back
   * into the state machine. It:
   *  - no-ops unless journalWrites is enabled (daemon-only) — the CLI inspector /
   *    standalone runner must not race the node-local per-lineageKey seq;
   *  - no-ops for the 'rollback-noop' sentinel (the #1851 rollback re-write) and any
   *    non-named-KA job (raw-lift/KA-update have no lifecycle key; named-KA scope);
   *  - derives lineageKey via the U+001F-guarded key helper inside try/catch and
   *    skips a legacy delimiter-bearing job rather than propagating (else it re-opens
   *    the #1849 scan-poisoning / delete-then-throw data-loss class);
   *  - swallows ANY store/allocation error — the journal is auxiliary (recovery reads
   *    the mutable record, never the journal), so a journal hiccup must not fail-close
   *    the authoritative write. A swallowed append is an invisible gap: "complete"
   *    means "no seq gap", not "every transition present".
   */
  private async appendJournal(job: LiftJob, kind: JournalKind): Promise<void> {
    if (!this.journalWrites) return;
    if (kind === 'rollback-noop') return;
    if (job.request.jobType !== 'knowledge-asset-vm-publish') return;
    let lineageKey: string;
    try {
      lineageKey = knowledgeAssetVmPublishLifecycleKey(job.request.knowledgeAssetVmPublish);
    } catch {
      return; // legacy delimiter-bearing job — skip, never propagate
    }
    try {
      await this.withJournalLock(lineageKey, async () => {
        const seq = await this.allocateJournalSeq(lineageKey);
        const entry = this.buildJournalEntry(job, kind, lineageKey, seq);
        await this.store.insert(serializeJournalEntry(entry, this.journalGraphUri));
      });
    } catch {
      // Auxiliary log — must never abort the authoritative state write.
    }
  }

  /** #1829 — next per-lineageKey seq: numeric MAX+1 over the journal graph, first = 0. */
  private async allocateJournalSeq(lineageKey: string): Promise<number> {
    const result = await this.store.query(
      `SELECT (MAX(?seq) AS ?m) WHERE { GRAPH <${this.journalGraphUri}> { ?e <${JOURNAL_LIFECYCLE_KEY}> ${literal(lineageKey)} ; <${JOURNAL_SEQ}> ?seq } }`,
      { source: 'publisher.asyncLift.allocateJournalSeq' },
    );
    const rows = expectBindings(result);
    const raw = rows.length === 0 ? undefined : rows[0]?.['m'];
    if (raw === undefined) return 0;
    return parseIntegerLiteral(raw) + 1;
  }

  private buildJournalEntry(job: LiftJob, kind: JournalKind, lineageKey: string, seq: number): AdmissionJournalEntry {
    const publish = (job.request as { knowledgeAssetVmPublish: { intentKey?: string } }).knowledgeAssetVmPublish;
    const txHash = 'broadcast' in job ? job.broadcast?.txHash : undefined;
    const blockNumber = 'inclusion' in job ? job.inclusion?.blockNumber : undefined;
    const merkleRoot = 'broadcast' in job ? job.broadcast?.merkleRoot : undefined;
    const ual = 'finalization' in job ? (job.finalization as { ual?: string } | undefined)?.ual : undefined;
    const failureCode = 'failure' in job ? job.failure?.code : undefined;
    const recoveredFromStatus = 'recovery' in job
      ? (job.recovery as { recoveredFromStatus?: string } | undefined)?.recoveredFromStatus
      : undefined;
    return {
      seq,
      at: this.now(),
      kind: kind as Exclude<JournalKind, 'rollback-noop'>,
      jobId: job.jobId,
      lineageKey,
      ...(publish.intentKey !== undefined ? { intentKey: publish.intentKey } : {}),
      ...(txHash !== undefined ? { txHash } : {}),
      ...(blockNumber !== undefined ? { blockNumber } : {}),
      ...(merkleRoot !== undefined ? { merkleRoot } : {}),
      ...(ual !== undefined ? { ual } : {}),
      ...(failureCode !== undefined ? { failureCode } : {}),
      ...(recoveredFromStatus !== undefined ? { recoveredFromStatus } : {}),
    };
  }

  /**
   * #1829 — facts-pure lineage read. Derives the lineageKey from the retained facts
   * (NEVER the ephemeral #1828 job-subject index, which clear/cancel remove), so it
   * still resolves after the job is gone. Read-only.
   */
  async readJournalByIntent(facts: JournalReadInput): Promise<JournalReadResult> {
    await this.ensureGraph();
    let lineageKey: string;
    try {
      lineageKey = knowledgeAssetVmPublishLifecycleKey(facts);
    } catch {
      return { entries: [], maxSeq: -1, complete: true, txHashes: [] };
    }
    const lineage = await this.readJournalEntriesBy(JOURNAL_LIFECYCLE_KEY, lineageKey);
    const entries = facts.intentKey === undefined
      ? lineage
      : lineage.filter((e) => e.intentKey === facts.intentKey);
    // maxSeq/complete describe the whole LINEAGE (the contiguity reference); entries and
    // txHashes describe the queried subset (an intentKey filter is one version within it).
    return this.summarizeJournal(entries, lineage);
  }

  /** #1829 — all journal entries bearing this jobId. Read-only. */
  async readJournalByJob(jobId: string): Promise<JournalReadResult> {
    await this.ensureGraph();
    const jobEntries = await this.readJournalEntriesBy(JOURNAL_JOB_ID, jobId);
    if (jobEntries.length === 0) return { entries: [], maxSeq: -1, complete: true, txHashes: [] };
    // A successor job continues the lineage seq (does NOT restart at 0), so completeness
    // is a property of the LINEAGE, not this job's slice. Resolve the lineage from any
    // entry (all of a job's entries share one lineageKey) and compute maxSeq/complete over it.
    const lineage = await this.readJournalEntriesBy(JOURNAL_LIFECYCLE_KEY, jobEntries[0]!.lineageKey);
    return this.summarizeJournal(jobEntries, lineage);
  }

  // Object-bound read of every entry whose `predicate` equals `value`, grouped by
  // subject and parsed. A corrupt row is skipped (parseJournalEntry returns null).
  private async readJournalEntriesBy(predicate: string, value: string): Promise<AdmissionJournalEntry[]> {
    const result = await this.store.query(
      `SELECT ?e ?p ?o WHERE { GRAPH <${this.journalGraphUri}> { ?e <${predicate}> ${literal(value)} . ?e ?p ?o } }`,
      { source: 'publisher.asyncLift.readJournalEntries' },
    );
    const bySubject = new Map<string, Record<string, string>>();
    for (const row of expectBindings(result)) {
      const subject = row['e'];
      const p = row['p'];
      const o = row['o'];
      if (subject === undefined || p === undefined || o === undefined) continue;
      const map = bySubject.get(subject) ?? {};
      map[p] = o;
      bySubject.set(subject, map);
    }
    return [...bySubject.values()]
      .map((map) => parseJournalEntry(map))
      .filter((e): e is AdmissionJournalEntry => e !== null)
      .sort((a, b) => a.seq - b.seq);
  }

  // `entries` is the queried subset returned to the caller; `lineage` is the full
  // per-lineageKey set the completeness check is computed over (defaults to `entries`
  // for a full-lineage read). maxSeq/complete describe the LINEAGE (no seq gap); a
  // subset read never spuriously reports incomplete. On oxigraph `complete` is
  // authoritative; on external SPARQL backends (no fsync) the highest-seq entry can be
  // lost on crash without a visible gap — documented on JournalReadResult as best-effort.
  private summarizeJournal(entries: AdmissionJournalEntry[], lineage: AdmissionJournalEntry[] = entries): JournalReadResult {
    const maxSeq = lineage.reduce((max, e) => Math.max(max, e.seq), -1);
    const complete = lineage.length === maxSeq + 1;
    const txHashes = [...new Set(entries.map((e) => e.txHash).filter((h): h is string => h !== undefined))];
    return { entries, maxSeq, complete, txHashes };
  }

  /**
   * #1829 — per-lineageKey mutex for the journal read-modify-write (seq allocation +
   * insert). Distinct lineages append in parallel; the same lineage serializes. Never
   * acquired while holding — or acquiring — the claim lock, so no reentrancy/deadlock.
   */
  private async withJournalLock<T>(lineageKey: string, fn: () => Promise<T>): Promise<T> {
    // journalGraphUri is a fixed constant, so the lineageKey alone keys the bucket.
    const key = lineageKey;
    const previous = TripleStoreAsyncLiftPublisher.journalQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    TripleStoreAsyncLiftPublisher.journalQueues.set(key, next);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (TripleStoreAsyncLiftPublisher.journalQueues.get(key) === next) {
        TripleStoreAsyncLiftPublisher.journalQueues.delete(key);
      }
    }
  }

  private async deleteJob(jobId: string): Promise<void> {
    await this.store.deleteByPattern({ subject: jobSubject(jobId), graph: this.graphUri });
    await this.store.deleteByPattern({ subject: requestSubject(jobId), graph: this.graphUri });
  }

  // Scheduling-only — the claim attempt re-checks every guard — and it must never throw into
  // the release path: the listener belongs to the caller's scheduler, and its failure must not
  // touch lock state.
  private notifyWalletRelease(walletId: string): void {
    try {
      this.schedulerListener?.onWalletRelease(walletId);
    } catch {
      // See above: scheduler failures stay the scheduler's problem.
    }
  }

  private async getRequiredJob(jobId: string): Promise<LiftJob> {
    const job = await this.getStatus(jobId);
    if (!job) throw new Error(`LiftJob not found: ${jobId}`);
    return job;
  }

  private async applyExecutionFailureTransition(
    current: LiftJob,
    scope: LiftJobTransitionScope,
    failedFromState: LiftJobState,
    error: unknown,
  ): Promise<LiftJob> {
    if (failedFromState === 'claimed' || failedFromState === 'validated') {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const code =
        // Structured precondition failures (author capability / stale intent /
        // corrupt head) come from the SAME classifier that routed the failure
        // to this pre-send branch, so their state and code cannot drift apart.
        // Everything message-keyed stays in the legacy chain below (#1974).
        this.classifyKnowledgeAssetVmPublishPreconditionCode(error)
          ?? (lower.includes('timeout') || lower.includes('timed out') || lower.includes('unavailable') || lower.includes('query') || lower.includes('store')
          ? 'workspace_unavailable'
          : lower.includes('authority')
          ? 'authority_forbidden'
          : lower.includes('workspace') || lower.includes('root')
            ? 'workspace_slice_not_found'
            : 'canonicalization_failed');
      const failure = createLiftJobFailureMetadata({
        failedFromState,
        code,
        message,
        errorPayloadRef: `urn:dkg:publisher:error:${current.jobId}`,
      });
      const failed = this.scheduleRetryIfEligible(
        this.mergeJob(current, 'failed', { failure: failure as any }),
      );
      this.assertJobMatchesStatus(failed);
      return await scope.commit(failed, 'failed');
    }

    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    return await this.applyPublishFailureTransition(current, scope, {
      error,
      failedFromState: failedFromState === 'included' ? 'included' : 'broadcast',
      errorPayloadRef: `urn:dkg:publisher:error:${current.jobId}`,
      timeout:
        lower.includes('timeout') || lower.includes('timed out')
          ? {
              timeoutMs: 0,
              timeoutAt: this.now(),
              // Both carriers a timeout can land on here (`tx_submit_timeout` from 'broadcast',
              // `finality_timeout` from 'included') declare this same `timeoutHandling` in the
              // registry, which validates the value — so the state cannot change it.
              handling: 'check_chain_then_finalize_or_reset',
            }
          : undefined,
    });
  }

  /**
   * The pre-send write-ahead hook, shared by BOTH publish paths.
   *
   * GH#2270 — raw lift used to send its tx with no `onPhase` of its own, so a crash in the
   * send window left the job at 'validated' with no txHash: recover() reset it to 'accepted'
   * and it re-broadcast under a fresh hash — a double publish with nothing on disk to
   * contradict it. It now takes the same boundary KA VM publish has taken since #1864, from
   * this one implementation rather than a second copy.
   *
   * `merkleRoot` is optional because only KA VM publish knows one before the send (the seal
   * root); raw lift's real root arrives with the publish result and `recordPublishResult`
   * merges it in. `LiftJobBroadcastMetadata.merkleRoot` is optional for exactly this reason —
   * the txHash is the evidence that matters here.
   */
  private createPreSendBroadcastRecorder(params: {
    claim: ActiveLiftJobClaim;
    merkleRoot?: LiftJobHex;
    publicByteSize?: number;
  }): { onBeforeBroadcast: (record: PreBroadcastRecord) => Promise<void>; readonly outcome: PreSendOutcome } {
    // #1864 — the pre-send write-ahead outcome is tracked in this closure (like `recordedTxHash`)
    // rather than threaded as a mutable out-parameter through the publish path. The
    // processKnowledgeAssetVmPublish catch reads `.outcome` to decide recovery vs terminal. It
    // stays 'not-reached' unless the write-ahead hook actually fires.
    //
    // GH#2270 PR-3 r2 — the TRIGGER is now the adapter's typed `onBeforeBroadcast`, not a parsed
    // phase string. The durability guarantee is unchanged and so is everything below it; what went
    // away is a contract that lived in a naming convention and in the ORDER two breadcrumbs were
    // emitted. The nonce arrives as a field on the signal, so there is nothing left to correlate.
    let outcome: PreSendOutcome = 'not-reached';
    let recordedTxHash: string | undefined;
    const onBeforeBroadcast = async (record: PreBroadcastRecord): Promise<void> => {
      if (recordedTxHash) return;
      recordedTxHash = record.txHash;
      try {
        await this.recordBroadcastProgressBeforeSend({
          claim: params.claim,
          txHash: record.txHash as LiftJobHex,
          nonce: record.nonce,
          // r3 — the branch that signed, persisted with the hash it signed (see
          // LiftJobBroadcastMetadata.operationKind): it is not recoverable from the request later.
          operationKind: record.operationKind,
          merkleRoot: params.merkleRoot,
          publicByteSize: params.publicByteSize,
        });
        // The transition is fsync-durable (or was already durable): the tx is about to send.
        outcome = 'recorded-durable';
      } catch (error) {
        // recordDurableBroadcastBeforeSend rolled the transition back before re-throwing (or the
        // write-ahead never durably mutated state): the tx was never sent.
        outcome = 'rolled-back-pre-send';
        throw error;
      }
    };
    return {
      onBeforeBroadcast,
      get outcome() {
        return outcome;
      },
    };
  }

  private async recordBroadcastProgressBeforeSend(params: {
    claim: ActiveLiftJobClaim;
    txHash: LiftJobHex;
    nonce?: number;
    operationKind?: 'create' | 'update';
    merkleRoot?: LiftJobHex;
    publicByteSize?: number;
  }): Promise<void> {
    await this.claimCoordinator.transitionOwned(params.claim, async (current, scope) => {
      const jobId = params.claim.jobId;
      if (current.status === 'broadcast') return;
      if (current.status !== 'validated') {
        throw new Error(
          `Cannot record pre-send broadcast for job ${jobId} from status ${current.status}`,
        );
      }
      await this.recordDurableBroadcastBeforeSend(current, scope, {
        txHash: params.txHash,
        walletId: params.claim.claim.walletId,
        nonce: params.nonce,
        operationKind: params.operationKind,
        merkleRoot: params.merkleRoot,
        publicByteSize: params.publicByteSize,
      });
    });
  }

  /**
   * The single pre-send write-ahead boundary for the KA VM publish path: record
   * the 'broadcast' transition and make it fsync-durable BEFORE the caller sends
   * the tx. Runs inside the adapter's `onBroadcast` hook, which is awaited
   * strictly before `sendSignedTransactionAndWait` (fail-closed).
   *
   * Durability is scoped here — not in the generic `writeJob`/`update` — so the
   * whole-store fsync only happens at this before-send boundary (raw-lift's
   * post-send 'broadcast' write, and every other state change, stay flush-free).
   *
   * On a write-ahead failure (the fsync, or the transition itself) the tx was
   * never sent, so restore the durable prior job: the store must never report a
   * 'broadcast' that was not fsync-durable, or recovery would chase a tx that
   * never landed. The prior job is 'validated' (asserted by the sole caller), so
   * restoring it takes no fsync and cannot re-fail here. The caller then fails
   * the job from its pre-broadcast state, off the chain-recovery track.
   *
   * #1864 — success vs the rollback re-throw is what the broadcast recorder maps to its
   * `PreSendOutcome` ('recorded-durable' vs 'rolled-back-pre-send'); this method itself
   * stays a pure durability boundary and does not carry that state.
   */
  private async recordDurableBroadcastBeforeSend(
    current: LiftJob,
    scope: LiftJobTransitionScope,
    broadcast: LiftJobBroadcastMetadata,
  ): Promise<void> {
    try {
      const next = this.mergeJob(current, 'broadcast', { broadcast });
      this.assertJobMatchesStatus(next);
      await scope.commit(next, 'broadcast');
      await this.store.flush?.();
    } catch (error) {
      // #1829 — 'rollback-noop': restoring the prior 'validated' job must NOT append a
      // duplicate journal entry (the original 'validated' entry already exists, and the
      // pre-flush 'broadcast' entry already recorded the attempt). The subsequent
      // failure transition emits the terminal entry.
      await this.writeJob(current, 'rollback-noop');
      throw error;
    }
  }

  private parseJobPayload(binding?: string): LiftJob | null {
    if (!binding) return null;
    try {
      const payload = parseLiteral(binding);
      if (typeof payload !== 'string') {
        throw new Error('payload is not an RDF literal');
      }
      const parsed = JSON.parse(payload) as LiftJob & { request: unknown };
      return {
        ...parsed,
        request: normalizePersistedLiftJobRequest(parsed.request),
      } as LiftJob;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MalformedLiftJobPayloadError(`Malformed persisted LiftJob payload: ${detail}`);
    }
  }

  // r4 (3877669534) — the canonical transition API expresses the one union-member-specific
  // transition this train performs: broadcast -> included with required inclusion metadata,
  // returning the TARGET state type. The generic signature remains for same-shape merges.
  private mergeJob(
    current: LiftJobAccepted,
    status: 'claimed',
    data: { claim: { walletId: string } },
  ): LiftJobClaimed;
  private mergeJob(
    current: LiftJobBroadcast,
    status: 'included',
    data: { inclusion: LiftJobInclusionMetadata },
  ): LiftJobIncluded;
  private mergeJob(current: LiftJob, status: LiftJobState, data: Partial<LiftJob>): LiftJob;
  private mergeJob(
    current: LiftJob,
    status: LiftJobState,
    data: Partial<LiftJob> & { inclusion?: LiftJobInclusionMetadata },
  ): LiftJob {
    const now = this.now();
    if (current.status !== status) assertLiftJobTransition(current.status, status);

    const merged = {
      ...current,
      ...data,
      status,
      timestamps: {
        ...current.timestamps,
        ...(data.timestamps ?? {}),
        updatedAt: now,
      },
    } as LiftJob;

    const next = {
      ...merged,
      timestamps: {
        ...merged.timestamps,
        claimedAt: status === 'claimed' ? (merged.timestamps.claimedAt ?? now) : merged.timestamps.claimedAt,
        validatedAt: status === 'validated' ? (merged.timestamps.validatedAt ?? now) : merged.timestamps.validatedAt,
        broadcastAt: status === 'broadcast' ? (merged.timestamps.broadcastAt ?? now) : merged.timestamps.broadcastAt,
        includedAt: status === 'included' ? (merged.timestamps.includedAt ?? now) : merged.timestamps.includedAt,
        finalizedAt: status === 'finalized' ? (merged.timestamps.finalizedAt ?? now) : merged.timestamps.finalizedAt,
        failedAt: status === 'failed' ? (merged.timestamps.failedAt ?? now) : merged.timestamps.failedAt,
        updatedAt: now,
      },
    } as LiftJob;
    // The immutable set is ENFORCED here, not merely declared, and it is checked against the
    // MERGE'S OWN OUTPUT rather than the caller's patch. Reasoning about the patch is what
    // made earlier versions of this guard wrong twice: an explicit `undefined` is spread, not
    // skipped, and an omitted nested key only survives where the merge deep-merges that
    // object -- true for `timestamps`, false for `retries`. Reading the result cannot drift.
    assertNoImmutableLiftJobFieldChange(current, next);
    return next;
  }

  /**
   * The interrupted-recovery reset: `recover()` found the job mid-flight and puts it back on the
   * queue. Same rebuilt shape as a reaccept (see {@link buildLiftJobAcceptedReset}), minus the
   * retry stamp — nothing was re-ATTEMPTED here, the job was interrupted — and the origin is
   * always recorded, because a recovery reset always knows which state it came from.
   */
  private resetJobToAccepted(
    job: LiftJob,
    recoveredFromStatus: 'claimed' | 'validated' | 'broadcast',
    txHashChecked?: LiftJobHex,
  ): LiftJobAccepted {
    return buildLiftJobAcceptedReset(job, {
      now: this.now(),
      recoveredFrom: recoveredFromStatus,
      txHashChecked,
      stampRetriedAt: false,
      ...(liftJobOperationKindMarker(job) ? { operationKind: liftJobOperationKindMarker(job) } : {}),
      // r21 (🔴 3812632539) — the signer travels with the hash. Prefer the broadcast this reset
      // is dropping; otherwise carry forward a signer an earlier reset already preserved. Never
      // the claim: that is the wallet for the NEXT attempt, not the one that signed this hash.
      ...(liftJobCheckedSigner(job) ? { walletIdChecked: liftJobCheckedSigner(job) } : {}),
      ...(liftJobCheckedNonce(job) !== undefined ? { nonceChecked: liftJobCheckedNonce(job) } : {}),
    });
  }

  /**
   * The ONE gate of the automatic lane, read by BOTH the scheduler
   * (`scheduleRetryIfEligible`, at failure-recording time) and the claim-time sweep
   * (`reacceptDueFailedJobs`) — so `autoRetryEnabled` belongs here and nowhere else. The
   * predicate itself is shared with the read-only status projection
   * ({@link describeConfiguredRetryState}), which is why it lives in the utils module.
   *
   * Turning the switch OFF mid-flight therefore STRANDS jobs that were scheduled while it was
   * on: their `nextRetryAt` passes without ever firing. They stay operator-actionable
   * (`retry()`, re-submit), and turning it back on releases them, bounded per sweep by
   * {@link MAX_REACCEPTS_PER_SWEEP}.
   */
  private isAutomaticallyRetryable(job: PersistedFailedJob): boolean {
    return isAutomaticallyRetryableLiftJob(job, { autoRetryEnabled: this.autoRetryEnabled });
  }

  /**
   * GH#2270 — read-only retry projection for a job the caller already holds, derived from the SAME
   * predicate the lane runs on, so the reported eligibility cannot disagree with what this instance
   * would do. CONFIGURED is in the name because that is its whole scope: it answers from the retry
   * knobs and the job, and cannot see whether a publisher runtime exists to run the lane (a host
   * that knows must narrow it — see {@link AsyncLiftRetryStateReader}).
   */
  describeConfiguredRetryState(job: LiftJob): LiftJobRetryProjection {
    return deriveLiftJobRetryProjection(job, { autoRetryEnabled: this.autoRetryEnabled });
  }

  private async reacceptDueFailedJobs(now: number): Promise<number> {
    let retried = 0;
    for (const job of (await this.list({ status: 'failed' })).filter(isFailedJob)) {
      if (retried >= TripleStoreAsyncLiftPublisher.MAX_REACCEPTS_PER_SWEEP) break;
      if (job.timestamps.nextRetryAt === undefined || job.timestamps.nextRetryAt > now) continue;
      if (!this.isAutomaticallyRetryable(job)) continue;
      await this.reacceptFailedJob(job, { kind: 'retry' });
      retried += 1;
    }
    return retried;
  }

  /**
   * Symmetric multiplicative jitter over the value the CALLER provides — the
   * scheduler passes the already-capped exponential and clamps the result
   * back under `retryBackoffMaxMs`, so deep retries spread across
   * [max·(1−r), max] while the ceiling stays hard (see
   * `scheduleRetryIfEligible` for the one composition). Rounded because
   * `nextRetryAt` is persisted as an xsd:integer; floored at 1ms so extreme
   * downward jitter can never schedule an immediate reaccept.
   */
  private jitteredBackoff(delay: number): number {
    // Floor of 1ms: a tiny configured base with strong downward jitter can
    // round to 0, which would schedule an IMMEDIATE reaccept and let a tight
    // failure loop burn the whole retry budget with no backoff at all.
    return Math.max(1, Math.round(delay * (1 + this.retryJitterRatio * (2 * this.rand() - 1))));
  }

  private scheduleRetryIfEligible(job: LiftJob): LiftJob {
    if (!isFailedJob(job) || !this.isAutomaticallyRetryable(job)) return job;
    // The ONE composition (documented on jitteredBackoff): jitter the CAPPED
    // exponential, clamp back under the ceiling — capped retries spread
    // across [max·(1−r), max] instead of synchronizing at exactly the cap.
    const delay = Math.min(
      this.retryBackoffMaxMs,
      this.jitteredBackoff(
        Math.min(this.retryBackoffMaxMs, this.retryBackoffBaseMs * 2 ** job.retries.retryCount),
      ),
    );
    const now = this.now();
    return {
      ...job,
      timestamps: {
        ...job.timestamps,
        nextRetryAt: now + delay,
        updatedAt: now,
      },
    };
  }

  /**
   * The ONE writer that turns a failed job back into an accepted one (claim-time sweep,
   * `retry()`, admission re-submit) — so GH#2270's chain-proof hold is enforced HERE rather than
   * trusted to each caller: a job whose transaction is unaccounted for is never reaccepted, and
   * a future caller cannot reintroduce the blind re-publish. Callers that report counts
   * (`retryDetailed`) or skip silently (the sweep) classify the job first; admission's
   * disposition IS this rejection, which the HTTP boundary maps to a retryable 503.
   *
   * Every caller STATES its {@link ReacceptIntent} — there is no default, because the two
   * intents spend the shared retry budget in opposite directions and a caller that forgot to
   * think about it would silently take whichever one this signature happened to prefer.
   */
  private async reacceptFailedJob(
    job: PersistedFailedJob,
    intent: ReacceptIntent,
  ): Promise<LiftJobAccepted> {
    return await this.claimCoordinator.runJobTransaction(job.jobId, async (transaction) => {
      if (transaction.kind === 'missing') throw new Error(`LiftJob not found: ${job.jobId}`);
      const { current, scope } = transaction;
      if (!isFailedJob(current)) {
        throw new Error(`Only failed LiftJobs can be reaccepted. Current status: ${current.status}`);
      }
      if (isHeldForChainProof(current)) {
        throw new LiftJobPendingChainProofError(
          `LiftJob ${current.jobId} failed as ${current.failure.code} after a transaction may have been submitted; `
            + 'it cannot be republished until chain recovery proves the transaction absent',
          current.jobId,
          // PR #2300 r1 — per-job: does an automatic lane exist that can move THIS record, or is
          // the operator's by-id clear its only exit? The HTTP boundary forwards the answer.
          // r4 (3811993669) — record eligibility is only half of it: a publisher with no chain-proof
          // resolver wired never touches the job, so promising a retry would send clients into a loop
          // that cannot converge. The answer is the record AND this instance's configured capability.
          this.automaticExitIsConfiguredFor(current),
        );
      }
      const reset = resetFailedLiftJobToAccepted(current, this.now());
      const retriedAt = this.now();
      const reaccepted: LiftJobAccepted = {
        ...reset,
        retries: {
          ...reset.retries,
          retryCount: intent.kind === 'freshClientMandate' ? 0 : current.retries.retryCount + 1,
          lastRetryReason: current.failure.code,
        },
        timestamps: {
          ...reset.timestamps,
          lastRetriedAt: retriedAt,
          updatedAt: retriedAt,
        },
      };
      return await scope.commitReaccept(reaccepted);
    });
  }

  /**
   * GH#2270 PR-3 r3 — the ORIGIN is passed in rather than read off the job.
   *
   * A live interrupted job carries it in `status` and `broadcast.txHash`; a FAILED one carries it
   * in `failure.failedFromState` and whichever evidence carrier it has. Reading it off the record
   * only worked for the first, which is why the dispatcher used to fabricate a broadcast-shaped
   * job to hand over. Taking it as an argument lets both lanes pass the record exactly as it is.
   *
   * `failure` is dropped here rather than by each caller: a finalized job has none, and stripping
   * it at the one place that produces a finalized record is what makes that true by construction.
   */
  private finalizeRecoveredJob(
    job: LiftJob,
    origin: ChainRecoveryOrigin,
    inclusion: LiftJobInclusionMetadata,
    finalization: LiftJobFinalizationMetadata,
  ): LiftJob {
    const now = this.now();
    const { failure: _dropped, ...withoutFailure } = job as LiftJob & { failure?: unknown };
    // PR #2300 r10 (3812960758) — a published-finalized record must CARRY its broadcast metadata,
    // and a job held on the recovery carrier alone has none: an earlier reset dropped it and kept
    // the hash. Recording it from the transaction just proven is not invention — it is the same
    // hash and wallet the proof was bound to — and without it this writes a `finalized` job that
    // does not satisfy its own union. The claim is guaranteed by the dispatcher's shape guard.
    // r23 (🔴 3817434406) — the signer comes from the LOOKUP this verdict was earned about, not
    // from the claim. A claim names the wallet for the current or next attempt; an inherited hash
    // was signed by an earlier one, so attributing it to the later claimant writes a finalized
    // record for a transaction/account pair that never existed on chain. `origin.lookup` is
    // already built from the evidence carrier (see `chainProofLookupFor`), so it is the same
    // envelope the hash came from.
    const broadcast = job.broadcast
      ?? { txHash: origin.txHash, walletId: origin.lookup.walletId };
    return {
      ...withoutFailure,
      status: 'finalized',
      ...(broadcast ? { broadcast } : {}),
      inclusion,
      finalization,
      recovery: {
        action: 'finalized_from_chain',
        recoveredFromStatus: origin.recoveredFromStatus,
        txHashChecked: origin.txHash,
      },
      timestamps: {
        ...job.timestamps,
        failedAt: undefined,
        includedAt: job.timestamps.includedAt ?? now,
        finalizedAt: now,
        lastRecoveredAt: now,
        updatedAt: now,
      },
    } as LiftJob;
  }

  private hasInconclusiveRecoveryTimedOut(job: LiftJobBroadcast | LiftJobIncluded): boolean {
    const startedAt = job.timestamps.includedAt ?? job.timestamps.broadcastAt ?? job.timestamps.updatedAt;
    return this.now() - startedAt >= this.recoveryLookupTimeoutMs;
  }

  private failInconclusiveRecovery(job: LiftJobBroadcast | LiftJobIncluded): LiftJob {
    const failure = createLiftJobFailureMetadata({
      failedFromState: job.status,
      code: 'recovery_lookup_timeout',
      message: `Chain recovery remained inconclusive for ${this.recoveryLookupTimeoutMs}ms after ${job.status}`,
      errorPayloadRef: `urn:dkg:publisher:error:${job.jobId}:recovery-timeout`,
      timeout: {
        timeoutMs: this.recoveryLookupTimeoutMs,
        timeoutAt: this.now(),
        handling: 'retry_recovery',
      },
    });

    return this.mergeJob(job, 'failed', { failure: failure as any });
  }

  /**
   * GH#2270 — re-record a held job's failure as `tx_reverted` once the chain has PROVEN its
   * transaction reverted.
   *
   * The code is not cosmetic: `isHeldForChainProof` is `hasBroadcastEvidence && !provenIneffective`,
   * and `tx_reverted` is one of the two codes the registry marks proven-ineffective. Writing it is
   * therefore how the hold is released — through the disposition module's own rule rather than
   * around it — while the evidence stays on the job (the merge keeps `broadcast`/`recovery`), so
   * an operator can still see which transaction was checked. `isOccupyingLifecycleJob` then stops
   * binding the KA's lifecycle, which is what lets the same KA be published again.
   *
   * No retry is scheduled: a revert is terminal by registry policy, and re-running it would spend
   * gas to revert again.
   */
  /**
   * GH#2270 PR-3 — the facts a chain-proof lookup needs, from whichever carrier holds them, or
   * `null` when this job cannot be asked about at all.
   *
   * The hash comes from {@link getLiftJobTransactionEvidence}, so a job whose only carrier is the
   * recovery record is covered. The wallet comes from `broadcast` when it exists and otherwise
   * from the claim, because a job reset once has no broadcast metadata left. The nonce is only
   * ever on live broadcast metadata: an inherited hash carries none, and the resolver reads that
   * absence as "no proof of absence available" rather than guessing.
   *
   * `null` means stay held WITHOUT a chain read — the honest answer for a record we cannot form a
   * question about, and strictly better than the previous behaviour, which handed the resolver a
   * failed job cast to `LiftJobBroadcast` and let it throw on the field that was not there.
   */
  private chainProofLookupFor(job: PersistedFailedJob): AsyncLiftChainProofLookup | null {
    const txHash = getLiftJobTransactionEvidence(job);
    // r21 (🔴 3812632539) — the wallet must come from the SAME carrier as the hash. Falling
    // back to `claim.walletId` paired an INHERITED hash with whatever wallet claimed the job next,
    // producing a lookup for a transaction/account pair that never existed — and update
    // recognition then bound the publisher to the wrong wallet, stranding a job whose transaction
    // had actually mined. A pre-r21 record with no preserved signer is unformable, which is the
    // fail-closed answer: it stays held and costs no batch slot.
    const walletId = liftJobCheckedSigner(job);
    if (!txHash || !walletId) return null;
    return finishChainProofLookup(job, {
      txHash,
      walletId,
      nonce: liftJobCheckedNonce(job),
      publishIdentityKaId: pinnedPublishIdentityKaId(job),
    });
  }

  private failProvenRevertedJob(
    job: PersistedFailedJob,
    failedFromState: 'broadcast' | 'included',
  ): LiftJob {
    const failure = createLiftJobFailureMetadata({
      failedFromState,
      code: 'tx_reverted',
      message:
        `LiftJob ${job.jobId} previously failed as ${job.failure.code}; chain recovery resolved its `
        + `transaction ${getLiftJobTransactionEvidence(job) ?? '(unknown)'} to a failure receipt. `
        + 'The transaction published nothing, so this job no longer holds its lifecycle subject.',
      errorPayloadRef: `urn:dkg:publisher:error:${job.jobId}:chain-proof-reverted`,
    });
    return this.mergeJob(job, 'failed', { failure: failure as any });
  }

  private failKnowledgeAssetInconclusiveRecovery(job: LiftJobBroadcast | LiftJobIncluded): LiftJob {
    const failure = createLiftJobFailureMetadata({
      failedFromState: job.status,
      code: 'recovery_state_inconsistent',
      message:
        `Named knowledge asset VM publish job ${job.jobId} reached ${job.status} state with tx ${job.broadcast.txHash}, ` +
        `but generic chain recovery cannot safely perform lifecycle finalization for this job type. ` +
        `Inspect the on-chain transaction and re-run the named lifecycle publish if needed.`,
      errorPayloadRef: `urn:dkg:publisher:error:${job.jobId}:ka-recovery-inconclusive`,
    });

    return this.mergeJob(job, 'failed', { failure: failure as any });
  }

  private async finalizeNoopPublish(claim: ActiveLiftJobClaim): Promise<LiftJob> {
    return await this.claimCoordinator.transitionOwned(claim, async (current, scope) => {
      const finalized = this.mergeJob(current, 'finalized', {
        finalization: {
          mode: 'noop',
        },
      });
      this.assertJobMatchesStatus(finalized);
      await this.promoteFinalizedPrivateStaging(finalized);
      return await scope.commit(finalized, 'noop-finalized');
    });
  }

  private async finalizeKnowledgeAssetVmPublishNoop(
    claim: ActiveLiftJobClaim,
    request: LiftPublishSnapshotRequest,
    metadata: LiftPublishRequestMetadata,
  ): Promise<LiftJob> {
    return await this.claimCoordinator.transitionOwned(claim, async (current, scope) => {
      let next = current;
      if (!next.validation) {
        next = this.mergeJob(next, 'validated', {
          validation: {
            canonicalRoots: [...request.roots],
            canonicalRootMap: Object.fromEntries(request.roots.map((root) => [root, root])),
            swmQuadCount: 0,
            authorityProofRef: metadata.authority.proofRef,
            transitionType: metadata.transitionType,
            ...(request.priorVersion ? { priorVersion: request.priorVersion } : {}),
          },
        });
        this.assertJobMatchesStatus(next);
        next = await scope.commit(next, 'validated');
      }

      const finalized = this.mergeJob(next, 'finalized', {
        finalization: { mode: 'noop' },
      });
      this.assertJobMatchesStatus(finalized);
      await this.promoteFinalizedPrivateStaging(finalized);
      return await scope.commit(finalized, 'noop-finalized');
    });
  }

  private async promoteFinalizedPrivateStaging(job: LiftJob): Promise<void> {
    if (job.status !== 'finalized' || !job.validation) return;
    if (!this.jobHandlerFor(job.request).shouldPromoteFinalizedPrivateStaging(job)) return;
    const request = rawLiftRequestFromJobRequest(job.request);
    if (!request) return;

    const privateStore = new PrivateContentStore(this.store, this.graphManager);
    for (const sourceRoot of request.roots) {
      const staged = await privateStore.getPrivateTriplesForOperation(
        request.contextGraphId,
        request.shareOperationId,
        sourceRoot,
        request.subGraphName,
      );
      if (staged.length === 0) continue;

      const canonicalRoot = job.validation.canonicalRootMap[sourceRoot] ?? sourceRoot;
      const canonicalQuads = canonicalizePrivateStagedQuads(staged, job.validation.canonicalRootMap);
      // GH #1078 — derive the commitment from the finalized slice's
      // privateMerkleRoot so a re-finalize that produces DIFFERENT content
      // supersedes the stale slice (re-finalizing identical content is
      // idempotent: same digest → append+dedup, no churn).
      const commitmentRoot = computePrivateRootV10(canonicalQuads);
      const commitmentId = commitmentRoot ? Buffer.from(commitmentRoot).toString('hex') : undefined;
      await privateStore.storePrivateTriples(
        request.contextGraphId,
        canonicalRoot,
        canonicalQuads,
        request.subGraphName,
        commitmentId,
      );
      await privateStore.deletePrivateTriplesForOperation(
        request.contextGraphId,
        request.shareOperationId,
        sourceRoot,
        request.subGraphName,
      );
    }
  }

  private jobHandlerFor(request: LiftJobRequest): AsyncLiftJobHandler {
    if (isKnowledgeAssetVmPublishJobRequest(request)) {
      return this.knowledgeAssetVmPublishJobHandler;
    }
    return this.rawLiftJobHandler;
  }

  private computePublicByteSize(quads: readonly { subject: string; predicate: string; object: string; graph: string }[]): number {
    const nquads = quads
      .map((q) => `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`)
      .join('\n');
    return new TextEncoder().encode(nquads).length;
  }

  private assertJobMatchesStatus(job: LiftJob): void {
    switch (job.status) {
      case 'accepted':
        return;
      case 'claimed':
        if (!job.claim) throw new Error('Claimed LiftJob requires claim metadata');
        return;
      case 'validated':
        if (!job.claim || !job.validation) throw new Error('Validated LiftJob requires claim and validation metadata');
        return;
      case 'broadcast':
        if (!job.claim || !job.validation || !job.broadcast) throw new Error('Broadcast LiftJob requires claim, validation, and broadcast metadata');
        return;
      case 'included':
        if (!job.claim || !job.validation || !job.broadcast || !job.inclusion) throw new Error('Included LiftJob requires claim, validation, broadcast, and inclusion metadata');
        return;
      case 'finalized':
        if (!job.claim || !job.validation || !job.finalization) {
          throw new Error('Finalized LiftJob requires claim, validation, and finalization metadata');
        }
        if (job.finalization.mode !== 'noop' && job.finalization.mode !== 'local' && (!job.broadcast || !job.inclusion)) {
          throw new Error('Published finalized LiftJob requires broadcast and inclusion metadata');
        }
        return;
      case 'failed':
        if (!job.failure) throw new Error('Failed LiftJob requires failure metadata');
        return;
      default:
        throw new Error(`Unsupported LiftJob status: ${(job as LiftJob).status}`);
    }
  }
}

function canonicalizePrivateStagedQuads(
  quads: readonly Quad[],
  canonicalRootMap: Readonly<Record<string, string>>,
): Quad[] {
  return quads.map((quad) => ({
    ...quad,
    subject: canonicalizeTerm(quad.subject, canonicalRootMap),
    object: quad.object.startsWith('"') ? quad.object : canonicalizeTerm(quad.object, canonicalRootMap),
    graph: '',
  }));
}

function canonicalizeTerm(term: string, canonicalRootMap: Readonly<Record<string, string>>): string {
  for (const [sourceRoot, canonicalRoot] of Object.entries(canonicalRootMap)) {
    if (term === sourceRoot) {
      return canonicalRoot;
    }
    const skolemPrefix = `${sourceRoot}/.well-known/genid/`;
    if (term.startsWith(skolemPrefix)) {
      return `${canonicalRoot}${term.slice(sourceRoot.length)}`;
    }
  }
  return term;
}
