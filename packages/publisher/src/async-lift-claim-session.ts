import type { AsyncLiftJournalCompletion, JournalOperation, JournalSection } from './async-lift-journal-completion.js';
import { AsyncLiftWalletPersistence, walletLockJobIdFromRef, type WalletLockRecord, type WalletLockSnapshot } from './async-lift-wallet-persistence.js';
import { completionTrace } from './async-lift-completion-trace.js';
import type { ClaimLockQueue } from './async-lift-claim-lock.js';
import { claimTrace, withObservedClaimLock, type ClaimLockKind, type ClaimLockTrace } from './async-lift-claim-trace.js';
import type { PublishResult } from './publisher.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type {
  JournalKind,
  LiftJob,
  LiftJobCompatibility,
  LiftJobAccepted,
  LiftJobClaimed,
  LiftJobState,
  PersistedLiftJob,
} from './lift-job.js';
import type {
  ActiveLiftJobClaim,
  ActiveLiftJobClaimSession,
  ExecutionFailureEvidence,
} from './async-lift-publisher-types.js';
import { StaleLiftJobClaimError } from './async-lift-publisher-types.js';
import { isHeldForChainProof } from './async-lift-retry-disposition.js';
import { assertLiftJobTransition } from './lift-job-states.js';
import { withKeyedLocks } from './keyed-lock.js';
import { requireActiveLiftJobClaim, type CommittedLiftJob } from './lift-job-committed.js';
import {
  CONTROL_CLAIM_TOKEN,
  CONTROL_LOCKED_JOB,
  CONTROL_LOCK_EXPIRES_AT,
  CONTROL_LOCK_STATUS,
  CONTROL_WALLET_ID,
  expectBindings,
  isFailedJob,
  liftJobCheckedSigner,
  literal,
  parseLiteral,
  walletLockSubject,
} from './async-lift-publisher-utils.js';
import {
  decodedLiftJobOrThrow,
  type LiftJobPayloadDecodeResult,
  type StructurallyValidLiftJobPayload,
} from './lift-job-payload-codec.js';

import type { ActiveLiftJobClaimTransitionBoundary, LiftJobRecoveryTransitionScope, LiftJobTransitionScope, LiftJobTransaction } from './lift-job-transition-scope.js';
export type { ActiveLiftJobClaimTransitionBoundary, LiftJobRecoveryTransitionScope, LiftJobTransitionScope, LiftJobTransaction } from './lift-job-transition-scope.js';

/** Diagnostic read variants exposed only to the targeted terminal-clear operation. */
export type ClassifiedLiftJobClearTransaction =
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly current: StructurallyValidLiftJobPayload }
  | {
    readonly kind: 'present';
    readonly current: PersistedLiftJob;
    readonly scope: LiftJobRecoveryTransitionScope;
  };

/**
 * The one decoded read-under-lock representation. Public transaction APIs adapt this primitive
 * into either fail-closed lifecycle authority or the targeted clear operation's diagnostic view.
 */
type DecodedLiftJobTransaction =
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly current: StructurallyValidLiftJobPayload }
  | {
    readonly kind: 'canonical';
    readonly current: LiftJob;
    readonly scope: LiftJobTransitionScope;
  }
  | {
    readonly kind: 'compatibility';
    readonly current: LiftJobCompatibility;
    readonly scope: LiftJobRecoveryTransitionScope;
  };

type LiftJobTransactionLockMode = 'job' | 'claim-job';

/**
 * A worker checkpoint may observe proof advancing its exact claim before the callback runs.
 * Advanced records are deliberately read-only: only a still-owned record receives commit scope.
 */
export type ActiveLiftJobCheckpoint =
  | {
    readonly kind: 'advanced';
    readonly current: Extract<LiftJob, { readonly status: 'included' | 'finalized' }>;
  }
  | {
    readonly kind: 'owned';
    readonly current: LiftJob;
    readonly scope: LiftJobTransitionScope;
  };

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
    evidence?: ExecutionFailureEvidence,
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

  async recordExecutionFailure(
    failedFromState: LiftJobState,
    error: unknown,
    evidence?: ExecutionFailureEvidence,
  ): Promise<LiftJob> {
    return await this.boundary.run(
      async (current, scope) =>
        await this.mutations.recordExecutionFailure(current, scope, failedFromState, error, evidence),
    );
  }
}

