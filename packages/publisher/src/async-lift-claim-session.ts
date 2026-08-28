import type { PublishResult } from './publisher.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type {
  JournalKind,
  LiftJob,
  LiftJobAccepted,
  LiftJobClaimed,
  LiftJobState,
} from './lift-job.js';
import type {
  ActiveLiftJobClaim,
  ActiveLiftJobClaimSession,
} from './async-lift-publisher-types.js';
import { StaleLiftJobClaimError } from './async-lift-publisher-types.js';
import { isHeldForChainProof } from './async-lift-retry-disposition.js';
import { replaceSubjectAtomicallyOrFallback } from './subject-atomic-write.js';
import { withKeyedLocks } from './keyed-lock.js';
import {
  CONTROL_CLAIM_TOKEN,
  CONTROL_LOCKED_JOB,
  CONTROL_LOCK_EXPIRES_AT,
  CONTROL_LOCK_STATUS,
  CONTROL_WALLET_ID,
  compareAcceptedJobs,
  expectBindings,
  isFailedJob,
  liftJobCheckedSigner,
  literal,
  parseIntegerLiteral,
  parseLiteral,
  serializeWalletLock,
  walletLockSubject,
} from './async-lift-publisher-utils.js';

export interface ActiveLiftJobClaimTransitionBoundary {
  run<T>(transition: (current: LiftJob, scope: LiftJobTransitionScope) => Promise<T>): Promise<T>;
}

export interface LiftJobTransitionScope {
  commit(job: LiftJob, kind: JournalKind): Promise<LiftJob>;
}

export interface ActiveLiftJobClaimMutations {
  update(
    current: LiftJob,
    scope: LiftJobTransitionScope,
    status: LiftJobState,
    data?: Partial<LiftJob>,
  ): Promise<void>;
  recordPublishResult(
    current: LiftJob,
    scope: LiftJobTransitionScope,
    publishResult: PublishResult,
    options?: { publicByteSize?: number },
  ): Promise<LiftJob>;
  recordExecutionFailure(
    current: LiftJob,
    scope: LiftJobTransitionScope,
    failedFromState: LiftJobState,
    error: unknown,
  ): Promise<LiftJob>;
}

/**
 * Claim-bound transition authority. Every operation crosses the same ownership boundary before
 * its state-specific mutation runs; callers cannot accidentally fall back to a by-id write.
 */
export class DefaultActiveLiftJobClaimSession implements ActiveLiftJobClaimSession {
  constructor(
    readonly claim: ActiveLiftJobClaim,
    private readonly boundary: ActiveLiftJobClaimTransitionBoundary,
    private readonly mutations: ActiveLiftJobClaimMutations,
  ) {}

  async update(status: LiftJobState, data: Partial<LiftJob> = {}): Promise<void> {
    await this.boundary.run(async (current, scope) => {
      await this.mutations.update(current, scope, status, data);
    });
  }

  async recordPublishResult(
    publishResult: PublishResult,
    options: { publicByteSize?: number } = {},
  ): Promise<LiftJob> {
    return await this.boundary.run(
      async (current, scope) =>
        await this.mutations.recordPublishResult(current, scope, publishResult, options),
    );
  }

  async recordExecutionFailure(failedFromState: LiftJobState, error: unknown): Promise<LiftJob> {
    return await this.boundary.run(
      async (current, scope) =>
        await this.mutations.recordExecutionFailure(current, scope, failedFromState, error),
    );
  }
}

interface WalletLockSnapshot {
  readonly walletId: string;
  readonly jobId: string;
  readonly claimToken?: string;
  readonly status: string;
  readonly expiresAt?: number;
}

export type AsyncLiftClaimProcessingRelease =
  | { readonly kind: 'processed'; readonly job: LiftJob }
  | { readonly kind: 'replaced'; readonly job: LiftJob }
  | { readonly kind: 'stale' }
  | { readonly kind: 'faulted' };

export type AsyncLiftClaimProcessingOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'processed'; readonly job: LiftJob }
  | { readonly kind: 'replaced'; readonly job: LiftJob }
  | { readonly kind: 'recovered'; readonly job: LiftJob | null };

