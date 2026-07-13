import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager, PrivateContentStore, tryUpdateWithTouchedGraphs } from '@origintrail-official/dkg-storage';
import { invokePhaseCallback, type PhaseCallback, type PublishResult } from './publisher.js';
import {
  LIFT_JOB_STATES,
  assertLiftJobTransition,
  createLiftJobFailureMetadata,
  getLiftJobFailurePolicy,
  type LiftJob,
  type LiftJobAccepted,
  type LiftJobBroadcast,
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
  type RawLiftRequest,
} from './lift-job.js';
import type {
  AsyncLiftPublisher,
  AsyncLiftPublisherConfig,
  AsyncLiftPublisherRecoveryResolver,
} from './async-lift-publisher-types.js';
import { AsyncLiftJobConflictError } from './async-lift-publisher-types.js';
import {
  mapPublishExceptionToLiftJobFailure,
  mapPublishResultToLiftJobSuccess,
  type AsyncLiftPublishFailureInput,
} from './async-lift-publish-result.js';
import { prepareAsyncPublishPayload, type AsyncPreparedPublishPayload, type LiftResolvedPublishSlice } from './async-lift-publish-options.js';
import { canonicalRootIri, validateLiftPublishPayload } from './async-lift-validation.js';
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
  PAYLOAD_PREDICATE,
  STATUS_PREDICATE,
  compareAcceptedJobs,
  createKnowledgeAssetVmPublishSnapshotMetadata,
  createKnowledgeAssetVmPublishSnapshotRequest,
  createKnowledgeAssetVmPublishJobRequest,
  createRawLiftJobRequest,
  createJobSlug,
  expectBindings,
  getRecoveryTxHash,
  isKnowledgeAssetVmPublishJobRequest,
  isFailedJob,
  normalizePersistedLiftJobRequest,
  rawLiftRequestFromJobRequest,
  jobSubject,
  literal,
  parseIntegerLiteral,
  parseLiteral,
  requestSubject,
  serializeJob,
  serializeWalletLock,
  walletLockSubject,
  type PersistedFailedJob,
} from './async-lift-publisher-utils.js';

type AsyncLiftJobHandler = {
  readonly inspectPreparedPayload: (job: LiftJob) => Promise<AsyncPreparedPublishPayload | null>;
  readonly process: (claimed: LiftJob, walletId: string) => Promise<LiftJob>;
  readonly recoverInterrupted: (job: LiftJob) => Promise<boolean>;
  readonly canRetryFailedRecovery: (job: PersistedFailedJob) => boolean;
  readonly shouldPromoteFinalizedPrivateStaging: (job: LiftJob) => boolean;
};

export class TripleStoreAsyncLiftPublisher implements AsyncLiftPublisher {
  private static readonly claimQueues = new Map<string, Promise<void>>();
  private static readonly jobWriteQueues = new Map<string, Promise<void>>();
  private static readonly DEFAULT_RECOVERY_LOOKUP_TIMEOUT_MS = 15 * 60 * 1000;
  private static readonly DEFAULT_MAX_RETRIES = 10;
  private static readonly DEFAULT_RETRY_BACKOFF_BASE_MS = 5_000;
  private static readonly DEFAULT_RETRY_BACKOFF_MAX_MS = 60_000;

