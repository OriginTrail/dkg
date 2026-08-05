import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  LegacyKnowledgeAssetReadOnlyError,
  createGraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import type { PhaseCallback, PublishResult } from './publisher.js';
import {
  LIFT_JOB_STATES,
  assertLiftJobTransition,
  createLiftJobFailureMetadata,
  getLiftJobFailurePolicy,
  type LiftJob,
  type LiftJobAccepted,
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
  AsyncKnowledgeAssetVmPublishRecoveryResolver,
  AsyncLiftPublisherConfig,
  AsyncLiftPublisherRecoveryResolver,
  IntentLookupInput,
  IntentLookupResult,
  JournalReadInput,
  JournalReadResult,
  VmPublishIntentRecoveryPublisher,
  VmPublishIntentIndexBackfiller,
  VmPublishAdmissionJournalReader,
  VmPublishTerminalJobClearer,
} from './async-lift-publisher-types.js';
import { AsyncLiftJobConflictError } from './async-lift-publisher-types.js';
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
import { resolveLiftWorkspaceSlice } from './workspace-resolution.js';
import {
  CONTROL_CLAIM_TOKEN,
  CONTROL_LOCKED_JOB,
  CONTROL_LOCK_EXPIRES_AT,
  CONTROL_LOCK_STATUS,
  CONTROL_WALLET_ID,
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
  getRecoveryTxHash,
  isKnowledgeAssetVmPublishJobRequest,
  isFailedJob,
  isClearableTerminalLiftJob,
  isOccupyingLifecycleJob,
  normalizePersistedLiftJobRequest,
  rawLiftRequestFromJobRequest,
  jobSubject,
  literal,
  parseIntegerLiteral,
  parseLiteral,
  requestSubject,
  serializeJobRecord,
  serializeWalletLock,
  walletLockSubject,
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
type PreSendOutcome = 'not-reached' | 'recorded-durable' | 'rolled-back-pre-send';

type AsyncLiftJobHandler = {
  readonly inspectPreparedPayload: (job: LiftJob) => Promise<AsyncPreparedPublishPayload | null>;
  readonly process: (claimed: LiftJob, walletId: string) => Promise<LiftJob>;
  readonly recoverInterrupted: (job: LiftJob) => Promise<boolean>;
  readonly canRetryFailedRecovery: (job: PersistedFailedJob) => boolean;
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
  implements VmPublishIntentRecoveryPublisher, VmPublishIntentIndexBackfiller, VmPublishAdmissionJournalReader, VmPublishTerminalJobClearer {
  private static readonly claimQueues = new Map<string, Promise<void>>();
  // #1829 — dedicated per-lineageKey journal mutex, SEPARATE from claimQueues, so the
  // read-modify-write seq allocation is atomic without touching the claim lock (lock
  // order is always claim→journal; appendJournal never calls writeJob → no reentrancy).
  private static readonly journalQueues = new Map<string, Promise<void>>();
  private static readonly DEFAULT_RECOVERY_LOOKUP_TIMEOUT_MS = 15 * 60 * 1000;
  private static readonly DEFAULT_MAX_RETRIES = 10;
  private static readonly DEFAULT_RETRY_BACKOFF_BASE_MS = 5_000;
  private static readonly DEFAULT_RETRY_BACKOFF_MAX_MS = 60_000;

  private readonly graphUri: string;
  private readonly walletLockGraphUri: string;
  private readonly journalGraphUri: string;
  private readonly journalWrites: boolean;
  private readonly maxRetries: number;
  private readonly retryBackoffBaseMs: number;
  private readonly retryBackoffMaxMs: number;
  private readonly recoveryLookupTimeoutMs: number;
  private readonly lockLeaseMs: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly chainRecoveryResolver?: AsyncLiftPublisherRecoveryResolver;
  private readonly knowledgeAssetVmPublishRecoveryResolver?: AsyncKnowledgeAssetVmPublishRecoveryResolver;
  private readonly publishExecutor?: AsyncLiftPublisherConfig['publishExecutor'];
  private readonly knowledgeAssetVmPublishHandler?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler'];
  private readonly resolvedSliceOverrides?: Partial<LiftResolvedPublishSlice>;
  private readonly publicSnapshotStore?: AsyncLiftPublisherConfig['publicSnapshotStore'];
  private readonly graphManager: GraphManager;
  private paused = false;
  private graphEnsured = false;

  private readonly rawLiftJobHandler: AsyncLiftJobHandler = {
    inspectPreparedPayload: (job) => this.inspectRawLiftPreparedPayload(job),
    process: (claimed, walletId) => this.processRawLift(claimed, walletId),
    recoverInterrupted: (job) => this.recoverRawLiftInterrupted(job),
    canRetryFailedRecovery: (job) =>
      rawLiftRequestFromJobRequest(job.request) !== null &&
      job.failure.resolution === 'retry_recovery' &&
      'broadcast' in job &&
      Boolean(job.broadcast),
    shouldPromoteFinalizedPrivateStaging: () => true,
  };

  private readonly knowledgeAssetVmPublishJobHandler: AsyncLiftJobHandler = {
    inspectPreparedPayload: async () => null,
    process: (claimed, walletId) => this.processKnowledgeAssetVmPublish(claimed, walletId),
    recoverInterrupted: (job) => this.recoverKnowledgeAssetVmPublishInterrupted(job),
    canRetryFailedRecovery: () => false,
    shouldPromoteFinalizedPrivateStaging: () => false,
  };

  constructor(
    private readonly store: TripleStore,
    config: AsyncLiftPublisherConfig = {},
  ) {
    this.graphUri = config.graphUri ?? DEFAULT_GRAPH_URI;
    this.walletLockGraphUri = DEFAULT_WALLET_LOCK_GRAPH_URI;
    this.journalGraphUri = DEFAULT_JOURNAL_GRAPH_URI;
    this.journalWrites = config.journalWrites ?? false;
    this.maxRetries = config.maxRetries ?? TripleStoreAsyncLiftPublisher.DEFAULT_MAX_RETRIES;
    this.retryBackoffBaseMs = config.retryBackoffBaseMs ?? TripleStoreAsyncLiftPublisher.DEFAULT_RETRY_BACKOFF_BASE_MS;
    this.retryBackoffMaxMs = config.retryBackoffMaxMs ?? TripleStoreAsyncLiftPublisher.DEFAULT_RETRY_BACKOFF_MAX_MS;
    if (!Number.isFinite(this.retryBackoffBaseMs) || this.retryBackoffBaseMs <= 0) {
      throw new Error('Async lift publisher retryBackoffBaseMs must be greater than zero');
    }
    if (!Number.isFinite(this.retryBackoffMaxMs) || this.retryBackoffMaxMs < this.retryBackoffBaseMs) {
      throw new Error('Async lift publisher retryBackoffMaxMs must be at least retryBackoffBaseMs');
    }
    this.recoveryLookupTimeoutMs = config.recoveryLookupTimeoutMs ?? TripleStoreAsyncLiftPublisher.DEFAULT_RECOVERY_LOOKUP_TIMEOUT_MS;
    this.lockLeaseMs = 5 * 60 * 1000;
    this.now = config.now ?? (() => Date.now());
    this.idGenerator = config.idGenerator ?? (() => crypto.randomUUID());
    this.chainRecoveryResolver = config.chainRecoveryResolver;
    this.knowledgeAssetVmPublishRecoveryResolver = config.knowledgeAssetVmPublishRecoveryResolver;
    this.publishExecutor = config.publishExecutor;
    this.knowledgeAssetVmPublishHandler = resolveKnowledgeAssetVmPublishHandler(config);
    this.resolvedSliceOverrides = config.resolvedSliceOverrides;
    this.publicSnapshotStore = config.publicSnapshotStore;
    this.graphManager = new GraphManager(store);
  }

  async enqueueKnowledgeAssetVmPublish(request: KnowledgeAssetVmPublishRequest): Promise<string> {
    return this.withClaimLock(async () => {
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
        status: 'accepted',
        timestamps: { acceptedAt: now, updatedAt: now },
        retries: { retryCount: 0, maxRetries: this.maxRetries },
        controlPlane: { jobRef: jobSubject(jobId) },
      };
      await this.writeJob(job, 'admission');
      return jobId;
    });
  }


  async claimNext(walletId: string): Promise<LiftJob | null> {
    return this.withClaimLock(async () => {
      await this.ensureGraph();
      if (this.paused) return null;
      if (await this.hasActiveWalletLock(walletId)) return null;

      await this.reacceptDueFailedJobs(this.now());
      const next = (await this.list({ status: 'accepted' })).sort(compareAcceptedJobs)[0];
      if (!next) return null;

      const now = this.now();
      const claimToken = `${walletId}:${now}:${next.jobId}`;
      const lockExpiresAt = now + this.lockLeaseMs;
      const claimed = this.mergeJob(next, 'claimed', { claim: { walletId } });
      const claimedJob = this.buildClaimedJob(claimed, walletId, claimToken, now, lockExpiresAt);

      this.assertJobMatchesStatus(claimedJob);
      await this.writeJob(claimedJob, 'claimed');
      await this.writeWalletLock({
        walletId,
        jobId: claimedJob.jobId,
        acquiredAt: now,
        expiresAt: lockExpiresAt,
        status: 'active',
        claimToken,
        lastHeartbeatAt: now,
      });
      return claimedJob;
    });
  }

  async update(jobId: string, status: LiftJobState, data: Partial<LiftJob> = {}): Promise<void> {
    await this.ensureGraph();
    const current = await this.getRequiredJob(jobId);
    await this.assertActiveClaimLock(current);
    const next = this.refreshActiveLease(this.mergeJob(current, status, data));
    this.assertJobMatchesStatus(next);
    if (next.status === 'finalized') {
      await this.promoteFinalizedPrivateStaging(next);
    }
    await this.writeJob(next, statusToKind(next.status));
    await this.syncWalletLockForJob(next);
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
    // Partition on lifecycle-subject occupancy via the SHARED predicate that
    // admission dedup (findActiveKnowledgeAssetVmPublishJob) also uses, so the two
    // partitions are identical by construction: an occupying job (non-terminal, or
    // a retryable failed job with retries remaining that admission would reaccept)
    // is the live job to bind; everything else is superseded.
    const active = jobs.filter(isOccupyingLifecycleJob);
    const superseded = jobs.filter((job) => !isOccupyingLifecycleJob(job));
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
    const claimed = await this.claimNext(walletId);
    if (!claimed) {
      return null;
    }
    return await this.jobHandlerFor(claimed.request).process(claimed, walletId);
  }

  private async processRawLift(claimed: LiftJob, walletId: string): Promise<LiftJob> {
    let failureState: LiftJobState = claimed.status;
    try {
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

      await this.update(claimed.jobId, 'validated', {
        validation: validated.validation,
      });
      failureState = 'validated';

      const subtracted = await subtractFinalizedExactQuads({
        store: this.store,
        graphManager: this.graphManager,
        request,
        validation: validated.validation,
        resolved: validated.resolved,
      });

      if (subtracted.resolved.quads.length === 0 && (subtracted.resolved.privateQuads?.length ?? 0) === 0) {
        return await this.finalizeNoopPublish(claimed.jobId);
      }

      const prepared = prepareAsyncPublishPayload({
        request,
        validation: validated.validation,
        resolved: subtracted.resolved,
      });

      failureState = 'broadcast';
      const publishResult = await this.publishExecutor({
        walletId,
        publishOptions: prepared.publishOptions,
      });
      return await this.recordPublishResult(claimed.jobId, publishResult, {
        publicByteSize: this.computePublicByteSize(prepared.publishOptions.quads),
      });
    } catch (error) {
      return await this.recordExecutionFailure(claimed.jobId, failureState, error);
    }
  }

  private async processKnowledgeAssetVmPublish(claimed: LiftJob, walletId: string): Promise<LiftJob> {
    if (!this.knowledgeAssetVmPublishHandler) {
      throw new Error('Async knowledge asset VM publish requires a configured knowledgeAssetVmPublishHandler');
    }
    if (!isKnowledgeAssetVmPublishJobRequest(claimed.request)) {
      throw new Error(`LiftJob ${claimed.jobId} is not a knowledge asset VM publish job`);
    }
    const request = claimed.request.knowledgeAssetVmPublish;
    const snapshot = createKnowledgeAssetVmPublishSnapshotRequest(request);
    const snapshotMetadata = createKnowledgeAssetVmPublishSnapshotMetadata(request);
    const preflightInput = { walletId, request, snapshot, snapshotMetadata };

    try {
      const preflight = await this.knowledgeAssetVmPublishHandler.preflight?.(preflightInput);
      if (preflight?.action === 'noop') {
        return await this.finalizeKnowledgeAssetVmPublishNoop(claimed.jobId, snapshot, snapshotMetadata);
      }
    } catch (error) {
      return await this.recordExecutionFailure(claimed.jobId, 'claimed', error);
    }

    let validated!: ReturnType<typeof validateLiftPublishPayload>;
    let prepared!: AsyncPreparedPublishPayload;
    try {
      const resolved = await resolveLiftWorkspaceSlice({
        store: this.store,
        graphManager: this.graphManager,
        request: snapshot,
        publicSnapshotStore: this.publicSnapshotStore,
      });
      validated = validateLiftPublishPayload({
        request: snapshot,
        metadata: snapshotMetadata,
        resolved: {
          ...resolved,
          ...this.resolvedSliceOverrides,
        },
      });
      await this.update(claimed.jobId, 'validated', {
        validation: validated.validation,
      });
      prepared = prepareAsyncPublishPayload({
        request: snapshot,
        metadata: snapshotMetadata,
        validation: validated.validation,
        resolved: validated.resolved,
      });
    } catch (error) {
      return await this.recordExecutionFailure(claimed.jobId, 'claimed', error);
    }

    const publicByteSize = this.computePublicByteSize(prepared.publishOptions.quads);
    const broadcastRecorder = this.createKnowledgeAssetVmPublishBroadcastRecorder({
      jobId: claimed.jobId,
      walletId,
      merkleRoot: request.sealMerkleRoot,
      publicByteSize,
      delegate: prepared.publishOptions.onPhase,
    });
    let publishResult!: PublishResult;
    try {
      const preflight = await this.knowledgeAssetVmPublishHandler.preflight?.(preflightInput);
      if (preflight?.action === 'noop') {
        return await this.finalizeKnowledgeAssetVmPublishNoop(claimed.jobId, snapshot, snapshotMetadata);
      }
      const executionInput = {
        walletId,
        request,
        snapshot,
        snapshotMetadata,
        validation: validated.validation,
        resolved: validated.resolved,
        publishOptions: {
          ...prepared.publishOptions,
          onPhase: broadcastRecorder.onPhase,
        },
      };
      publishResult = await this.knowledgeAssetVmPublishHandler.execute(executionInput);
    } catch (error) {
      // #1864 — switch on the typed pre-send boundary outcome (no `executorReturned` flag,
      // no `getStatus` re-read). The tx send happens strictly AFTER the write-ahead durably
      // records 'broadcast' (fsync inside recordDurableBroadcastBeforeSend, whose failure
      // rolls the transition back), so a 'recorded-durable' outcome means the tx may be on
      // the wire.
      if (broadcastRecorder.outcome === 'recorded-durable' && !isDefinitivePreAcceptanceSendFailure(error)) {
        // Ambiguous post-write-ahead failure — leave the job in 'broadcast' so recovery's
        // interrupted-broadcast path reconciles it on chain, never resend.
        return await this.getRequiredJob(claimed.jobId);
      }
      // #1867 — either the tx never left ('not-reached' / 'rolled-back-pre-send'), or a
      // DEFINITIVE pre-acceptance reject (e.g. insufficient funds at eth_sendRawTransaction)
      // on a durably-recorded broadcast: record an immediate terminal failure rather than a
      // ~15-min recovery chase. A failed KA VM job is never chain-recovery-chased
      // (canRetryFailedRecovery === false); its code comes from the publish mapper
      // (insufficient_funds for the whitelisted rejects).
      return await this.failKnowledgeAssetVmPublishExecution(claimed.jobId, error);
    }
    try {
      // execute() returned — the tx landed and returned a result. A local recording failure
      // here is a broadcast-phase failure (unchanged from the prior single-catch behavior).
      return await this.recordPublishResult(claimed.jobId, publishResult, {
        publicByteSize,
      });
    } catch (error) {
      return await this.failKnowledgeAssetVmPublishExecution(claimed.jobId, error);
    }
  }

  private async failKnowledgeAssetVmPublishExecution(jobId: string, error: unknown): Promise<LiftJob> {
    const failedFromState: LiftJobState = this.isKnowledgeAssetPublishPreconditionFailure(error)
      ? 'validated'
      : 'broadcast';
    return await this.recordExecutionFailure(jobId, failedFromState, error);
  }

  private async recoverRawLiftInterrupted(job: LiftJob): Promise<boolean> {
    if (job.status !== 'broadcast' && job.status !== 'included') {
      return false;
    }
    if (!this.chainRecoveryResolver) {
      if (job.status === 'broadcast') {
        await this.releaseWalletLockForJob(job);
        await this.writeJob(this.resetJobToAccepted(job, 'reset_to_accepted', 'broadcast', getRecoveryTxHash(job)), 'recover-reset');
        return true;
      }
      return false;
    }

    const recoverable = job as LiftJobBroadcast | LiftJobIncluded;
    const resolved = await this.chainRecoveryResolver(recoverable);
    if (resolved) {
      await this.releaseWalletLockForJob(job);
      const finalized = this.finalizeRecoveredJob(recoverable, resolved.inclusion, resolved.finalization);
      await this.promoteFinalizedPrivateStaging(finalized);
      await this.writeJob(finalized, 'recovered-finalize');
      return true;
    }
    if (this.hasInconclusiveRecoveryTimedOut(recoverable)) {
      await this.releaseWalletLockForJob(job);
      await this.writeJob(this.failInconclusiveRecovery(recoverable), 'failed');
      return true;
    }
    return false;
  }

  private async recoverKnowledgeAssetVmPublishInterrupted(job: LiftJob): Promise<boolean> {
    if (job.status !== 'broadcast' && job.status !== 'included') return false;

    const recoverable = job as LiftJobBroadcast | LiftJobIncluded;
    if (this.knowledgeAssetVmPublishRecoveryResolver) {
      const resolved = await this.knowledgeAssetVmPublishRecoveryResolver(recoverable);
      if (resolved) {
        if (
          this.knowledgeAssetVmPublishHandler?.finalizeRecovered &&
          isKnowledgeAssetVmPublishJobRequest(recoverable.request)
        ) {
          try {
            await this.knowledgeAssetVmPublishHandler.finalizeRecovered({
              walletId: recoverable.broadcast.walletId,
              request: recoverable.request.knowledgeAssetVmPublish,
              job: recoverable,
              recovery: resolved,
            });
          } catch {
            // Chain success is authoritative, but local lifecycle repair may be
            // temporarily blocked (for example while SWM catch-up is still in
            // progress). Keep the job tx-bearing and retry recovery later. It
            // is never safe to reset this job and submit a second transaction.
            //
            // Holding the wallet lock here does not strand the wallet even if
            // the repair never succeeds: the lock carries the claim lease taken
            // at claim time (`claimLeaseExpiresAt`), `syncWalletLockForJob`
            // re-writes that same fixed deadline rather than extending it, and
            // `recover()` sweeps expired locks before it retries. The wallet is
            // freed at the lease deadline; the job stays tx-bearing regardless.
            return false;
          }

          await this.releaseWalletLockForJob(job);
          await this.writeJob(this.finalizeRecoveredJob(
            recoverable,
            resolved.inclusion,
            resolved.finalization,
          ), 'recovered-finalize');
          return true;
        }

        // A chain resolver without the named-lifecycle finalizer cannot safely
        // claim local recovery. Preserve the explicit terminal diagnosis rather
        // than silently marking the queue job finalized.
        await this.releaseWalletLockForJob(job);
        await this.writeJob(this.failKnowledgeAssetInconclusiveRecovery(recoverable), 'failed');
        return true;
      }
    }

    if (!this.hasInconclusiveRecoveryTimedOut(recoverable)) return false;
    await this.releaseWalletLockForJob(job);
    await this.writeJob(this.failKnowledgeAssetInconclusiveRecovery(recoverable), 'failed');
    return true;
  }

  private async findActiveKnowledgeAssetVmPublishJob(
    request: KnowledgeAssetVmPublishRequest,
  ): Promise<{ job: LiftJob; compatible: boolean } | null> {
    // Build the INCOMING key up front so a delimiter in the incoming facts fails the
    // admission closed. A malformed PERSISTED job (e.g. a legacy pre-guard admission
    // whose name carries U+001F) must NOT abort this scan and block an unrelated
    // admission, so each persisted job's key is built defensively.
    const requestKey = knowledgeAssetVmPublishLifecycleKey(request);
    const jobs = await this.list();
    for (const job of jobs) {
      if (!isKnowledgeAssetVmPublishJobRequest(job.request)) continue;
      // #1828 — occupancy + lifecycle subject via the SHARED helpers so admission
      // dedup and the intent-recovery lookup partition jobs identically (a job that
      // still occupies the subject is the live one; finalized/exhausted/non-retryable
      // are superseded).
      if (!isOccupyingLifecycleJob(job)) continue;
      const publish = job.request.knowledgeAssetVmPublish;
      let jobKey: string;
      try {
        jobKey = knowledgeAssetVmPublishLifecycleKey(publish);
      } catch {
        continue; // skip a malformed legacy job rather than failing this admission
      }
      if (jobKey !== requestKey) continue;
      return { job, compatible: publish.intentKey === request.intentKey };
    }
    return null;
  }

  private async reacceptRetryableFailedKnowledgeAssetVmPublishJob(job: PersistedFailedJob): Promise<LiftJobAccepted> {
    if (!isKnowledgeAssetVmPublishJobRequest(job.request)) {
      throw new Error(`LiftJob ${job.jobId} is not a knowledge asset VM publish job`);
    }
    if (!job.failure.retryable || job.retries.retryCount >= job.retries.maxRetries) {
      throw new Error(`Knowledge asset VM publish job ${job.jobId} is not retryable`);
    }
    return this.reacceptFailedJob(job);
  }

  private isKnowledgeAssetPublishPreconditionFailure(error: unknown): boolean {
    const anyError = error as { code?: unknown; message?: unknown };
    if (
      anyError?.code === 'PUBLISH_NOT_FULL_SHARE' ||
      anyError?.code === 'PUBLISH_INTENT_STALE' ||
      anyError?.code === 'CG_NOT_REGISTERED'
    ) {
      return true;
    }
    // GH#1786 — the node cannot re-sign the selected author's UpdateAuthorAttestation.
    // Raised while BUILDING the attestation, strictly before onPhase reaches
    // recordDurableBroadcastBeforeSend, so no transaction was ever sent: the job is still
    // 'validated' and recording 'broadcast' would publish a false claim that a broadcast
    // occurred (and mislabel the phase with it). Shared predicate — the same one decides the
    // failure CODE on both the validated and broadcast paths.
    if (isPermanentAuthorCapabilityFailure(error)) return true;
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
    await this.ensureGraph();
    const current = await this.getRequiredJob(jobId);
    if (!current.claim || !current.validation) {
      throw new Error(`LiftJob ${jobId} must be claimed and validated before recording publish results`);
    }
    await this.assertActiveClaimLock(current);

    const mapped = mapPublishResultToLiftJobSuccess({
      publishResult,
      walletId: current.claim.walletId,
      publicByteSize: options.publicByteSize,
    });

    let next: LiftJob = current;
    if (mapped.status === 'finalized' && mapped.finalization.mode === 'local') {
      next = this.mergeJob(next, 'finalized', {
        finalization: mapped.finalization,
      });
      this.assertJobMatchesStatus(next);
      await this.promoteFinalizedPrivateStaging(next);
      await this.writeJob(next, 'finalized');
      await this.syncWalletLockForJob(next);
      return next;
    }

    if (!mapped.broadcast || !mapped.inclusion) {
      throw new Error(`Async lift publish result ${mapped.status} is missing chain metadata`);
    }

    if (
      (current.status === 'broadcast' || current.status === 'included')
      && current.broadcast.txHash !== mapped.broadcast.txHash
    ) {
      throw new Error(
        `Async lift publish result tx ${mapped.broadcast.txHash} does not match persisted broadcast tx ` +
        `${current.broadcast.txHash} for job ${jobId}`,
      );
    }

    if (current.status === 'validated') {
      next = this.mergeJob(next, 'broadcast', { broadcast: mapped.broadcast });
      this.assertJobMatchesStatus(next);
      await this.writeJob(next, 'broadcast');
      await this.syncWalletLockForJob(next);
    }

    if (mapped.status === 'included') {
      next = this.mergeJob(next, 'included', {
        broadcast: mapped.broadcast,
        inclusion: mapped.inclusion,
      });
      this.assertJobMatchesStatus(next);
      await this.writeJob(next, 'included');
      await this.syncWalletLockForJob(next);
      return next;
    }

    if (next.status === 'broadcast') {
      next = this.mergeJob(next, 'included', {
        broadcast: mapped.broadcast,
        inclusion: mapped.inclusion,
      });
      this.assertJobMatchesStatus(next);
      await this.writeJob(next, 'included');
      await this.syncWalletLockForJob(next);
    }

    next = this.mergeJob(next, 'finalized', {
      broadcast: mapped.broadcast,
      inclusion: mapped.inclusion,
      finalization: mapped.finalization,
    });
    this.assertJobMatchesStatus(next);
    await this.promoteFinalizedPrivateStaging(next);
    await this.writeJob(next, 'finalized');
    await this.syncWalletLockForJob(next);
    return next;
  }

  async recordPublishFailure(jobId: string, failure: AsyncLiftPublishFailureInput): Promise<LiftJob> {
    await this.ensureGraph();
    const current = await this.getRequiredJob(jobId);
    await this.assertActiveClaimLock(current);
    const next = this.scheduleRetryIfEligible(this.mergeJob(current, 'failed', {
      failure: mapPublishExceptionToLiftJobFailure(failure) as any,
    }));
    this.assertJobMatchesStatus(next);
    await this.writeJob(next, 'failed');
    await this.syncWalletLockForJob(next);
    return next;
  }

  async recover(): Promise<number> {
    await this.ensureGraph();
    await this.sweepStaleWalletLocks();
    const interrupted = (await this.list()).filter(
      (job) => job.status === 'claimed' || job.status === 'validated' || job.status === 'broadcast' || job.status === 'included',
    );

    let recovered = 0;

    for (const job of interrupted) {
      if (job.status === 'claimed' || job.status === 'validated') {
        await this.releaseWalletLockForJob(job);
        await this.writeJob(this.resetJobToAccepted(job, 'reset_to_accepted', job.status, getRecoveryTxHash(job)), 'recover-reset');
        recovered += 1;
        continue;
      }

      if (await this.jobHandlerFor(job.request).recoverInterrupted(job)) {
        recovered += 1;
      }
    }

    // Revisit failed jobs whose resolution is retry_recovery — re-attempt chain lookup
    // so that a transient RPC outage past the timeout doesn't strand jobs permanently.
    if (this.chainRecoveryResolver) {
      const retryRecoveryJobs = (await this.list({ status: 'failed' }))
        .filter(isFailedJob)
        .filter((job) => this.jobHandlerFor(job.request).canRetryFailedRecovery(job));

      for (const job of retryRecoveryJobs) {
        const resolved = await this.chainRecoveryResolver(job as unknown as LiftJobBroadcast);
        if (resolved) {
          await this.releaseWalletLockForJob(job);
          // Restore the pre-failure status so finalizeRecoveredJob records
          // the correct recoveredFromStatus (could be 'broadcast' or 'included').
          const restoredStatus = job.failure.failedFromState === 'included' ? 'included' : 'broadcast';
          const { failure: _staleFailure, ...jobWithoutFailure } = job as unknown as Record<string, unknown>;
          const recoverable = { ...jobWithoutFailure, status: restoredStatus } as unknown as LiftJobBroadcast;
          const finalized = this.finalizeRecoveredJob(recoverable, resolved.inclusion, resolved.finalization);
          await this.promoteFinalizedPrivateStaging(finalized);
          await this.writeJob(finalized, 'recovered-finalize');
          recovered += 1;
        }
        // If still inconclusive, leave in failed state — next recover() will retry again.
      }
    }

    return recovered;
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
    const job = await this.getRequiredJob(jobId);
    if (job.status !== 'accepted') {
      throw new Error(`Only accepted LiftJobs can be cancelled. Current status: ${job.status}`);
    }
    await this.releaseWalletLockForJob(job);
    await this.deleteJob(jobId);
  }

  async retry(filter: { status?: 'failed' } = {}): Promise<number> {
    await this.ensureGraph();
    if (filter.status && filter.status !== 'failed') return 0;

    // #1837 — reaccept (failed→accepted) is a terminal→active transition; it MUST be
    // serialized with claimNext/enqueue AND with clearTerminalJob (which also runs under
    // withClaimLock) so a by-id clear that read a job as clearable-failed cannot be swept
    // after retry() flips it active. Without this lock the "a transitioning job cannot be
    // swept" guarantee does not hold.
    return this.withClaimLock(async () => {
      let retried = 0;
      for (const job of (await this.list({ status: 'failed' })).filter(isFailedJob)) {
        if (!job.failure.retryable || job.retries.retryCount >= job.retries.maxRetries) continue;
        // Jobs that failed with a recovery-phase resolution must go through recover(),
        // not retry(), to avoid double-publishing if the original tx eventually lands.
        if (job.failure.resolution === 'retry_recovery') continue;

        await this.reacceptFailedJob(job);
        retried += 1;
      }
      return retried;
    });
  }

  async clear(status: 'finalized' | 'failed'): Promise<number> {
    await this.ensureGraph();
    const jobs = await this.list({ status });
    let cleared = 0;
    for (const job of jobs) {
      // #1837 — single terminal-clear authority shared with clearTerminalJob: skips
      // retry_recovery-failed jobs (a pending on-chain tx may still land). Behavior is
      // identical to the prior inline `resolution === 'retry_recovery'` guard.
      if (!isClearableTerminalLiftJob(job)) continue;
      await this.releaseWalletLockForJob(job);
      await this.deleteJob(job.jobId);
      cleared += 1;
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
  async clearTerminalJob(jobId: string): Promise<TerminalJobClearOutcome> {
    // Reject an empty OR SPARQL-unsafe jobId as malformed BEFORE building the jobSubject
    // IRI — otherwise an attacker-controlled jobId (from the clear-job HTTP body) with a
    // space/'>'/'{' could break the query out of `<…>` and surface as a 500/injection
    // instead of the bounded outcome.
    if (!isSafeJobId(jobId)) return { outcome: 'rejected', reason: 'malformed' };
    return this.withClaimLock(async () => {
      await this.ensureGraph();
      const rows = expectBindings(
        await this.store.query(
          `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { <${jobSubject(jobId)}> <${PAYLOAD_PREDICATE}> ?payload } }`,
          { source: 'publisher.asyncLift.clearTerminalJob' },
        ),
      );
      if (rows.length === 0) return { outcome: 'already_absent' };
      // Parse defensively — a corrupt persisted payload must surface as rejected(malformed),
      // never throw (parseJobPayload does an unguarded JSON.parse).
      let job: LiftJob | null;
      try {
        job = this.parseJobPayload(rows[0]?.['payload']);
      } catch {
        return { outcome: 'rejected', reason: 'malformed' };
      }
      if (job === null) return { outcome: 'rejected', reason: 'malformed' };
      if (!LIFT_JOB_STATES.includes(job.status)) return { outcome: 'rejected', reason: 'unknown' };
      if (!isClearableTerminalLiftJob(job)) return { outcome: 'rejected', reason: 'nonterminal' };
      await this.releaseWalletLockForJob(job);
      await this.deleteJob(jobId);
      return { outcome: 'cleared' };
    });
  }

  private async ensureGraph(): Promise<void> {
    if (this.graphEnsured) return;
    await this.store.createGraph(this.graphUri);
    await this.store.createGraph(this.walletLockGraphUri);
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

  private async writeWalletLock(lock: {
    walletId: string;
    jobId: string;
    acquiredAt: number;
    expiresAt: number;
    status: 'active' | 'expired' | 'released';
    claimToken?: string;
    lastHeartbeatAt?: number;
  }): Promise<void> {
    await this.store.deleteByPattern({ subject: walletLockSubject(lock.walletId), graph: this.walletLockGraphUri });
    await this.store.insert(serializeWalletLock(lock, this.walletLockGraphUri));
  }

  private async deleteWalletLock(walletId: string): Promise<void> {
    await this.store.deleteByPattern({ subject: walletLockSubject(walletId), graph: this.walletLockGraphUri });
  }

  private async readWalletLock(walletId: string): Promise<{
    walletId: string;
    jobId: string;
    claimToken?: string;
    status: string;
    expiresAt?: number;
  } | null> {
    const result = await this.store.query(
      `SELECT ?job ?status ?expiresAt ?claimToken WHERE { GRAPH <${this.walletLockGraphUri}> { <${walletLockSubject(walletId)}> <${CONTROL_LOCKED_JOB}> ?job ; <${CONTROL_LOCK_STATUS}> ?status . OPTIONAL { <${walletLockSubject(walletId)}> <${CONTROL_LOCK_EXPIRES_AT}> ?expiresAt } OPTIONAL { <${walletLockSubject(walletId)}> <${CONTROL_CLAIM_TOKEN}> ?claimToken } } }`,
      { source: 'publisher.asyncLift.walletLock.read' },
    );
    const rows = expectBindings(result);
    if (rows.length === 0) return null;
    const row = rows[0] ?? {};
    const jobId = this.jobIdFromRef(row['job'] ?? '');
    const status = parseLiteral(row['status'] ?? '""');
    if (!jobId || typeof status !== 'string') return null;
    const claimToken = row['claimToken'] ? parseLiteral(row['claimToken']) : undefined;
    return {
      walletId,
      jobId,
      claimToken: typeof claimToken === 'string' ? claimToken : undefined,
      status,
      expiresAt: row['expiresAt'] ? parseIntegerLiteral(row['expiresAt']) : undefined,
    };
  }

  private async hasActiveWalletLock(walletId: string): Promise<boolean> {
    const now = this.now();
    const result = await this.store.query(
      `SELECT ?expiresAt WHERE { GRAPH <${this.walletLockGraphUri}> { <${walletLockSubject(walletId)}> <${CONTROL_LOCK_STATUS}> ${literal('active')} ; <${CONTROL_LOCK_EXPIRES_AT}> ?expiresAt . } }`,
      { source: 'publisher.asyncLift.walletLock.active' },
    );
    const rows = expectBindings(result);
    if (rows.length === 0) return false;
    return parseIntegerLiteral(rows[0]?.['expiresAt'] ?? '"0"') > now;
  }

  private async sweepStaleWalletLocks(): Promise<string[]> {
    const now = this.now();
    const result = await this.store.query(
      `SELECT ?wallet ?job ?expiresAt ?claimToken WHERE { GRAPH <${this.walletLockGraphUri}> { ?lock <${CONTROL_WALLET_ID}> ?wallet ; <${CONTROL_LOCKED_JOB}> ?job ; <${CONTROL_LOCK_STATUS}> ${literal('active')} ; <${CONTROL_LOCK_EXPIRES_AT}> ?expiresAt . OPTIONAL { ?lock <${CONTROL_CLAIM_TOKEN}> ?claimToken } } }`,
      { source: 'publisher.asyncLift.walletLock.sweep' },
    );
    const expiredWallets: string[] = [];
    for (const row of expectBindings(result)) {
      const expiresAt = parseIntegerLiteral(row['expiresAt'] ?? '"0"');
      const walletId = parseLiteral(row['wallet'] ?? '""');
      if (typeof walletId !== 'string' || walletId.length === 0) continue;
      const jobRef = row['job'] ?? '';
      const jobId = this.jobIdFromRef(jobRef);
      const job = jobId ? await this.getStatus(jobId) : null;

      const stale =
        expiresAt <= now ||
        !job ||
        job.status === 'accepted' ||
        job.status === 'failed' ||
        job.status === 'finalized' ||
        job.claim?.walletId !== walletId;

      if (!stale) continue;
      expiredWallets.push(walletId);
      await this.deleteWalletLock(walletId);
    }
    return expiredWallets;
  }

  private async releaseWalletLockForJob(job: LiftJob): Promise<void> {
    const walletId = job.claim?.walletId;
    if (!walletId) return;
    const currentLock = await this.readWalletLock(walletId);
    if (!currentLock) return;
    if (!this.lockMatchesJob(currentLock, job)) return;
    await this.deleteWalletLock(walletId);
  }

  private async syncWalletLockForJob(job: LiftJob): Promise<void> {
    const walletId = job.claim?.walletId;
    if (!walletId) return;

    const currentLock = await this.readWalletLock(walletId);

    if (job.status === 'claimed' || job.status === 'validated' || job.status === 'broadcast' || job.status === 'included') {
      if (!currentLock) throw this.createStaleClaimError(job, `missing active wallet lock for ${walletId}`);
      if (!this.isUsableActiveLock(currentLock, job)) throw this.createStaleClaimError(job, `wallet lock mismatch for ${walletId}`);
      const acquiredAt = job.timestamps.claimedAt ?? this.now();
      const refreshedExpiry = job.claim?.claimLeaseExpiresAt ?? acquiredAt + this.lockLeaseMs;
      await this.writeWalletLock({
        walletId,
        jobId: job.jobId,
        acquiredAt,
        expiresAt: refreshedExpiry,
        status: 'active',
        claimToken: job.claim?.claimToken,
        lastHeartbeatAt: this.now(),
      });
      return;
    }

    if (currentLock && this.lockMatchesJob(currentLock, job)) {
      await this.deleteWalletLock(walletId);
    }
  }

  private async getRequiredJob(jobId: string): Promise<LiftJob> {
    const job = await this.getStatus(jobId);
    if (!job) throw new Error(`LiftJob not found: ${jobId}`);
    return job;
  }

  private async recordExecutionFailure(jobId: string, failedFromState: LiftJobState, error: unknown): Promise<LiftJob> {
    const current = await this.getRequiredJob(jobId);
    await this.assertActiveClaimLock(current);

    if (failedFromState === 'claimed' || failedFromState === 'validated') {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const errorCode = (error as { code?: unknown })?.code;
      const code =
        // GH#1786 — a no-send author-capability refusal, recognized by CODE (with the shared
        // marker fallback for a re-wrap that lost it) BEFORE the message chain below. That
        // chain would otherwise reach `canonicalization_failed`: this message contains none
        // of its keywords, and not even 'authority' — "UpdateAuthorAttestation" carries
        // "author", not "authority". Terminal either way, but the code is what clients
        // branch on and what tells an operator the publish is unfixable by retrying.
        isPermanentAuthorCapabilityFailure(error)
          ? 'authority_forbidden'
        : errorCode === 'PUBLISH_INTENT_STALE'
          ? 'publish_intent_stale'
          : lower.includes('timeout') || lower.includes('timed out') || lower.includes('unavailable') || lower.includes('query') || lower.includes('store')
          ? 'workspace_unavailable'
          : lower.includes('authority')
          ? 'authority_forbidden'
          : lower.includes('workspace') || lower.includes('root')
            ? 'workspace_slice_not_found'
            : 'canonicalization_failed';
      const failure = createLiftJobFailureMetadata({
        failedFromState,
        code,
        message,
        errorPayloadRef: `urn:dkg:publisher:error:${jobId}`,
      });
      const failed = this.scheduleRetryIfEligible(
        this.mergeJob(current, 'failed', { failure: failure as any }),
      );
      this.assertJobMatchesStatus(failed);
      await this.writeJob(failed, 'failed');
      await this.syncWalletLockForJob(failed);
      return failed;
    }

    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    return await this.recordPublishFailure(jobId, {
      error,
      failedFromState: failedFromState === 'included' ? 'included' : 'broadcast',
      errorPayloadRef: `urn:dkg:publisher:error:${jobId}`,
      timeout:
        lower.includes('timeout') || lower.includes('timed out')
          ? {
              timeoutMs: 0,
              timeoutAt: this.now(),
              handling: failedFromState === 'included' ? 'check_chain_then_finalize_or_reset' : 'check_chain_then_finalize_or_reset',
            }
          : undefined,
    });
  }

  private createKnowledgeAssetVmPublishBroadcastRecorder(params: {
    jobId: string;
    walletId: string;
    merkleRoot: LiftJobHex;
    publicByteSize?: number;
    delegate?: PhaseCallback;
  }): { onPhase: PhaseCallback; readonly outcome: PreSendOutcome } {
    // #1864 — the pre-send write-ahead outcome is tracked in this closure (like
    // `recordedTxHash`) rather than threaded as a mutable out-parameter through the publish
    // path. The processKnowledgeAssetVmPublish catch reads `.outcome` to decide recovery vs
    // terminal. It stays 'not-reached' unless the write-ahead hook actually fires.
    let outcome: PreSendOutcome = 'not-reached';
    let recordedTxHash: LiftJobHex | undefined;
    const onPhase: PhaseCallback = async (phase, status) => {
      await (params.delegate?.(phase, status) as unknown as Promise<void> | void);
      if (status !== 'start') return;
      const txHash = txHashFromSignedPhase(phase);
      if (!txHash || recordedTxHash) return;
      recordedTxHash = txHash;
      try {
        await this.recordKnowledgeAssetVmPublishBroadcastProgress({
          jobId: params.jobId,
          walletId: params.walletId,
          txHash,
          merkleRoot: params.merkleRoot,
          publicByteSize: params.publicByteSize,
        });
        // The transition is fsync-durable (or was already durable): the tx is about to send.
        outcome = 'recorded-durable';
      } catch (error) {
        // recordDurableBroadcastBeforeSend rolled the transition back before re-throwing (or
        // the write-ahead never durably mutated state): the tx was never sent.
        outcome = 'rolled-back-pre-send';
        throw error;
      }
    };
    return {
      onPhase,
      get outcome() {
        return outcome;
      },
    };
  }

  private async recordKnowledgeAssetVmPublishBroadcastProgress(params: {
    jobId: string;
    walletId: string;
    txHash: LiftJobHex;
    merkleRoot: LiftJobHex;
    publicByteSize?: number;
  }): Promise<void> {
    const current = await this.getRequiredJob(params.jobId);
    if (current.status === 'broadcast') return;
    if (current.status !== 'validated') {
      throw new Error(
        `Cannot record knowledge asset VM publish broadcast for job ${params.jobId} from status ${current.status}`,
      );
    }
    await this.recordDurableBroadcastBeforeSend(current, {
      txHash: params.txHash,
      walletId: params.walletId,
      merkleRoot: params.merkleRoot,
      publicByteSize: params.publicByteSize,
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
    broadcast: LiftJobBroadcastMetadata,
  ): Promise<void> {
    try {
      await this.update(current.jobId, 'broadcast', { broadcast });
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
    const payload = parseLiteral(binding);
    if (typeof payload !== 'string') return null;
    const parsed = JSON.parse(payload) as LiftJob & { request: unknown };
    return {
      ...parsed,
      request: normalizePersistedLiftJobRequest(parsed.request),
    } as LiftJob;
  }

  private buildClaimedJob(
    job: LiftJob,
    walletId: string,
    claimToken: string,
    now: number,
    lockExpiresAt: number,
  ): LiftJob {
    return {
      ...job,
      claim: {
        ...(job.claim ?? { walletId }),
        walletId,
        claimToken,
        claimLeaseExpiresAt: lockExpiresAt,
      },
      controlPlane: {
        ...job.controlPlane,
        walletLockRef: walletLockSubject(walletId),
      },
      timestamps: {
        ...job.timestamps,
        claimedAt: now,
        updatedAt: now,
      },
    } as LiftJob;
  }

  private refreshActiveLease(job: LiftJob): LiftJob {
    if (!job.claim) return job;
    if (job.status !== 'claimed' && job.status !== 'validated' && job.status !== 'broadcast' && job.status !== 'included') {
      return job;
    }

    const now = this.now();
    return {
      ...job,
      claim: {
        ...job.claim,
        claimLeaseExpiresAt: now + this.lockLeaseMs,
      },
      timestamps: {
        ...job.timestamps,
        updatedAt: now,
      },
    } as LiftJob;
  }

  private jobIdFromRef(jobRef: string): string | null {
    const prefix = 'urn:dkg:publisher:lift-job:';
    return jobRef.startsWith(prefix) ? jobRef.slice(prefix.length) : null;
  }

  private lockMatchesJob(
    lock: { jobId: string; claimToken?: string },
    job: LiftJob,
  ): boolean {
    if (lock.jobId !== job.jobId) return false;
    if (job.claim?.claimToken) return lock.claimToken === job.claim.claimToken;
    return !lock.claimToken;
  }

  private async assertActiveClaimLock(job: LiftJob): Promise<void> {
    if (!this.requiresActiveClaimLock(job)) return;

    const walletId = job.claim?.walletId;
    if (!walletId) throw this.createStaleClaimError(job, 'missing claim wallet');

    const currentLock = await this.readWalletLock(walletId);
    if (!currentLock) throw this.createStaleClaimError(job, `missing active wallet lock for ${walletId}`);
    if (!this.isUsableActiveLock(currentLock, job)) {
      throw this.createStaleClaimError(job, `wallet lock mismatch for ${walletId}`);
    }
  }

  private requiresActiveClaimLock(job: LiftJob): boolean {
    return job.status === 'claimed' || job.status === 'validated' || job.status === 'broadcast' || job.status === 'included';
  }

  private isUsableActiveLock(
    lock: { jobId: string; claimToken?: string; status?: string; expiresAt?: number },
    job: LiftJob,
  ): boolean {
    if (lock.status !== 'active') return false;
    if (lock.expiresAt !== undefined && lock.expiresAt <= this.now()) return false;
    return this.lockMatchesJob(lock, job);
  }

  private createStaleClaimError(job: LiftJob, reason: string): Error {
    return new Error(`Stale LiftJob claim for ${job.jobId}: ${reason}`);
  }

  private async withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = TripleStoreAsyncLiftPublisher.claimQueues.get(this.graphUri) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    TripleStoreAsyncLiftPublisher.claimQueues.set(this.graphUri, next);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (TripleStoreAsyncLiftPublisher.claimQueues.get(this.graphUri) === next) {
        TripleStoreAsyncLiftPublisher.claimQueues.delete(this.graphUri);
      }
    }
  }

  private mergeJob(current: LiftJob, status: LiftJobState, data: Partial<LiftJob>): LiftJob {
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

    return {
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
  }

  private resetJobToAccepted(
    job: LiftJob,
    action: Extract<LiftJobRecoveryMetadata['action'], 'reset_to_accepted'>,
    recoveredFromStatus: 'claimed' | 'validated' | 'broadcast',
    txHashChecked?: LiftJobHex,
  ): LiftJobAccepted {
    const now = this.now();
    return {
      jobId: job.jobId,
      jobSlug: job.jobSlug,
      request: job.request,
      status: 'accepted',
      timestamps: { acceptedAt: job.timestamps.acceptedAt, lastRecoveredAt: now, updatedAt: now },
      retries: job.retries,
      recovery: { action, recoveredFromStatus, txHashChecked },
      controlPlane: job.controlPlane,
    };
  }

  private resetFailedJobToAccepted(job: PersistedFailedJob): LiftJobAccepted {
    const now = this.now();
    const recoveredFromStatus =
      job.failure.failedFromState === 'claimed' || job.failure.failedFromState === 'validated' || job.failure.failedFromState === 'broadcast'
        ? job.failure.failedFromState
        : undefined;

    return {
      jobId: job.jobId,
      jobSlug: job.jobSlug,
      request: job.request,
      status: 'accepted',
      timestamps: {
        acceptedAt: job.timestamps.acceptedAt,
        lastRecoveredAt: now,
        updatedAt: now,
        lastRetriedAt: now,
      },
      retries: job.retries,
      recovery: recoveredFromStatus
        ? { action: 'reset_to_accepted', recoveredFromStatus, txHashChecked: getRecoveryTxHash(job) }
        : undefined,
      controlPlane: job.controlPlane,
    };
  }

  private isAutomaticallyRetryable(job: PersistedFailedJob): boolean {
    return getLiftJobFailurePolicy(job.failure.code).autoRetry === true
      && job.failure.retryable
      && job.failure.resolution === 'reset_to_accepted'
      && job.retries.retryCount < job.retries.maxRetries;
  }

  private async reacceptDueFailedJobs(now: number): Promise<number> {
    let retried = 0;
    for (const job of (await this.list({ status: 'failed' })).filter(isFailedJob)) {
      if (job.timestamps.nextRetryAt === undefined || job.timestamps.nextRetryAt > now) continue;
      if (!this.isAutomaticallyRetryable(job)) continue;
      await this.reacceptFailedJob(job);
      retried += 1;
    }
    return retried;
  }

  private scheduleRetryIfEligible(job: LiftJob): LiftJob {
    if (!isFailedJob(job) || !this.isAutomaticallyRetryable(job)) return job;
    const delay = Math.min(
      this.retryBackoffMaxMs,
      this.retryBackoffBaseMs * 2 ** job.retries.retryCount,
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

  private async reacceptFailedJob(job: PersistedFailedJob): Promise<LiftJobAccepted> {
    const reset = this.resetFailedJobToAccepted(job);
    const retriedAt = this.now();
    const reaccepted: LiftJobAccepted = {
      ...reset,
      retries: {
        ...reset.retries,
        retryCount: job.retries.retryCount + 1,
        lastRetryReason: job.failure.code,
      },
      timestamps: {
        ...reset.timestamps,
        lastRetriedAt: retriedAt,
        updatedAt: retriedAt,
      },
    };
    await this.releaseWalletLockForJob(job);
    await this.writeJob(reaccepted, 'reaccept');
    return reaccepted;
  }

  private finalizeRecoveredJob(
    job: LiftJobBroadcast | LiftJobIncluded,
    inclusion: LiftJobInclusionMetadata,
    finalization: LiftJobFinalizationMetadata,
  ): LiftJob {
    const now = this.now();
    return {
      ...job,
      status: 'finalized',
      inclusion,
      finalization,
      recovery: { action: 'finalized_from_chain', recoveredFromStatus: job.status, txHashChecked: job.broadcast.txHash },
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

  private async finalizeNoopPublish(jobId: string): Promise<LiftJob> {
    const current = await this.getRequiredJob(jobId);
    await this.assertActiveClaimLock(current);
    const finalized = this.mergeJob(current, 'finalized', {
      finalization: {
        mode: 'noop',
      },
    });
    this.assertJobMatchesStatus(finalized);
    await this.promoteFinalizedPrivateStaging(finalized);
    await this.writeJob(finalized, 'noop-finalized');
    await this.syncWalletLockForJob(finalized);
    return finalized;
  }

  private async finalizeKnowledgeAssetVmPublishNoop(
    jobId: string,
    request: LiftPublishSnapshotRequest,
    metadata: LiftPublishRequestMetadata,
  ): Promise<LiftJob> {
    const current = await this.getRequiredJob(jobId);
    if (!current.validation) {
      await this.update(jobId, 'validated', {
        validation: {
          canonicalRoots: [...request.roots],
          canonicalRootMap: Object.fromEntries(request.roots.map((root) => [root, root])),
          swmQuadCount: 0,
          authorityProofRef: metadata.authority.proofRef,
          transitionType: metadata.transitionType,
          ...(request.priorVersion ? { priorVersion: request.priorVersion } : {}),
        },
      });
    }
    return await this.finalizeNoopPublish(jobId);
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

function txHashFromSignedPhase(phase: string): LiftJobHex | null {
  const match = phase.match(/^chain:txsigned:tx-(0x[0-9a-fA-F]+)$/);
  return match ? (match[1] as LiftJobHex) : null;
}
