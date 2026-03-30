import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  LIFT_JOB_STATES,
  assertLiftJobTransition,
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
  parseLiteral,
  serializeJob,
  type PersistedFailedJob,
} from './async-lift-publisher-utils.js';

export class TripleStoreAsyncLiftPublisher implements AsyncLiftPublisher {
  private readonly graphUri: string;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly chainRecoveryResolver?: AsyncLiftPublisherRecoveryResolver;
  private paused = false;
  private graphEnsured = false;

  constructor(
    private readonly store: TripleStore,
    config: AsyncLiftPublisherConfig = {},
  ) {
    this.graphUri = config.graphUri ?? DEFAULT_GRAPH_URI;
    this.maxRetries = config.maxRetries ?? 3;
    this.now = config.now ?? (() => Date.now());
    this.idGenerator = config.idGenerator ?? (() => crypto.randomUUID());
    this.chainRecoveryResolver = config.chainRecoveryResolver;
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
    await this.ensureGraph();
    if (this.paused) return null;

    const next = (await this.list({ status: 'accepted' })).sort(compareAcceptedJobs)[0];
    if (!next) return null;

    const now = this.now();
    const claimed = this.mergeJob(next, 'claimed', { claim: { walletId } });
    const claimedJob = {
      ...claimed,
      timestamps: { ...claimed.timestamps, claimedAt: now, updatedAt: now },
    } as LiftJob;

    this.assertJobMatchesStatus(claimedJob);
    await this.writeJob(claimedJob);
    return claimedJob;
  }

  async update(jobId: string, status: LiftJobState, data: Partial<LiftJob> = {}): Promise<void> {
    await this.ensureGraph();
    const next = this.mergeJob(await this.getRequiredJob(jobId), status, data);
    this.assertJobMatchesStatus(next);
    await this.writeJob(next);
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

  async recover(): Promise<number> {
    await this.ensureGraph();
    const interrupted = (await this.list()).filter(
      (job) => job.status === 'claimed' || job.status === 'validated' || job.status === 'broadcast' || job.status === 'included',
    );

    let recovered = 0;

    for (const job of interrupted) {
      if (job.status === 'claimed' || job.status === 'validated') {
        await this.writeJob(this.resetJobToAccepted(job, 'reset_to_accepted', job.status, getRecoveryTxHash(job)));
        recovered += 1;
        continue;
      }

      if ((job.status === 'broadcast' || job.status === 'included') && this.chainRecoveryResolver) {
        const resolved = await this.chainRecoveryResolver(job);
        if (resolved) {
          await this.writeJob(this.finalizeRecoveredJob(job, resolved.inclusion, resolved.finalization));
          recovered += 1;
          continue;
        }
      }

      if (job.status === 'broadcast') {
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
      await this.writeJob(retriedJob);
      retried += 1;
    }
    return retried;
  }

  async clear(status: 'finalized' | 'failed'): Promise<number> {
    await this.ensureGraph();
    const jobs = await this.list({ status });
    for (const job of jobs) await this.deleteJob(job.jobId);
    return jobs.length;
  }

  private async ensureGraph(): Promise<void> {
    if (this.graphEnsured) return;
    await this.store.createGraph(this.graphUri);
    this.graphEnsured = true;
  }

  private async writeJob(job: LiftJob): Promise<void> {
    await this.store.deleteByPattern({ subject: jobSubject(job.jobId), graph: this.graphUri });
    await this.store.insert(serializeJob(job, this.graphUri));
  }

  private async deleteJob(jobId: string): Promise<void> {
    await this.store.deleteByPattern({ subject: jobSubject(jobId), graph: this.graphUri });
  }

  private async getRequiredJob(jobId: string): Promise<LiftJob> {
    const job = await this.getStatus(jobId);
    if (!job) throw new Error(`LiftJob not found: ${jobId}`);
    return job;
  }

  private parseJobPayload(binding?: string): LiftJob | null {
    if (!binding) return null;
    const payload = parseLiteral(binding);
    if (typeof payload !== 'string') return null;
    return JSON.parse(payload) as LiftJob;
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