export type AsyncLiftClaimProcessingRelease =
  | { readonly kind: 'processed'; readonly job: LiftJob }
  | { readonly kind: 'replaced'; readonly job: PersistedLiftJob }
  | { readonly kind: 'stale' }
  | { readonly kind: 'faulted' };

export type AsyncLiftClaimProcessingOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'processed'; readonly job: LiftJob }
  | { readonly kind: 'replaced'; readonly job: PersistedLiftJob }
  | { readonly kind: 'recovered'; readonly job: PersistedLiftJob | null };

export type LiftJobOwnershipMode = 'released' | 'lease-bound' | 'proof-bound';

/** The single lifecycle policy for whether and how a job owns its signing wallet. */
export function classifyLiftJobOwnershipMode(job: PersistedLiftJob): LiftJobOwnershipMode {
  switch (job.status) {
    case 'accepted':
    case 'finalized':
      return 'released';
    case 'claimed':
    case 'validated':
      return 'lease-bound';
    case 'broadcast':
    case 'included':
      return 'proof-bound';
    case 'failed':
      if (!isHeldForChainProof(job)) return 'released';
      // A legacy/incomplete held failure can prove that some transaction existed without naming
      // its signer. It may keep the current claim only by lease; expiry cannot be ignored until
      // durable evidence binds the transaction to this wallet.
      return liftJobCheckedSigner(job) ? 'proof-bound' : 'lease-bound';
    default: {
      const exhaustive: never = job;
      return exhaustive;
    }
  }
}

export interface AsyncLiftClaimCoordinatorDependencies {
  readonly journalCompletion: AsyncLiftJournalCompletion;
  readonly ensureGraph: () => Promise<void>;
  readonly isPaused: () => boolean;
  readonly readStatus: (jobId: string) => Promise<LiftJobPayloadDecodeResult>;
  readonly nextClaimCandidate: (section: JournalSection, now: number) => Promise<LiftJobAccepted | undefined>;
  readonly toClaimed: (current: LiftJobAccepted, walletId: string) => LiftJobClaimed;
  readonly writeJob: <T extends LiftJob>(
    section: JournalSection,
    job: T,
    kind: JournalKind,
  ) => Promise<CommittedLiftJob<T>>;
  readonly deleteJob: (jobId: string) => Promise<void>;
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
  private static readonly claimQueues = new Map<string, ClaimLockQueue>();
  private static readonly jobTransitionQueues = new Map<string, Promise<void>>();

  /** Latest in-process claim epoch for each job; stale epochs may overlap while unwinding. */
  private readonly activeProcessClaimTokens = new Map<string, string>();
  private readonly lockLeaseMs: number;
  private readonly walletLocks: AsyncLiftWalletPersistence;

  constructor(
    private readonly store: TripleStore,
    private readonly config: AsyncLiftClaimCoordinatorConfig,
    private readonly dependencies: AsyncLiftClaimCoordinatorDependencies,
  ) {
    this.lockLeaseMs = config.lockLeaseMs ?? 5 * 60 * 1000;
    this.walletLocks = new AsyncLiftWalletPersistence(store, config.graphUri, config.walletLockGraphUri);
  }

  async claimNext(
    walletId: string,
  ): Promise<ActiveLiftJobClaim | null> {
    const claim = await this.dependencies.journalCompletion.runPublicOperation((owner) => this.claimNextInternal(owner, walletId, false));
    if (!claim) return null;
    // Journal settlement no longer retains canonical ownership. Never hand an expired or
    // replaced claim to a direct caller after that auxiliary wait.
    return this.withClaimLock(() => this.withJobTransitionLock(claim.jobId, async () => {
      const decoded = await this.dependencies.readStatus(claim.jobId);
      decodedLiftJobOrThrow(decoded); // Preserve fail-closed exact-read errors.
      if (decoded.kind !== 'canonical' || decoded.job.status !== 'claimed') return null;
      if (!this.claimFenceMatches(decoded.job, claim) || !await this.isJobOwnershipActive(decoded.job)) return null;
      return requireActiveLiftJobClaim(decoded.job);
    }), 'transition', walletId);
  }