export interface AsyncLiftClaimCoordinatorDependencies {
  readonly ensureGraph: () => Promise<void>;
  readonly isPaused: () => boolean;
  readonly getStatus: (jobId: string) => Promise<LiftJob | null>;
  readonly listAccepted: () => Promise<LiftJobAccepted[]>;
  readonly reacceptDueFailedJobs: (now: number) => Promise<unknown>;
  readonly toClaimed: (current: LiftJobAccepted, walletId: string) => LiftJobClaimed;
  readonly writeJob: (
    job: LiftJob,
    kind: JournalKind,
  ) => Promise<void>;
  readonly assertJobMatchesStatus: (job: LiftJob) => void;
  readonly resetInterruptedClaim: (job: LiftJob) => LiftJobAccepted;
  readonly notifyWalletRelease: (walletId: string) => void;
  readonly mutations: ActiveLiftJobClaimMutations;
}

export interface AsyncLiftClaimCoordinatorConfig {
  readonly graphUri: string;
  readonly walletLockGraphUri: string;
  readonly now: () => number;
  readonly claimTokenGenerator: () => string;
  readonly lockLeaseMs?: number;
}

/**
 * Cohesive owner of the lift-job claim lifecycle.
 *
 * Lock ordering, acquisition, active-process bookkeeping, token fencing, wallet-lock durability,
 * lease renewal, stale-lock sweeping and pre-broadcast recovery all live here. The publisher owns
 * publish-state mutations, but can execute them only through the claim session returned by this
 * coordinator.
 */
export class AsyncLiftClaimCoordinator {
  private static readonly claimQueues = new Map<string, Promise<void>>();
  private static readonly jobTransitionQueues = new Map<string, Promise<void>>();

  /** Latest in-process claim epoch for each job; stale epochs may overlap while unwinding. */
  private readonly activeProcessClaimTokens = new Map<string, string>();
  private readonly lockLeaseMs: number;

  constructor(
    private readonly store: TripleStore,
    private readonly config: AsyncLiftClaimCoordinatorConfig,
    private readonly dependencies: AsyncLiftClaimCoordinatorDependencies,
  ) {
    this.lockLeaseMs = config.lockLeaseMs ?? 5 * 60 * 1000;
  }

  async claimNext(
    walletId: string,
  ): Promise<ActiveLiftJobClaim | null> {
    return await this.claimNextInternal(walletId, false);
  }

  private async claimNextInternal(
    walletId: string,
    markProcessing: boolean,
  ): Promise<ActiveLiftJobClaim | null> {
    return await this.withClaimLock(async () => {
      await this.dependencies.ensureGraph();
      if (this.dependencies.isPaused()) return null;
      if (await this.hasActiveWalletLock(walletId)) return null;

      await this.dependencies.reacceptDueFailedJobs(this.config.now());
      const next = (await this.dependencies.listAccepted()).sort(compareAcceptedJobs)[0];
      if (!next) return null;
      const claimedJob = await this.withJobTransitionLock(next.jobId, async () => {
        const current = await this.dependencies.getStatus(next.jobId);
        if (!current || current.status !== 'accepted') return null;
        const now = this.config.now();
        const tokenNonce = this.config.claimTokenGenerator();
        if (typeof tokenNonce !== 'string' || tokenNonce.length === 0) {
          throw new Error('claimTokenGenerator must return a non-empty string');
        }
        const claimToken = `${walletId}:${current.jobId}:${tokenNonce}`;
        const lockExpiresAt = now + this.lockLeaseMs;
        const claimed = this.dependencies.toClaimed(current, walletId);
        const owned = this.buildActiveClaim(
          claimed,
          walletId,
          claimToken,
          now,
          lockExpiresAt,
        );

        this.dependencies.assertJobMatchesStatus(owned);
        await this.dependencies.writeJob(owned, 'claimed');
        await this.writeWalletLock({
          walletId,
          jobId: owned.jobId,
          acquiredAt: now,
          expiresAt: lockExpiresAt,
          status: 'active',
          claimToken,
          lastHeartbeatAt: now,
        });
        return owned;
      });
      if (!claimedJob) return null;
      if (markProcessing) {
        this.activeProcessClaimTokens.set(claimedJob.jobId, claimedJob.claim.claimToken);
      }
      return claimedJob;
    });
  }