  private readonly graphUri: string;
  private readonly walletLockGraphUri: string;
  private readonly maxRetries: number;
  private readonly retryBackoffBaseMs: number;
  private readonly retryBackoffMaxMs: number;
  private readonly recoveryLookupTimeoutMs: number;
  private readonly lockLeaseMs: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly chainRecoveryResolver?: AsyncLiftPublisherRecoveryResolver;
  private readonly publishExecutor?: AsyncLiftPublisherConfig['publishExecutor'];
  private readonly knowledgeAssetVmPublishExecutor?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishExecutor'];
  private readonly knowledgeAssetVmPublishPreflight?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishPreflight'];
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
    this.publishExecutor = config.publishExecutor;
    this.knowledgeAssetVmPublishExecutor = config.knowledgeAssetVmPublishExecutor;
    this.knowledgeAssetVmPublishPreflight = config.knowledgeAssetVmPublishPreflight;
    this.resolvedSliceOverrides = config.resolvedSliceOverrides;
    this.publicSnapshotStore = config.publicSnapshotStore;
    this.graphManager = new GraphManager(store);
  }

  async lift(request: RawLiftRequest): Promise<string> {
    await this.ensureGraph();

    const now = this.now();
    const jobId = this.idGenerator();
    const jobRequest = createRawLiftJobRequest(request);
    const job: LiftJobAccepted = {
      jobId,
      jobSlug: createJobSlug(jobRequest),
      request: jobRequest,
      status: 'accepted',
      timestamps: { acceptedAt: now, updatedAt: now },
      retries: { retryCount: 0, maxRetries: this.maxRetries },
      controlPlane: { jobRef: jobSubject(jobId) },
    };

    await this.writeJob(job);
    await this.stampCanonicalAnchorsInWorkspace(request);
    return jobId;
  }

  async enqueueKnowledgeAssetVmPublish(request: KnowledgeAssetVmPublishRequest): Promise<string> {
    return this.withClaimLock(async () => {
      await this.ensureGraph();
      if (!request.shareOperationId.trim()) {
        throw new Error('Knowledge asset VM publish requires a shareOperationId');
      }
      if (request.roots.length === 0) {
        throw new Error('Knowledge asset VM publish requires at least one shared root');
      }
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
      await this.writeJob(job);
      return jobId;
    });
  }

  // Adapt the lift's canonicalization to the SWM partition: for every
  // request root that already has private staging from the share, insert
  // a `<canonical> dkg:privateDataAnchor "true"` triple into
  // `<cg>/_shared_memory`. The canonical IRI is the same one the
  // validator will produce later (`dkg:<cg>:<ns>:<scope>/<name>-<hash>`)
  // when it canonicalizes the chain payload, so EPCIS partition-aware
  // queries can JOIN the public anchor in SWM with the canonical payload
  // that lands in `<cg>/_private` after `processNext` completes. The
  // source-IRI anchor stamped by `agent.publishAsync` stays in place for
  // legacy joins; this is purely additive.
  private async stampCanonicalAnchorsInWorkspace(request: RawLiftRequest): Promise<void> {
    if (!request.roots || request.roots.length === 0) return;
    const privateStore = new PrivateContentStore(this.store, this.graphManager);
    const swmGraph = this.graphManager.sharedMemoryUri(request.contextGraphId, request.subGraphName);
    const anchors: Quad[] = [];
    for (const sourceRoot of request.roots) {
      const staged = await privateStore.getPrivateTriplesForOperation(
        request.contextGraphId,
        request.shareOperationId,
        sourceRoot,
        request.subGraphName,
      );
      if (staged.length === 0) continue;
      const canonical = canonicalRootIri(request, sourceRoot);
      if (canonical === sourceRoot) continue;
      anchors.push({
        subject: canonical,
        predicate: 'http://dkg.io/ontology/privateDataAnchor',
        object: '"true"',
        graph: swmGraph,
      });
    }
    if (anchors.length > 0) {
      await this.store.insert(anchors);
    }
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
      await this.writeJob(claimedJob);
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
    await this.writeJob(next);
    await this.syncWalletLockForJob(next);
  }

  async getStatus(jobId: string): Promise<LiftJob | null> {
    await this.ensureGraph();
    const result = await this.store.query(
      `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { <${jobSubject(jobId)}> <${PAYLOAD_PREDICATE}> ?payload } }`,
    );
    const rows = expectBindings(result);
    if (rows.length === 0) return null;
    return this.parseJobPayload(rows[0]?.['payload']);
  }

  async list(filter: { status?: LiftJobState } = {}): Promise<LiftJob[]> {
    await this.ensureGraph();
    const statusFilter = filter.status ? `FILTER (?status = ${literal(filter.status)})` : '';
    const result = await this.store.query(
      `SELECT ?payload ?status WHERE { GRAPH <${this.graphUri}> { ?job <${STATUS_PREDICATE}> ?status ; <${PAYLOAD_PREDICATE}> ?payload . ${statusFilter} } }`,
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
    if (!this.knowledgeAssetVmPublishExecutor) {
      throw new Error('Async knowledge asset VM publish requires a configured knowledgeAssetVmPublishExecutor');
    }
    if (!isKnowledgeAssetVmPublishJobRequest(claimed.request)) {
      throw new Error(`LiftJob ${claimed.jobId} is not a knowledge asset VM publish job`);
    }
    const request = claimed.request.knowledgeAssetVmPublish;
    const snapshot = createKnowledgeAssetVmPublishSnapshotRequest(request);
    const snapshotMetadata = createKnowledgeAssetVmPublishSnapshotMetadata(request);
    const preflightInput = { walletId, request, snapshot, snapshotMetadata };

    let executorReturned = false;
    try {
      const preflight = await this.knowledgeAssetVmPublishPreflight?.(preflightInput);
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

    try {
      const preflight = await this.knowledgeAssetVmPublishPreflight?.(preflightInput);
      if (preflight?.action === 'noop') {
        return await this.finalizeKnowledgeAssetVmPublishNoop(claimed.jobId, snapshot, snapshotMetadata);
      }
      const publicByteSize = this.computePublicByteSize(prepared.publishOptions.quads);
      const onPhase = this.createKnowledgeAssetVmPublishBroadcastProgressCallback({
        jobId: claimed.jobId,
        walletId,
        merkleRoot: request.sealMerkleRoot,
        publicByteSize,
        delegate: prepared.publishOptions.onPhase,
      });
      const executionInput = {
        walletId,
        request,
        snapshot,
        snapshotMetadata,
        validation: validated.validation,
        resolved: validated.resolved,
        publishOptions: {
          ...prepared.publishOptions,
          onPhase,
        },
      };
      const publishResult = await this.knowledgeAssetVmPublishExecutor(executionInput);
      executorReturned = true;
      return await this.recordPublishResult(claimed.jobId, publishResult, {
        publicByteSize,
      });
    } catch (error) {
      const current = await this.getStatus(claimed.jobId);
      if (!executorReturned && current?.status === 'broadcast') {
        return current;
      }
      const failedFromState: LiftJobState = this.isKnowledgeAssetPublishPreconditionFailure(error)
        ? 'validated'
        : 'broadcast';
      return await this.recordExecutionFailure(claimed.jobId, failedFromState, error);
    }
  }

  private async recoverRawLiftInterrupted(job: LiftJob): Promise<boolean> {
    if (job.status !== 'broadcast' && job.status !== 'included') {
      return false;
    }
    if (!this.chainRecoveryResolver) {
      if (job.status === 'broadcast') {
        await this.releaseWalletLockForJob(job);
        await this.writeJob(this.resetJobToAccepted(job, 'reset_to_accepted', 'broadcast', getRecoveryTxHash(job)));
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
      await this.writeJob(finalized);
      return true;
    }
    if (this.hasInconclusiveRecoveryTimedOut(recoverable)) {
      await this.releaseWalletLockForJob(job);
      await this.writeJob(this.failInconclusiveRecovery(recoverable));
      return true;
    }
    return false;
  }

  private async recoverKnowledgeAssetVmPublishInterrupted(job: LiftJob): Promise<boolean> {
    if (job.status === 'broadcast') {
      const recoverable = job as LiftJobBroadcast;
      if (this.chainRecoveryResolver) {
        const resolved = await this.chainRecoveryResolver(recoverable);
        if (resolved || this.hasInconclusiveRecoveryTimedOut(recoverable)) {
          await this.releaseWalletLockForJob(job);
          await this.writeJob(this.failKnowledgeAssetInconclusiveRecovery(recoverable));
          return true;
        }
        return false;
      }
      if (!this.hasInconclusiveRecoveryTimedOut(recoverable)) {
        return false;
      }
      await this.releaseWalletLockForJob(job);
      await this.writeJob(this.failKnowledgeAssetInconclusiveRecovery(recoverable));
      return true;
    }
    if (job.status === 'included' && this.hasInconclusiveRecoveryTimedOut(job as LiftJobIncluded)) {
      await this.releaseWalletLockForJob(job);
      await this.writeJob(this.failKnowledgeAssetInconclusiveRecovery(job as LiftJobIncluded));
      return true;
    }
    return false;
  }

  private async findActiveKnowledgeAssetVmPublishJob(
    request: KnowledgeAssetVmPublishRequest,
  ): Promise<{ job: LiftJob; compatible: boolean } | null> {
    const jobs = await this.list();
    for (const job of jobs) {
      if (job.status === 'finalized') continue;
      if (isFailedJob(job)) {
        if (!job.failure.retryable || job.retries.retryCount >= job.retries.maxRetries) continue;
      }
      if (!isKnowledgeAssetVmPublishJobRequest(job.request)) continue;
      const publish = job.request.knowledgeAssetVmPublish;
      const sameLifecycleSubject = publish.contextGraphId === request.contextGraphId
        && publish.name === request.name
        && (publish.subGraphName ?? '') === (request.subGraphName ?? '')
        && agentAddressScopeKey(publish.agentAddress) === agentAddressScopeKey(request.agentAddress);
      if (!sameLifecycleSubject) continue;
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
      await this.writeJob(next);
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
      await this.writeJob(next);
      await this.syncWalletLockForJob(next);
    }

    if (mapped.status === 'included') {
      next = this.mergeJob(next, 'included', {
        broadcast: mapped.broadcast,
        inclusion: mapped.inclusion,
      });
      this.assertJobMatchesStatus(next);
      await this.writeJob(next);
      await this.syncWalletLockForJob(next);
      return next;
    }

    if (next.status === 'broadcast') {
      next = this.mergeJob(next, 'included', {
        broadcast: mapped.broadcast,
        inclusion: mapped.inclusion,
      });
      this.assertJobMatchesStatus(next);
      await this.writeJob(next);
      await this.syncWalletLockForJob(next);
    }

    next = this.mergeJob(next, 'finalized', {
      broadcast: mapped.broadcast,
      inclusion: mapped.inclusion,
      finalization: mapped.finalization,
    });
    this.assertJobMatchesStatus(next);
    await this.promoteFinalizedPrivateStaging(next);
    await this.writeJob(next);
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
    await this.writeJob(next);
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
        await this.writeJob(this.resetJobToAccepted(job, 'reset_to_accepted', job.status, getRecoveryTxHash(job)));
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
          await this.writeJob(finalized);
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
  }

  async clear(status: 'finalized' | 'failed'): Promise<number> {
    await this.ensureGraph();
    const jobs = await this.list({ status });
    let cleared = 0;
    for (const job of jobs) {
      // Protect retry_recovery jobs — they may still have a pending on-chain tx
      // that periodic recovery will finalize. Only explicit cancel can remove them.
      if (status === 'failed' && isFailedJob(job) && job.failure.resolution === 'retry_recovery') continue;
      await this.releaseWalletLockForJob(job);
      await this.deleteJob(job.jobId);
      cleared += 1;
    }
    return cleared;
  }

  private async ensureGraph(): Promise<void> {
    if (this.graphEnsured) return;
    await this.store.createGraph(this.graphUri);
    await this.store.createGraph(this.walletLockGraphUri);
    this.graphEnsured = true;
  }

  /**
   * Canonical job persistence boundary. Ordinary transitions retain the
   * legacy delete/insert path. Supplying expectedStatus upgrades that same
   * serializer to a server-side conditional replacement and reports whether
   * the exact payload committed, conflicted, or lacks store support.
   */
  private async writeJob(
    job: LiftJob,
    options: { expectedStatus?: LiftJobState; signal?: AbortSignal } = {},
  ): Promise<'written' | 'conflict' | 'unsupported'> {
    // The server-side conditional UPDATE is already atomic and must not hold
    // the process-local fallback lane while invoking the store: an adapter may
    // synchronously expose a concurrent writer from that boundary. Legacy
    // delete/insert writes still share the lane with the no-UPDATE fallback.
    if (options.expectedStatus !== undefined) return this.writeJobUnlocked(job, options);
    return this.withJobWriteLock(() => this.writeJobUnlocked(job, options));
  }

  private async writeJobUnlocked(
    job: LiftJob,
    options: { expectedStatus?: LiftJobState; signal?: AbortSignal } = {},
  ): Promise<'written' | 'conflict' | 'unsupported'> {
    if (options.expectedStatus === undefined) {
      await this.store.deleteByPattern({ subject: jobSubject(job.jobId), graph: this.graphUri });
      await this.store.insert(serializeJob(job, this.graphUri));
      return 'written';
    }

    const subject = jobSubject(job.jobId);
    const replacement = serializeJob(job, this.graphUri)
      .filter((quad) => quad.subject === subject)
      .map((quad) => `<${quad.subject}> <${quad.predicate}> ${quad.object} .`)
      .join('\n');
    const update = `
      DELETE { GRAPH <${this.graphUri}> { <${subject}> ?predicate ?object } }
      INSERT { GRAPH <${this.graphUri}> { ${replacement} } }
      WHERE {
        GRAPH <${this.graphUri}> {
          <${subject}> <${STATUS_PREDICATE}> ${literal(options.expectedStatus)} .
          <${subject}> ?predicate ?object .
        }
      }
    `;
    const supported = await tryUpdateWithTouchedGraphs(
      this.store,
      update,
      [this.graphUri],
      { signal: options.signal },
    );
    if (!supported) return 'unsupported';

    const persisted = await this.store.query(
      `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { <${subject}> <${PAYLOAD_PREDICATE}> ?payload } }`,
    );
    const payload = expectBindings(persisted)[0]?.['payload'];
    return payload === literal(JSON.stringify(job)) ? 'written' : 'conflict';
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
    );
    const rows = expectBindings(result);
    if (rows.length === 0) return false;
    return parseIntegerLiteral(rows[0]?.['expiresAt'] ?? '"0"') > now;
  }

  private async sweepStaleWalletLocks(): Promise<string[]> {
    const now = this.now();
    const result = await this.store.query(
      `SELECT ?wallet ?job ?expiresAt ?claimToken WHERE { GRAPH <${this.walletLockGraphUri}> { ?lock <${CONTROL_WALLET_ID}> ?wallet ; <${CONTROL_LOCKED_JOB}> ?job ; <${CONTROL_LOCK_STATUS}> ${literal('active')} ; <${CONTROL_LOCK_EXPIRES_AT}> ?expiresAt . OPTIONAL { ?lock <${CONTROL_CLAIM_TOKEN}> ?claimToken } } }`,
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
        errorCode === 'PUBLISH_INTENT_STALE'
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
      await this.writeJob(failed);
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

  private createKnowledgeAssetVmPublishBroadcastProgressCallback(params: {
    jobId: string;
    walletId: string;
    merkleRoot: LiftJobHex;
    publicByteSize?: number;
    delegate?: PhaseCallback;
  }): PhaseCallback {
    let recordedTxHash: LiftJobHex | undefined;
    return async (phase, status, context) => {
      await invokePhaseCallback(params.delegate, phase, status, context);
      // The EVM adapter invalidates this pre-broadcast attempt before it
      // rejects a timed-out hook. A delayed delegate must not turn the job into
      // `broadcast` after the associated transaction was explicitly abandoned.
      if (context?.signal?.aborted) return;
      if (status !== 'start') return;
      // Prefer the typed write-ahead context, while retaining the previously
      // supported hash-bearing phase for custom executors that have not yet
      // adopted it. Both paths pass through the same guarded transition.
      const legacyMatch = /^chain:txsigned:tx-(0x[0-9a-fA-F]{64})$/.exec(phase);
      const candidateTxHash = phase === 'chain:writeahead'
        ? context?.txHash
        // The built-in publisher explicitly marks its observability breadcrumb
        // because a typed durability event follows. Unmarked breadcrumbs from
        // custom legacy executors retain the original recovery fallback.
        : context?.compatibilityBreadcrumb !== true
          ? legacyMatch?.[1]
          : undefined;
      if (
        recordedTxHash
        || !candidateTxHash
        || !/^0x[0-9a-fA-F]{64}$/.test(candidateTxHash)
      ) return;
      const txHash = candidateTxHash as LiftJobHex;
      const recorded = await this.recordKnowledgeAssetVmPublishBroadcastProgress({
        jobId: params.jobId,
        walletId: params.walletId,
        txHash,
        merkleRoot: params.merkleRoot,
        publicByteSize: params.publicByteSize,
        signal: context?.signal,
      });
      if (recorded) recordedTxHash = txHash;
    };
  }

  private async recordKnowledgeAssetVmPublishBroadcastProgress(params: {
    jobId: string;
    walletId: string;
    txHash: LiftJobHex;
    merkleRoot: LiftJobHex;
    publicByteSize?: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    if (params.signal?.aborted) return false;
    const current = await this.getRequiredJob(params.jobId);
    if (params.signal?.aborted) return false;
    if (current.status === 'broadcast') return true;
    if (current.status !== 'validated') {
      throw new Error(
        `Cannot record knowledge asset VM publish broadcast for job ${params.jobId} from status ${current.status}`,
      );
    }
    return this.transitionJobIfActive({
      current,
      expectedStatus: 'validated',
      status: 'broadcast',
      data: {
        broadcast: {
          txHash: params.txHash,
          walletId: params.walletId,
          merkleRoot: params.merkleRoot,
          publicByteSize: params.publicByteSize,
        },
      },
      signal: params.signal,
    });
  }

  /**
   * Atomically replace one job only while it is still in the expected state.
   * Cancellation is checked at this commit boundary and passed to the store;
   * there is no observable write-then-rollback state.
   */
  private async transitionJobIfActive(params: {
    current: LiftJob;
    expectedStatus: LiftJobState;
    status: LiftJobState;
    data: Partial<LiftJob>;
    signal?: AbortSignal;
  }): Promise<boolean> {
    if (params.signal?.aborted) return false;
    await this.assertActiveClaimLock(params.current);
    if (params.signal?.aborted) return false;

    const next = this.refreshActiveLease(this.mergeJob(params.current, params.status, params.data));
    this.assertJobMatchesStatus(next);
    if (params.signal?.aborted) return false;
    const writeResult = await this.writeJob(next, {
      expectedStatus: params.expectedStatus,
      signal: params.signal,
    });
    if (writeResult === 'unsupported') return this.transitionJobWithoutStoreUpdate(params);

    const committed = await this.getRequiredJob(next.jobId);
    if (writeResult === 'conflict') {
      if (params.signal?.aborted) return false;
      throw new Error(
        `Async-lift job ${next.jobId} changed from ${params.expectedStatus} before the ${next.status} transition`,
      );
    }
    await this.syncWalletLockForJob(committed);
    return true;
  }

  /**
   * Compatibility path for TripleStore implementations that predate optional
   * SPARQL UPDATE support. It serializes the compare/re-read/write sequence
   * across publisher instances in this process and reuses the canonical job
   * writer. Backends with update() continue to use the server-side atomic CAS
   * above, including across processes.
   */
  private async transitionJobWithoutStoreUpdate(params: {
    current: LiftJob;
    expectedStatus: LiftJobState;
    status: LiftJobState;
    data: Partial<LiftJob>;
    signal?: AbortSignal;
  }): Promise<boolean> {
    return this.withClaimLock(async () => {
      return this.withJobWriteLock(async () => {
        if (params.signal?.aborted) return false;
        const current = await this.getRequiredJob(params.current.jobId);
        if (params.signal?.aborted) return false;
        if (current.status !== params.expectedStatus) {
          throw new Error(
            `Async-lift job ${current.jobId} changed from ${params.expectedStatus} before the ${params.status} transition`,
          );
        }
        await this.assertActiveClaimLock(current);
        if (params.signal?.aborted) return false;

        const next = this.refreshActiveLease(this.mergeJob(current, params.status, params.data));
        this.assertJobMatchesStatus(next);
        await this.writeJobUnlocked(next);
        await this.syncWalletLockForJob(next);
        return true;
      });
    });
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

  /**
   * Process-local persistence lane shared by every job write for this graph.
   * The no-SPARQL-update compatibility CAS holds it across re-read + replace;
   * ordinary writers enter through writeJob(), so none can interleave inside
   * that fallback commit window. Server-side UPDATE remains the cross-process
   * atomic path when the backend supports it.
   */
  private async withJobWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = TripleStoreAsyncLiftPublisher.jobWriteQueues.get(this.graphUri) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    TripleStoreAsyncLiftPublisher.jobWriteQueues.set(this.graphUri, next);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (TripleStoreAsyncLiftPublisher.jobWriteQueues.get(this.graphUri) === next) {
        TripleStoreAsyncLiftPublisher.jobWriteQueues.delete(this.graphUri);
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
    await this.writeJob(reaccepted);
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
    await this.writeJob(finalized);
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

function agentAddressScopeKey(agentAddress?: string): string {
  return agentAddress?.trim().toLowerCase() ?? '';
}