  private async claimNextInternal(
    owner: JournalOperation,
    walletId: string,
    markProcessing: boolean,
  ): Promise<ActiveLiftJobClaim | null> {
    return await owner.runCanonical((section) => this.withClaimLock(async (trace) => {
      await this.dependencies.ensureGraph();
      const idle = (result: 'paused' | 'wallet-active' | 'no-candidate' | 'stale-candidate'): null => { trace.emit('claim_outcome', { result }); return null; };
      if (this.dependencies.isPaused()) return idle('paused');
      if (await this.hasActiveWalletLock(walletId, trace)) return idle('wallet-active');

      const next = await this.dependencies.nextClaimCandidate(section, this.config.now());
      if (!next) return idle('no-candidate');
      const claimedJob = await this.withJobTransitionLock(next.jobId, async () => {
        const current = await this.getStatus(next.jobId);
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
        const committed = requireActiveLiftJobClaim(await this.dependencies.writeJob(section, owned, 'claimed'));
        await this.writeWalletLock({
          walletId,
          jobId: owned.jobId,
          acquiredAt: now,
          expiresAt: lockExpiresAt,
          status: 'active',
          claimToken,
          lastHeartbeatAt: now,
        });
        return committed;
      });
      if (!claimedJob) return idle('stale-candidate');
      if (markProcessing) {
        this.activeProcessClaimTokens.set(claimedJob.jobId, claimedJob.claim.claimToken);
      }
      trace.emit('claim_outcome', { result: 'claimed', jobId: claimedJob.jobId }, claimedJob.claim.claimToken);
      return claimedJob;
    }, 'claim', walletId));
  }

  /** Claim, process, classify stale ownership, recover unchanged claims, and always clear marker. */
  async processClaim(
    walletId: string,
    handler: (session: ActiveLiftJobClaimSession, owner: JournalOperation) => Promise<LiftJob>,
    onProcessingReleased?: (release: AsyncLiftClaimProcessingRelease) => void,
  ): Promise<AsyncLiftClaimProcessingOutcome> {
    let claim: ActiveLiftJobClaim | null = null;
    let outcome: AsyncLiftClaimProcessingOutcome | undefined;
    let release: AsyncLiftClaimProcessingRelease = { kind: 'faulted' };
    let recover = false;
    try {
      await this.dependencies.journalCompletion.runPublicOperation(async (owner) => {
        claim = await this.claimNextInternal(owner, walletId, true);
        if (!claim) return;
        try {
          const job = await handler(this.openWorkerSession(owner, claim), owner);
          outcome = { kind: 'processed', job };
          release = outcome;
        } catch (error) {
          if (!(error instanceof StaleLiftJobClaimError)) throw error;
          const current = await this.getStatus(claim.jobId);
          if (current && !this.claimFenceMatches(current, claim)) {
            outcome = { kind: 'replaced', job: current };
            release = outcome;
          } else {
            recover = true;
            release = { kind: 'stale' };
          }
        }
      });
    } finally {
      // Callback assignment survives await but is not tracked by TypeScript's local flow analysis.
      const acquired = claim as ActiveLiftJobClaim | null;
      if (acquired) {
        if (this.activeProcessClaimTokens.get(acquired.jobId) === acquired.claim.claimToken) {
          this.activeProcessClaimTokens.delete(acquired.jobId);
        }
        try { onProcessingReleased?.(release); } catch { /* Scheduling cannot change cleanup or outcomes. */ }
      }
    }
    if (!claim) return { kind: 'idle' };
    if (recover) return { kind: 'recovered', job: await this.dependencies.journalCompletion.runPublicOperation(
      (owner) => this.recoverUnreplacedExpiredClaim(owner, claim!),
    ) };
    if (!outcome) throw new Error('Claim processing completed without an outcome');
    return outcome;
  }

  openSession(claim: ActiveLiftJobClaim): ActiveLiftJobClaimSession {
    return new DefaultActiveLiftJobClaimSession(
      claim,
      {
        run: (transition) => this.dependencies.journalCompletion.runPublicOperation((owner) => this.transitionOwned(owner, claim, transition)),
      },
      this.dependencies.mutations,
    );
  }

  private openWorkerSession(owner: JournalOperation, claim: ActiveLiftJobClaim): ActiveLiftJobClaimSession {
    return new DefaultActiveLiftJobClaimSession(claim, {
      run: (transition) => this.transitionOwned(owner, claim, transition),
    }, this.dependencies.mutations);
  }

  isProcessing(jobId: string): boolean {
    return this.activeProcessClaimTokens.has(jobId);
  }