  /** Claim, process, classify stale ownership, recover unchanged claims, and always clear marker. */
  async processClaim(
    walletId: string,
    handler: (session: ActiveLiftJobClaimSession) => Promise<LiftJob>,
    onProcessingReleased?: (release: AsyncLiftClaimProcessingRelease) => void,
  ): Promise<AsyncLiftClaimProcessingOutcome> {
    const claim = await this.claimNextInternal(walletId, true);
    if (!claim) return { kind: 'idle' };

    let outcome: AsyncLiftClaimProcessingOutcome | undefined;
    let release: AsyncLiftClaimProcessingRelease = { kind: 'faulted' };
    let recoverUnreplacedClaim = false;
    try {
      try {
        const job = await handler(this.openSession(claim));
        outcome = { kind: 'processed', job };
        release = outcome;
      } catch (error) {
        if (!(error instanceof StaleLiftJobClaimError)) throw error;
        const current = await this.dependencies.getStatus(claim.jobId);
        if (current && !this.claimFenceMatches(current, claim)) {
          outcome = { kind: 'replaced', job: current };
          release = outcome;
        } else {
          recoverUnreplacedClaim = true;
          release = { kind: 'stale' };
        }
      }
    } finally {
      if (this.activeProcessClaimTokens.get(claim.jobId) === claim.claim.claimToken) {
        this.activeProcessClaimTokens.delete(claim.jobId);
      }
      try {
        onProcessingReleased?.(release);
      } catch {
        // Scheduling observers cannot change claim cleanup or business outcomes.
      }
    }

    if (recoverUnreplacedClaim) {
      return {
        kind: 'recovered',
        job: await this.recoverUnreplacedExpiredClaim(claim),
      };
    }
    if (!outcome) {
      throw new Error(`Claim processing for ${claim.jobId} completed without an outcome`);
    }
    return outcome;
  }

  openSession(claim: ActiveLiftJobClaim): ActiveLiftJobClaimSession {
    return new DefaultActiveLiftJobClaimSession(
      claim,
      {
        run: async (transition) => await this.transitionOwned(claim, transition),
      },
      this.dependencies.mutations,
    );
  }

  isProcessing(jobId: string): boolean {
    return this.activeProcessClaimTokens.has(jobId);
  }

  private claimFenceMatches(job: LiftJob, expected: ActiveLiftJobClaim): boolean {
    return job.claim?.walletId === expected.claim.walletId
      && job.claim.claimToken === expected.claim.claimToken;
  }

  private async recoverUnreplacedExpiredClaim(claim: ActiveLiftJobClaim): Promise<LiftJob | null> {
    await this.dependencies.ensureGraph();
    return await this.withClaimLock(() => this.withJobTransitionLock(claim.jobId, async () => {
      const current = await this.dependencies.getStatus(claim.jobId);
      if (!current) return null;
      if (!this.claimFenceMatches(current, claim)) return current;
      if (current.status !== 'claimed' && current.status !== 'validated') return current;
      if (await this.isJobOwnershipActive(current)) return current;

      const reset = this.dependencies.resetInterruptedClaim(current);
      await this.dependencies.writeJob(reset, 'recover-reset');
      await this.releaseJobOwnership(current);
      return reset;
    }));
  }

  /**
   * Commit one lifecycle transition through the coordinator-owned persistence boundary.
   * Lease renewal, shape validation, the durable job write, and wallet synchronization cannot
   * be assembled independently by publisher call sites.
   */
  private async commitTransition(job: LiftJob, kind: JournalKind): Promise<LiftJob> {
    const next = this.renewActiveOwnership(job);
    this.dependencies.assertJobMatchesStatus(next);
    await this.dependencies.writeJob(next, kind);
    await this.persistOwnershipState(next);
    return next;
  }

