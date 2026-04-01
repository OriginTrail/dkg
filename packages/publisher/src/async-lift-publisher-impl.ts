import type { TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import type { PublishResult } from './publisher.js';
import {
  LIFT_JOB_STATES,
  assertLiftJobTransition,
  createLiftJobFailureMetadata,
  type LiftJob,
  type LiftJobAccepted,
  type LiftJobBroadcast,
  type LiftJobHex,
  type LiftJobIncluded,
  type LiftJobInclusionMetadata,
  type LiftJobFinalizationMetadata,
  type LiftJobRecoveryMetadata,
  type LiftJobState,
  type LiftRequest,
} from './lift-job.js';
import type {
  AsyncLiftPublisher,
  AsyncLiftPublisherConfig,
  AsyncLiftPublisherRecoveryResolver,
} from './async-lift-publisher-types.js';
import {
  mapPublishExceptionToLiftJobFailure,
  mapPublishResultToLiftJobSuccess,
  type AsyncLiftPublishFailureInput,
} from './async-lift-publish-result.js';
import { prepareAsyncPublishPayload, type LiftResolvedPublishSlice } from './async-lift-publish-options.js';
import { validateLiftPublishPayload } from './async-lift-validation.js';
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
  createJobSlug,
  expectBindings,
  getRecoveryTxHash,
  isFailedJob,
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

export class TripleStoreAsyncLiftPublisher implements AsyncLiftPublisher {
  private static readonly claimQueues = new Map<string, Promise<void>>();

  private readonly graphUri: string;
  private readonly walletLockGraphUri: string;
  private readonly maxRetries: number;
  private readonly lockLeaseMs: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly chainRecoveryResolver?: AsyncLiftPublisherRecoveryResolver;
  private readonly publishExecutor?: AsyncLiftPublisherConfig['publishExecutor'];
  private readonly resolvedSliceOverrides?: Partial<LiftResolvedPublishSlice>;
  private readonly graphManager: GraphManager;
  private paused = false;
  private graphEnsured = false;

  constructor(
    private readonly store: TripleStore,
    config: AsyncLiftPublisherConfig = {},
  ) {
    this.graphUri = config.graphUri ?? DEFAULT_GRAPH_URI;
    this.walletLockGraphUri = DEFAULT_WALLET_LOCK_GRAPH_URI;
    this.maxRetries = config.maxRetries ?? 3;
    this.lockLeaseMs = 5 * 60 * 1000;
    this.now = config.now ?? (() => Date.now());
    this.idGenerator = config.idGenerator ?? (() => crypto.randomUUID());
    this.chainRecoveryResolver = config.chainRecoveryResolver;
    this.publishExecutor = config.publishExecutor;
    this.resolvedSliceOverrides = config.resolvedSliceOverrides;
    this.graphManager = new GraphManager(store);
  }

  async lift(request: LiftRequest): Promise<string> {
    await this.ensureGraph();

    const now = this.now();
    const jobId = this.idGenerator();
    const job: LiftJobAccepted = {
      jobId,
      jobSlug: createJobSlug(request),
      request,
      status: 'accepted',
      timestamps: { acceptedAt: now, updatedAt: now },
      retries: { retryCount: 0, maxRetries: this.maxRetries },
      controlPlane: { jobRef: jobSubject(jobId) },
    };

    await this.writeJob(job);
    return jobId;
  }

  async claimNext(walletId: string): Promise<LiftJob | null> {
    return this.withClaimLock(async () => {
      await this.ensureGraph();
      if (this.paused) return null;
      if (await this.hasActiveWalletLock(walletId)) return null;

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
    const next = this.refreshActiveLease(this.mergeJob(await this.getRequiredJob(jobId), status, data));
    this.assertJobMatchesStatus(next);
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

  async processNext(walletId: string): Promise<LiftJob | null> {
    if (!this.publishExecutor) {
      throw new Error('Async lift publisher processNext requires a configured publishExecutor');
    }

    const claimed = await this.claimNext(walletId);
    if (!claimed) {
      return null;
    }

    let failureState: LiftJobState = claimed.status;
    try {
      const resolved = await resolveLiftWorkspaceSlice({
        store: this.store,
        graphManager: this.graphManager,
        request: claimed.request,
      });
      const validated = validateLiftPublishPayload({
        request: claimed.request,
        resolved: {
          ...resolved,
          ...this.resolvedSliceOverrides,
        },
      });

      await this.update(claimed.jobId, 'validated', {
        validation: validated.validation,
      });
      failureState = 'validated';

      const prepared = prepareAsyncPublishPayload({
        request: claimed.request,
        validation: validated.validation,
        resolved: validated.resolved,
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

    const mapped = mapPublishResultToLiftJobSuccess({
      publishResult,
      walletId: current.claim.walletId,
      publicByteSize: options.publicByteSize,
    });

    let next: LiftJob = current;
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
    await this.writeJob(next);
    await this.syncWalletLockForJob(next);
    return next;
  }

  async recordPublishFailure(jobId: string, failure: AsyncLiftPublishFailureInput): Promise<LiftJob> {
    await this.ensureGraph();
    const current = await this.getRequiredJob(jobId);
    const next = this.mergeJob(current, 'failed', {
      failure: mapPublishExceptionToLiftJobFailure(failure) as any,
    });
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

      if ((job.status === 'broadcast' || job.status === 'included') && this.chainRecoveryResolver) {
        const resolved = await this.chainRecoveryResolver(job);
        if (resolved) {
          await this.releaseWalletLockForJob(job);
          await this.writeJob(this.finalizeRecoveredJob(job, resolved.inclusion, resolved.finalization));
          recovered += 1;
          continue;
        }
      }

      if (job.status === 'broadcast') {
        await this.releaseWalletLockForJob(job);
        await this.writeJob(this.resetJobToAccepted(job, 'reset_to_accepted', 'broadcast', getRecoveryTxHash(job)));
        recovered += 1;
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

      const reset = this.resetFailedJobToAccepted(job);
      const retriedAt = this.now();
      const retriedJob: LiftJobAccepted = {
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
      await this.writeJob(retriedJob);
      retried += 1;
    }
    return retried;
  }

  async clear(status: 'finalized' | 'failed'): Promise<number> {
    await this.ensureGraph();
    const jobs = await this.list({ status });
    for (const job of jobs) {
      await this.releaseWalletLockForJob(job);
      await this.deleteJob(job.jobId);
    }
    return jobs.length;
  }

  private async ensureGraph(): Promise<void> {
    if (this.graphEnsured) return;
    await this.store.createGraph(this.graphUri);
    await this.store.createGraph(this.walletLockGraphUri);
    this.graphEnsured = true;
  }

  private async writeJob(job: LiftJob): Promise<void> {
    await this.store.deleteByPattern({ subject: jobSubject(job.jobId), graph: this.graphUri });
    await this.store.insert(serializeJob(job, this.graphUri));
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
      if (currentLock && !this.lockMatchesJob(currentLock, job)) {
        return;
      }
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

    if (failedFromState === 'claimed' || failedFromState === 'validated') {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const code =
        lower.includes('timeout') || lower.includes('timed out') || lower.includes('unavailable') || lower.includes('query') || lower.includes('store')
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
      const failed = this.mergeJob(current, 'failed', { failure: failure as any });
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

  private parseJobPayload(binding?: string): LiftJob | null {
    if (!binding) return null;
    const payload = parseLiteral(binding);
    if (typeof payload !== 'string') return null;
    return JSON.parse(payload) as LiftJob;
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
    if (job.claim?.claimToken && lock.claimToken) {
      return lock.claimToken === job.claim.claimToken;
    }
    return true;
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
        includedAt: job.timestamps.includedAt ?? now,
        finalizedAt: now,
        lastRecoveredAt: now,
        updatedAt: now,
      },
    } as LiftJob;
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
        if (!job.claim || !job.validation || !job.broadcast || !job.inclusion || !job.finalization) {
          throw new Error('Finalized LiftJob requires claim, validation, broadcast, inclusion, and finalization metadata');
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