  private claimFenceMatches(job: PersistedLiftJob, expected: ActiveLiftJobClaim): boolean {
    return job.claim?.walletId === expected.claim.walletId
      && job.claim.claimToken === expected.claim.claimToken;
  }

  private async recoverUnreplacedExpiredClaim(owner: JournalOperation, claim: ActiveLiftJobClaim): Promise<PersistedLiftJob | null> {
    await this.dependencies.ensureGraph();
    return await owner.runCanonical((section) => this.withClaimLock(() => this.withJobTransitionLock(claim.jobId, async () => {
      const current = await this.getStatus(claim.jobId);
      if (!current) return null;
      if (!this.claimFenceMatches(current, claim)) return current;
      if (current.status !== 'claimed' && current.status !== 'validated') return current;
      if (await this.isJobOwnershipActive(current)) return current;

      const reset = this.dependencies.resetInterruptedClaim(current);
      return await this.createTransitionScope(section, current).commitRecoveryReset(reset);
    }), 'recovery', claim.claim.walletId));
  }

  /**
   * Commit transitions, lease renewal, validation, persistence and wallet synchronization
   * through one coordinator-owned boundary.
   */
  private async commitTransition(
    section: JournalSection,
    current: LiftJob,
    candidate: LiftJob,
    kind: JournalKind,
  ): Promise<LiftJob> {
    this.assertSameJob(current, candidate);
    if (current.status !== candidate.status) {
      assertLiftJobTransition(current.status, candidate.status);
    }
    const next = this.renewActiveOwnership(candidate);
    this.dependencies.assertJobMatchesStatus(next);
    const committed = await this.dependencies.writeJob(section, next, kind);
    await this.persistOwnershipState(committed);
    return committed;
  }

  private renewActiveOwnership(job: LiftJob): LiftJob {
    if (!job.claim) return job;
    if (classifyLiftJobOwnershipMode(job) === 'released') return job;

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
    if (classifyLiftJobOwnershipMode(job) === 'released') return;
    const walletId = job.claim?.walletId;
    if (!walletId) throw this.createStaleClaimError(job, 'missing claim wallet');
    const currentLock = await this.walletLocks.readMetadata(walletId);
    if (!currentLock) {
      throw this.createStaleClaimError(job, `missing active wallet lock for ${walletId}`);
    }
    if (!this.isUsableActiveLock(currentLock, job)) {
      throw this.createStaleClaimError(job, `wallet lock mismatch for ${walletId}`);
    }
  }

  async isJobOwnershipActive(job: PersistedLiftJob): Promise<boolean> {
    const walletId = job.claim?.walletId;
    if (!walletId) return false;
    const currentLock = await this.walletLocks.readMetadata(walletId);
    return currentLock !== null && this.isUsableActiveLock(currentLock, job);
  }

  private async releaseJobOwnership(job: PersistedLiftJob): Promise<void> {
    const walletId = job.claim?.walletId;
    if (!walletId) return;
    const currentLock = await this.walletLocks.readMetadata(walletId);
    if (!currentLock) {
      // A stale sweep can release before the job reset becomes visible. Re-invite after the
      // caller's write so the now-claimable job is not parked until an idle sweep.
      claimTrace.emit('wallet_lock_absent_observed', {}, walletId);
      this.dependencies.notifyWalletRelease(walletId);
      return;
    }
    if (!this.lockMatchesJob(currentLock, job)) return;
    await this.deleteWalletLock(walletId, currentLock);
  }

  private async persistOwnershipState(job: LiftJob): Promise<void> {
    const walletId = job.claim?.walletId;
    if (!walletId) return;
    const currentLock = await this.walletLocks.readMetadata(walletId);

    if (classifyLiftJobOwnershipMode(job) !== 'released') {
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
      await this.deleteWalletLock(walletId, currentLock);
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
      const jobId = walletLockJobIdFromRef(row['job'] ?? '');
      if (!jobId) {
        await this.withClaimLock(async () => {
          if (await this.walletLocks.readMetadata(walletId)) return;
          expiredWallets.push(walletId);
          await this.deleteWalletLock(walletId);
        }, 'sweep', walletId);
        continue;
      }
      await this.withClaimLock(() => this.withJobTransitionLock(jobId, async () => {
        const currentLock = await this.walletLocks.readMetadata(walletId);
        if (!currentLock || currentLock.jobId !== jobId) return;
        const job = await this.getStatus(jobId);
        const stale = !job || !this.isUsableActiveLock(currentLock, job, now);
        if (!stale) return;
        expiredWallets.push(walletId);
        await this.deleteWalletLock(walletId, currentLock);
      }), 'sweep', walletId);
    }
    return expiredWallets;
  }