  private renewActiveOwnership(job: LiftJob): LiftJob {
    if (!job.claim) return job;
    if (
      job.status !== 'claimed'
      && job.status !== 'validated'
      && job.status !== 'broadcast'
      && job.status !== 'included'
    ) return job;

    const now = this.config.now();
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

  private async assertActiveClaimLock(job: LiftJob): Promise<void> {
    if (!this.requiresActiveClaimLock(job)) return;
    const walletId = job.claim?.walletId;
    if (!walletId) throw this.createStaleClaimError(job, 'missing claim wallet');
    const currentLock = await this.readWalletLock(walletId);
    if (!currentLock) {
      throw this.createStaleClaimError(job, `missing active wallet lock for ${walletId}`);
    }
    if (!this.isUsableActiveLock(currentLock, job)) {
      throw this.createStaleClaimError(job, `wallet lock mismatch for ${walletId}`);
    }
  }

  async isJobOwnershipActive(job: LiftJob): Promise<boolean> {
    const walletId = job.claim?.walletId;
    if (!walletId) return false;
    const currentLock = await this.readWalletLock(walletId);
    return currentLock !== null && this.isUsableActiveLock(currentLock, job);
  }

  async releaseJobOwnership(job: LiftJob): Promise<void> {
    const walletId = job.claim?.walletId;
    if (!walletId) return;
    const currentLock = await this.readWalletLock(walletId);
    if (!currentLock) {
      // A stale sweep can release before the job reset becomes visible. Re-invite after the
      // caller's write so the now-claimable job is not parked until an idle sweep.
      this.dependencies.notifyWalletRelease(walletId);
      return;
    }
    if (!this.lockMatchesJob(currentLock, job)) return;
    await this.deleteWalletLock(walletId);
  }

  private async persistOwnershipState(job: LiftJob): Promise<void> {
    const walletId = job.claim?.walletId;
    if (!walletId) return;
    const currentLock = await this.readWalletLock(walletId);

    if (
      job.status === 'claimed'
      || job.status === 'validated'
      || job.status === 'broadcast'
      || job.status === 'included'
      || (isFailedJob(job) && isHeldForChainProof(job))
    ) {
      if (!currentLock) {
        throw this.createStaleClaimError(job, `missing active wallet lock for ${walletId}`);
      }
      if (!this.isUsableActiveLock(currentLock, job)) {
        throw this.createStaleClaimError(job, `wallet lock mismatch for ${walletId}`);
      }
      const acquiredAt = job.timestamps.claimedAt ?? this.config.now();
      const refreshedExpiry = job.claim?.claimLeaseExpiresAt ?? acquiredAt + this.lockLeaseMs;
      await this.writeWalletLock({
        walletId,
        jobId: job.jobId,
        acquiredAt,
        expiresAt: refreshedExpiry,
        status: 'active',
        claimToken: job.claim?.claimToken,
        lastHeartbeatAt: this.config.now(),
      });
      return;
    }

    if (currentLock && this.lockMatchesJob(currentLock, job)) {
      await this.deleteWalletLock(walletId);
    }
  }

  async sweepStaleOwnership(): Promise<string[]> {
    const now = this.config.now();
    const result = await this.store.query(
      `SELECT ?wallet ?job ?expiresAt ?claimToken WHERE { GRAPH <${this.config.walletLockGraphUri}> { ?lock <${CONTROL_WALLET_ID}> ?wallet ; <${CONTROL_LOCKED_JOB}> ?job ; <${CONTROL_LOCK_STATUS}> ${literal('active')} ; <${CONTROL_LOCK_EXPIRES_AT}> ?expiresAt . OPTIONAL { ?lock <${CONTROL_CLAIM_TOKEN}> ?claimToken } } }`,
      { source: 'publisher.asyncLift.walletLock.sweep' },
    );
    const expiredWallets: string[] = [];
    for (const row of expectBindings(result)) {
      const walletId = parseLiteral(row['wallet'] ?? '""');
      if (typeof walletId !== 'string' || walletId.length === 0) continue;
      const jobId = this.jobIdFromRef(row['job'] ?? '');
      if (!jobId) {
        await this.withClaimLock(async () => {
          if (await this.readWalletLock(walletId)) return;
          expiredWallets.push(walletId);
          await this.deleteWalletLock(walletId);
        });
        continue;
      }
      await this.withClaimLock(() => this.withJobTransitionLock(jobId, async () => {
        const currentLock = await this.readWalletLock(walletId);
        if (!currentLock || currentLock.jobId !== jobId) return;
        const job = await this.dependencies.getStatus(jobId);
        const proofBoundOwner = !!job && this.isProofBoundWalletOwner(currentLock, job, walletId);
        const stale =
          (!proofBoundOwner && (currentLock.expiresAt ?? 0) <= now)
          || !job
          || job.status === 'accepted'
          || (!proofBoundOwner && job.status === 'failed')
          || job.status === 'finalized'
          || job.claim?.walletId !== walletId;
        if (!stale) return;
        expiredWallets.push(walletId);
        await this.deleteWalletLock(walletId);
      }));
    }
    return expiredWallets;
  }

  /** Serialize a control-plane operation in canonical global-claim lock order. */
  async runClaimTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return await this.withClaimLock(operation);
  }