  /** Serialize a control-plane operation in canonical global-claim lock order. */
  async runClaimTransaction<T>(owner: JournalOperation, operation: (section: JournalSection) => Promise<T>, kind: 'admission' | 'admin' = 'admin'): Promise<T> {
    return await owner.runCanonical((section) => this.withClaimLock(() => operation(section), kind));
  }

  /** Lock, re-read, and bind one job to a scope that cannot release or commit another job. */
  async runJobTransaction<T>(
    owner: JournalOperation,
    jobId: string,
    operation: (transaction: LiftJobTransaction) => Promise<T>,
  ): Promise<T> {
    return await owner.runCanonical((section) => this.runLifecycleJobTransaction(section, jobId, 'job', operation));
  }

  /** A job nested under an already-owned claim section must share its outer release gate. */
  async runNestedJobTransaction<T>(section: JournalSection, jobId: string, operation: (transaction: LiftJobTransaction) => Promise<T>): Promise<T> {
    section.assertOpen();
    return this.runLifecycleJobTransaction(section, jobId, 'job', operation);
  }

  /** Canonical global-claim -> per-job transaction, with the same bound re-read. */
  async runClaimJobTransaction<T>(
    owner: JournalOperation,
    jobId: string,
    operation: (transaction: LiftJobTransaction) => Promise<T>,
  ): Promise<T> {
    return await owner.runCanonical((section) => this.runLifecycleJobTransaction(section, jobId, 'claim-job', operation));
  }

  /**
   * Targeted-clear-only boundary. It preserves global-claim -> per-job lock order and performs one
   * payload read, while allowing that administrative API to report malformed and future states as
   * bounded outcomes. Ordinary lifecycle transactions deliberately use the fail-closed boundary.
   */
  async runClassifiedClearTransaction<T>(
    owner: JournalOperation,
    jobId: string,
    operation: (transaction: ClassifiedLiftJobClearTransaction) => Promise<T>,
  ): Promise<T> {
    return await owner.runCanonical((section) => this.runDecodedJobTransaction(section, jobId, 'claim-job', async (transaction) => {
      switch (transaction.kind) {
        case 'missing':
        case 'malformed':
        case 'unknown':
          return await operation(transaction);
        case 'canonical':
        case 'compatibility':
          return await operation({
            kind: 'present',
            current: transaction.current,
            scope: transaction.scope,
          });
      }
    }));
  }

  /** Canonical administrative transition boundary: lock, re-read, and validate live ownership. */
  async transitionAdministrative<T>(
    owner: JournalOperation,
    jobId: string,
    transition: (current: LiftJob, scope: LiftJobTransitionScope) => Promise<T>,
  ): Promise<T> {
    return await owner.runCanonical(async (section) => {
      await this.dependencies.ensureGraph();
      return this.withJobTransitionLock(jobId, async () => {
        const current = await this.getRequiredJob(jobId);
        await this.assertActiveClaimLock(current);
        return await transition(current, this.createTransitionScope(section, current));
      });
    });
  }

  /** Canonical worker transition boundary: lock, re-read, fence, and reject ended authority. */
  transitionOwned<T>(
    owner: JournalOperation,
    claim: ActiveLiftJobClaim,
    transition: (current: LiftJob, scope: LiftJobTransitionScope) => Promise<T>,
  ): Promise<T> {
    return owner.runCanonical((section) => this.withOwnedTransition(section, claim, transition));
  }