  /** Serialize a non-session operation for one job without exposing the lock primitive. */
  async runJobTransaction<T>(
    jobId: string,
    operation: (scope: LiftJobTransitionScope) => Promise<T>,
  ): Promise<T> {
    await this.dependencies.ensureGraph();
    return await this.withJobTransitionLock(
      jobId,
      async () => await operation(this.createTransitionScope()),
    );
  }

  /** Canonical administrative transition boundary: lock, re-read, and validate live ownership. */
  async transitionAdministrative<T>(
    jobId: string,
    transition: (current: LiftJob, scope: LiftJobTransitionScope) => Promise<T>,
  ): Promise<T> {
    await this.dependencies.ensureGraph();
    return await this.withJobTransitionLock(jobId, async () => {
      const current = await this.getRequiredJob(jobId);
      await this.assertActiveClaimLock(current);
      return await transition(current, this.createTransitionScope());
    });
  }

  /** Canonical worker transition boundary: lock, re-read, fence, and reject ended authority. */
  async transitionOwned<T>(
    claim: ActiveLiftJobClaim,
    transition: (current: LiftJob, scope: LiftJobTransitionScope) => Promise<T>,
  ): Promise<T> {
    await this.dependencies.ensureGraph();
    return await this.withJobTransitionLock(claim.jobId, async () => {
      const current = await this.getRequiredJob(claim.jobId);
      this.assertClaimFence(current, claim);
      if (current.status === 'failed' || current.status === 'finalized') {
        throw this.createStaleClaimError(current, `claim authority ended in ${current.status}`);
      }
      await this.assertActiveClaimLock(current);
      return await transition(current, this.createTransitionScope());
    });
  }

  private createTransitionScope(): LiftJobTransitionScope {
    return {
      commit: async (job, kind) => await this.commitTransition(job, kind),
    };
  }

  private async withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = AsyncLiftClaimCoordinator.claimQueues.get(this.config.graphUri)
      ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    AsyncLiftClaimCoordinator.claimQueues.set(this.config.graphUri, next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (AsyncLiftClaimCoordinator.claimQueues.get(this.config.graphUri) === next) {
        AsyncLiftClaimCoordinator.claimQueues.delete(this.config.graphUri);
      }
    }
  }

  private async withJobTransitionLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${this.config.graphUri}\u0000${jobId}`;
    return await withKeyedLocks(AsyncLiftClaimCoordinator.jobTransitionQueues, [key], fn);
  }

  private buildActiveClaim(
    job: LiftJobClaimed,
    walletId: string,
    claimToken: string,
    now: number,
    lockExpiresAt: number,
  ): ActiveLiftJobClaim {
    return {
      ...job,
      claim: {
        ...job.claim,
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
    } satisfies ActiveLiftJobClaim;
  }

  private assertClaimFence(job: LiftJob, expected: ActiveLiftJobClaim): void {
    if (job.claim?.walletId !== expected.claim.walletId) {
      throw this.createStaleClaimError(
        job,
        `wallet ownership moved from ${expected.claim.walletId} to ${job.claim?.walletId ?? '(none)'}`,
      );
    }
    if (job.claim.claimToken !== expected.claim.claimToken) {
      throw this.createStaleClaimError(job, 'claim token was superseded');
    }
  }

  private async getRequiredJob(jobId: string): Promise<LiftJob> {
    const job = await this.dependencies.getStatus(jobId);
    if (!job) throw new Error(`LiftJob not found: ${jobId}`);
    return job;
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
    const lockRef = walletLockSubject(lock.walletId);
    await replaceSubjectAtomicallyOrFallback(
      this.store,
      this.config.walletLockGraphUri,
      lockRef,
      serializeWalletLock(lock, this.config.walletLockGraphUri),
      'publisher.asyncLift.walletLock.write',
    );
  }

  private async deleteWalletLock(walletId: string): Promise<void> {
    await this.store.deleteByPattern({
      subject: walletLockSubject(walletId),
      graph: this.config.walletLockGraphUri,
    });
    this.dependencies.notifyWalletRelease(walletId);
  }

  private async readWalletLock(walletId: string): Promise<WalletLockSnapshot | null> {
    const result = await this.store.query(
      `SELECT ?job ?status ?expiresAt ?claimToken WHERE { GRAPH <${this.config.walletLockGraphUri}> { <${walletLockSubject(walletId)}> <${CONTROL_LOCKED_JOB}> ?job ; <${CONTROL_LOCK_STATUS}> ?status . OPTIONAL { <${walletLockSubject(walletId)}> <${CONTROL_LOCK_EXPIRES_AT}> ?expiresAt } OPTIONAL { <${walletLockSubject(walletId)}> <${CONTROL_CLAIM_TOKEN}> ?claimToken } } }`,
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
    const lock = await this.readWalletLock(walletId);
    if (!lock || lock.status !== 'active') return false;
    const job = await this.dependencies.getStatus(lock.jobId);
    if (job && this.isProofBoundWalletOwner(lock, job, walletId)) return true;
    return (lock.expiresAt ?? 0) > this.config.now();
  }

  private requiresActiveClaimLock(job: LiftJob): boolean {
    return job.status === 'claimed'
      || job.status === 'validated'
      || job.status === 'broadcast'
      || job.status === 'included';
  }

  private isUsableActiveLock(lock: WalletLockSnapshot, job: LiftJob): boolean {
    if (lock.status !== 'active') return false;
    if (!this.lockMatchesJob(lock, job)) return false;
    if (job.status === 'broadcast' || job.status === 'included') return true;
    if (
      isFailedJob(job)
      && isHeldForChainProof(job)
      && liftJobCheckedSigner(job) === job.claim?.walletId
    ) return true;
    if (lock.expiresAt !== undefined && lock.expiresAt <= this.config.now()) return false;
    return true;
  }

  private isProofBoundWalletOwner(
    lock: WalletLockSnapshot,
    job: LiftJob,
    walletId: string,
  ): boolean {
    if (!this.lockMatchesJob(lock, job)) return false;
    if (job.status === 'broadcast' || job.status === 'included') {
      return job.broadcast.walletId === walletId;
    }
    return isFailedJob(job)
      && isHeldForChainProof(job)
      && liftJobCheckedSigner(job) === walletId;
  }

  private lockMatchesJob(lock: WalletLockSnapshot, job: LiftJob): boolean {
    if (lock.jobId !== job.jobId) return false;
    if (job.claim?.claimToken) return lock.claimToken === job.claim.claimToken;
    return !lock.claimToken;
  }

  private jobIdFromRef(jobRef: string): string | null {
    const prefix = 'urn:dkg:publisher:lift-job:';
    return jobRef.startsWith(prefix) ? jobRef.slice(prefix.length) : null;
  }

  private createStaleClaimError(job: LiftJob, reason: string): StaleLiftJobClaimError {
    return new StaleLiftJobClaimError(job.jobId, reason);
  }
}