  /** Only pre-send work can restore its exact captured validated record after a durability failure. */
  runPreSendTransaction<T>(
    owner: JournalOperation,
    claim: ActiveLiftJobClaim,
    transition: (current: LiftJob, scope: LiftJobTransitionScope, restoreValidated: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return owner.runCanonical((section) => this.withOwnedTransition(section, claim, (current, scope) =>
      transition(current, scope, async () => {
        section.assertOpen();
        if (current.status !== 'validated') throw new Error('Pre-send rollback requires captured validated state');
        await this.dependencies.writeJob(section, current, 'rollback-noop');
      })));
  }

  private async withOwnedTransition<T>(
    section: JournalSection,
    claim: ActiveLiftJobClaim,
    transition: (current: LiftJob, scope: LiftJobTransitionScope) => Promise<T>,
  ): Promise<T> {
    section.assertOpen();
    await this.dependencies.ensureGraph();
    return this.withJobTransitionLock(claim.jobId, async () => {
      const current = await this.getRequiredJob(claim.jobId);
      this.assertClaimFence(current, claim);
      if (current.status === 'failed' || current.status === 'finalized') {
        throw this.createStaleClaimError(current, `claim authority ended in ${current.status}`);
      }
      await this.assertActiveClaimLock(current);
      return transition(current, this.createTransitionScope(section, current));
    });
  }

  /**
   * Worker checkpoint boundary for a callback that can be made obsolete by chain proof. The exact
   * claim fence is checked in both branches, while only a still-active owner receives write access.
   */
  async runOwnedCheckpointTransaction<T>(
    owner: JournalOperation,
    claim: ActiveLiftJobClaim,
    operation: (checkpoint: ActiveLiftJobCheckpoint) => Promise<T>,
  ): Promise<T> {
    return await owner.runCanonical(async (section) => {
      await this.dependencies.ensureGraph();
      return this.withJobTransitionLock(claim.jobId, async () => {
        const current = await this.getRequiredJob(claim.jobId);
        this.assertClaimFence(current, claim);
        if (current.status === 'included' || current.status === 'finalized') {
          return await operation({ kind: 'advanced', current });
        }
        if (current.status === 'failed') {
          throw this.createStaleClaimError(current, `claim authority ended in ${current.status}`);
        }
        await this.assertActiveClaimLock(current);
        return await operation({
          kind: 'owned',
          current,
          scope: this.createTransitionScope(section, current),
        });
      });
    });
  }

  private createScopeState<TJob extends PersistedLiftJob>(section: JournalSection, initial: TJob): {
    transition<TResult>(
      operation: (before: TJob) => Promise<TResult>,
      nextState: (result: TResult) => TJob | null,
    ): Promise<TResult>;
    close<TResult>(operation: (before: TJob) => Promise<TResult>): Promise<TResult>;
  } {
    let current: TJob | null = initial;
    const transition = async <T>(
      operation: (before: TJob) => Promise<T>,
      nextState: (result: T) => TJob | null,
    ): Promise<T> => {
      section.assertOpen();
      if (current === null) {
        throw new Error(`LiftJob transition scope for ${initial.jobId} is closed`);
      }
      const result = await operation(current);
      current = nextState(result);
      return result;
    };
    const close = async <T>(operation: (before: TJob) => Promise<T>): Promise<T> =>
      await transition(operation, () => null);
    return { transition, close };
  }

  /** Base authority for any readable row: recovery, reacceptance, or explicit removal only. */
  private createRecoveryTransitionScope<TJob extends PersistedLiftJob>(
    section: JournalSection,
    initial: TJob,
    state = this.createScopeState(section, initial),
  ): LiftJobRecoveryTransitionScope {
    const { close } = state;
    return {
      commitRecoveryReset: async (reset) => await close(async (before) => {
        this.assertLifecycleTransition(before, reset, 'accepted');
        // Reset must be claim-visible before the one-shot wallet-release notification fires.
        const committed = await this.dependencies.writeJob(section, reset, 'recover-reset');
        await this.releaseJobOwnership(before);
        return committed;
      }),
      commitProofFailure: async (failed) => await close(async (before) => {
        this.assertLifecycleTransition(before, failed, 'failed');
        // Canonical chain proof ends nonce ownership even if the local failure write must retry.
        await this.releaseJobOwnership(before);
        return await this.dependencies.writeJob(section, failed, 'failed');
      }),
      commitProofFinalization: async (finalize) => await close(async (before) => {
        // Proof authorizes immediate wallet reuse. Local repair and terminal persistence may then
        // retry independently without serializing a later transaction behind this nonce.
        await this.releaseJobOwnership(before);
        const finalized = await finalize();
        if (finalized === null) return null;
        this.assertLifecycleTransition(before, finalized, 'finalized');
        return await this.dependencies.writeJob(section, finalized, 'recovered-finalize');
      }),
      commitReaccept: async (accepted) => await close(async (before) => {
        this.assertLifecycleTransition(before, accepted, 'accepted');
        await this.releaseJobOwnership(before);
        return await this.dependencies.writeJob(section, accepted, 'reaccept');
      }),
      commitRemoval: async () => await close(async (before) => {
        await this.releaseJobOwnership(before);
        await this.dependencies.deleteJob(before.jobId);
      }),
    };
  }

  /** Canonical authority extends the recovery base with normal and proof-inclusion transitions. */
  private createTransitionScope(section: JournalSection, initial: LiftJob): LiftJobTransitionScope {
    const state = this.createScopeState<LiftJob>(section, initial);
    const recoveryScope = this.createRecoveryTransitionScope(section, initial, state);
    const advance = async (
      operation: (before: LiftJob) => Promise<LiftJob>,
    ): Promise<LiftJob> => await state.transition(operation, (next) =>
      next.status === 'accepted' || next.status === 'failed' || next.status === 'finalized'
        ? null
        : next);
    return {
      ...recoveryScope,
      commit: async (next, kind) => await advance(
        async (before) => await this.commitTransition(section, before, next, kind),
      ),
      commitProofInclusion: async (included) => await state.close(async (before) => {
        this.assertLifecycleTransition(before, included, 'included');
        // Inclusion becomes visible before release so a woken worker never observes an active
        // transaction as claimable. An already-included retry only repeats the release.
        if (before.status !== 'included') {
          included = await this.dependencies.writeJob(section, included, 'included');
        }
        await this.releaseJobOwnership(before);
        return included;
      }),
    };
  }

  private assertSameJob(current: PersistedLiftJob, next: LiftJob): void {
    if (next.jobId !== current.jobId) {
      throw new Error(
        `Lifecycle transition cannot replace LiftJob ${current.jobId} with ${next.jobId}`,
      );
    }
  }

  private assertLifecycleTransition(
    current: PersistedLiftJob,
    next: LiftJob,
    expectedStatus: LiftJobState,
  ): void {
    this.assertSameJob(current, next);
    if (next.status !== expectedStatus) {
      throw new Error(
        `Lifecycle transition for LiftJob ${current.jobId} expected ${expectedStatus}, got ${next.status}`,
      );
    }
    this.dependencies.assertJobMatchesStatus(next);
  }

  /** Thin fail-closed adapter over the one decoded transaction primitive. */
  private async runLifecycleJobTransaction<T>(
    section: JournalSection,
    jobId: string,
    lockMode: LiftJobTransactionLockMode,
    operation: (transaction: LiftJobTransaction) => Promise<T>,
  ): Promise<T> {
    return await this.runDecodedJobTransaction(section, jobId, lockMode, async (transaction) => {
      switch (transaction.kind) {
        case 'missing':
          return await operation(transaction);
        case 'canonical':
          return await operation({
            kind: 'present',
            current: transaction.current,
            scope: transaction.scope,
          });
        case 'compatibility':
          return await operation(transaction);
        case 'malformed':
          decodedLiftJobOrThrow(transaction);
          throw new Error('unreachable persisted LiftJob decode result');
        case 'unknown':
          decodedLiftJobOrThrow({ kind: 'unknown', job: transaction.current });
          throw new Error('unreachable persisted LiftJob decode result');
      }
    });
  }

  /**
   * The sole job payload transaction: acquire locks in the selected canonical order, read once,
   * decode once, and construct state-appropriate capabilities once while still under the lock.
   */
  private async runDecodedJobTransaction<T>(
    section: JournalSection,
    jobId: string,
    lockMode: LiftJobTransactionLockMode,
    operation: (transaction: DecodedLiftJobTransaction) => Promise<T>,
  ): Promise<T> {
    section.assertOpen();
    await this.dependencies.ensureGraph();
    const underJobLock = async (): Promise<T> => await this.withJobTransitionLock(jobId, async () => {
      const decoded = await this.dependencies.readStatus(jobId);
      switch (decoded.kind) {
        case 'absent':
          return await operation({ kind: 'missing' });
        case 'malformed':
          return await operation(decoded);
        case 'unknown':
          return await operation({ kind: 'unknown', current: decoded.job });
        case 'canonical':
          return await operation({
            kind: 'canonical',
            current: decoded.job,
            scope: this.createTransitionScope(section, decoded.job),
          });
        case 'compatibility':
          return await operation({
            kind: 'compatibility',
            current: decoded.job,
            scope: this.createRecoveryTransitionScope(section, decoded.job),
          });
      }
    });
    return lockMode === 'claim-job'
      ? await this.withClaimLock(underJobLock)
      : await underJobLock();
  }

  private withClaimLock<T>(
    fn: (trace: ClaimLockTrace) => Promise<T>,
    kind: ClaimLockKind = 'transition',
    walletId?: string,
  ): Promise<T> {
    return withObservedClaimLock(AsyncLiftClaimCoordinator.claimQueues, this.config.graphUri, fn, kind, walletId);
  }

  private async withJobTransitionLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${this.config.graphUri}\u0000${jobId}`;
    return withKeyedLocks(AsyncLiftClaimCoordinator.jobTransitionQueues, [key], fn);
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
    const decoded = await this.dependencies.readStatus(jobId);
    switch (decoded.kind) {
      case 'canonical':
        return decoded.job;
      case 'compatibility':
        throw new Error(`Compatibility LiftJob ${jobId} requires recovery before normal transitions`);
      case 'absent':
        throw new Error(`LiftJob not found: ${jobId}`);
      case 'malformed':
      case 'unknown':
        decodedLiftJobOrThrow(decoded);
        throw new Error('unreachable persisted LiftJob decode result');
    }
  }

  private async getStatus(jobId: string): Promise<PersistedLiftJob | null> {
    return decodedLiftJobOrThrow(await this.dependencies.readStatus(jobId));
  }

  private async writeWalletLock(lock: WalletLockRecord): Promise<void> {
    await this.walletLocks.write(lock);
    claimTrace.emit('wallet_lock_written', { jobId: lock.jobId, expiresAt: lock.expiresAt, lockStatus: lock.status }, lock.walletId);
  }

  private async deleteWalletLock(walletId: string, ownership?: WalletLockSnapshot): Promise<void> {
    await this.walletLocks.delete(walletId);
    claimTrace.emit('wallet_lock_deleted', {}, walletId);
    if (ownership) completionTrace.walletOwnershipReleased(ownership.jobId, walletId, ownership.claimToken);
    this.dependencies.notifyWalletRelease(walletId);
  }

  private async hasActiveWalletLock(walletId: string, trace: ClaimLockTrace): Promise<boolean> {
    const ownership = await this.walletLocks.readOwnership(walletId);
    const lock = ownership?.lock ?? null;
    const job = ownership?.job ?? null;
    const usableActiveLock = job !== null && lock !== null && this.isUsableActiveLock(lock, job);
    trace.emit('wallet_checked', {
      usableActiveLock, matching: job !== null && lock !== null && this.lockMatchesJob(lock, job),
      ownershipMode: job === null ? 'absent' : classifyLiftJobOwnershipMode(job),
      jobId: lock?.jobId, expiresAt: lock?.expiresAt, lockStatus: lock?.status,
    });
    return usableActiveLock;
  }

  private isUsableActiveLock(
    lock: WalletLockSnapshot,
    job: PersistedLiftJob,
    now = this.config.now(),
  ): boolean {
    if (lock.status !== 'active') return false;
    if (!this.lockMatchesJob(lock, job)) return false;
    switch (classifyLiftJobOwnershipMode(job)) {
      case 'released':
        return false;
      case 'lease-bound':
        return (lock.expiresAt ?? 0) > now;
      case 'proof-bound':
        return this.proofBoundWalletId(job) === lock.walletId;
    }
  }

  /** Extract proof identity only; ownership policy itself lives in the classifier above. */
  private proofBoundWalletId(job: PersistedLiftJob): string | undefined {
    if (job.status === 'broadcast' || job.status === 'included') return job.broadcast?.walletId;
    if (isFailedJob(job)) return liftJobCheckedSigner(job);
    return undefined;
  }

  private lockMatchesJob(lock: WalletLockSnapshot, job: PersistedLiftJob): boolean {
    if (lock.jobId !== job.jobId) return false;
    if (job.claim?.walletId && lock.walletId !== job.claim.walletId) return false;
    if (job.claim?.claimToken) return lock.claimToken === job.claim.claimToken;
    return !lock.claimToken;
  }

  private createStaleClaimError(job: LiftJob, reason: string): StaleLiftJobClaimError {
    return new StaleLiftJobClaimError(job.jobId, reason);
  }
}
