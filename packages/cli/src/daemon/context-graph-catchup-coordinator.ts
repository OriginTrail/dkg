import type { ContextGraphReadinessProvenance } from '@origintrail-official/dkg-node-ui';
import type { CatchupRunner } from '../catchup-runner.js';
import type { CatchupJobResult } from '../catchup-result-wire.js';
import {
  catchupResultHasCleanResponse,
  classifyContextGraphCatchupReadiness,
} from '../context-graph-readiness.js';
import type {
  CatchupCoordinator,
  CatchupJob,
  CatchupTracker,
} from './types.js';

export interface ContextGraphCatchupCoordinatorEffects {
  runner: Pick<CatchupRunner, 'run'>;
  readReadiness: (contextGraphId: string) => ContextGraphReadinessProvenance;
  hasConfirmedMeta: (contextGraphId: string) => Promise<boolean>;
  isPrivate: (contextGraphId: string) => Promise<boolean>;
  writeReadiness: (
    contextGraphId: string,
    patch: { durableVerified: boolean; sharedMemoryVerified: boolean },
  ) => void;
  markSubscriptionState: (
    contextGraphId: string,
    patch: {
      synced: boolean;
      sharedMemorySynced: boolean;
      metaSynced: boolean;
      pendingMeta: boolean;
    },
  ) => void;
  emitProjectSynced: (
    contextGraphId: string,
    payload: {
      dataSynced: number;
      sharedMemorySynced: number;
      verifiedPrivateOnlyResponses: number;
    },
  ) => void;
  now?: () => number;
  createJobId?: () => string;
  trace?: (message: string) => void;
}

export class ContextGraphCatchupCoordinatorService {
  private readonly now: () => number;
  private readonly createJobId: () => string;
  private readonly inFlightByContextGraph: Map<string, CatchupCoordinator>;

  constructor(
    private readonly tracker: CatchupTracker,
    private readonly effects: ContextGraphCatchupCoordinatorEffects,
  ) {
    this.now = effects.now ?? Date.now;
    this.createJobId = effects.createJobId ?? (() =>
      `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    this.inFlightByContextGraph = tracker.inFlightByContextGraph;
  }

  /** Reuse active work while preserving each caller's immutable plane scope. */
  coalesceActive(input: {
    contextGraphId: string;
    includeSharedMemory: boolean;
  }): CatchupJob | undefined {
    const coordinator = this.inFlightByContextGraph.get(input.contextGraphId);
    if (!coordinator) return undefined;
    const baseJob = this.tracker.jobs.get(coordinator.baseJobId);
    const upgradeJob = coordinator.upgradeJobId
      ? this.tracker.jobs.get(coordinator.upgradeJobId)
      : undefined;
    const narrowProjectionJob = coordinator.narrowProjectionJobId
      ? this.tracker.jobs.get(coordinator.narrowProjectionJobId)
      : undefined;
    const active = [baseJob, upgradeJob].some((candidate) =>
      candidate?.status === 'queued' || candidate?.status === 'running');
    if (!baseJob || !active) return undefined;

    if (!input.includeSharedMemory) {
      if (!baseJob.includeWorkspace) return baseJob;
      if (narrowProjectionJob) return narrowProjectionJob;

      const createdProjection = this.createJob(input.contextGraphId, false);
      coordinator.narrowProjectionJobId = createdProjection.jobId;
      this.tracker.latestByContextGraph.set(
        input.contextGraphId,
        createdProjection.jobId,
      );
      return createdProjection;
    }

    if (baseJob.includeWorkspace) return baseJob;
    if (upgradeJob) return upgradeJob;

    const createdUpgrade = this.createJob(input.contextGraphId, true);
    coordinator.upgradeJobId = createdUpgrade.jobId;
    this.tracker.latestByContextGraph.set(input.contextGraphId, createdUpgrade.jobId);
    return createdUpgrade;
  }

  /** Start one detached serialized worker for a fresh per-CG catch-up. */
  start(input: {
    contextGraphId: string;
    includeSharedMemory: boolean;
    readinessBeforeCatchup: ContextGraphReadinessProvenance;
  }): CatchupJob {
    const job = this.createJob(input.contextGraphId, input.includeSharedMemory);
    this.tracker.latestByContextGraph.set(input.contextGraphId, job.jobId);
    const coordinator: CatchupCoordinator = {
      contextGraphId: input.contextGraphId,
      baseJobId: job.jobId,
    };
    this.inFlightByContextGraph.set(input.contextGraphId, coordinator);
    this.pruneCompletedJobs();
    void this.run(coordinator, job, input.readinessBeforeCatchup);
    return job;
  }

  private createJob(contextGraphId: string, includeSharedMemory: boolean): CatchupJob {
    const job: CatchupJob = {
      jobId: this.createJobId(),
      contextGraphId,
      includeWorkspace: includeSharedMemory,
      status: 'queued',
      queuedAt: this.now(),
    };
    this.tracker.jobs.set(job.jobId, job);
    return job;
  }

  private pruneCompletedJobs(): void {
    const activeJobIds = new Set<string>();
    for (const coordinator of this.inFlightByContextGraph.values()) {
      activeJobIds.add(coordinator.baseJobId);
      if (coordinator.upgradeJobId) activeJobIds.add(coordinator.upgradeJobId);
      if (coordinator.narrowProjectionJobId) {
        activeJobIds.add(coordinator.narrowProjectionJobId);
      }
    }
    while (this.tracker.jobs.size > 100) {
      let oldest: CatchupJob | undefined;
      for (const candidate of this.tracker.jobs.values()) {
        if (activeJobIds.has(candidate.jobId)) continue;
        if (!oldest || candidate.queuedAt < oldest.queuedAt) oldest = candidate;
      }
      if (!oldest) break;
      this.tracker.jobs.delete(oldest.jobId);
      if (
        this.tracker.latestByContextGraph.get(oldest.contextGraphId) === oldest.jobId
      ) {
        this.tracker.latestByContextGraph.delete(oldest.contextGraphId);
      }
    }
  }

  private async run(
    coordinator: CatchupCoordinator,
    baseJob: CatchupJob,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<void> {
    let attemptJob = baseJob;

    try {
      let readinessBeforeAttempt = readinessBeforeCatchup;
      while (true) {
        await this.runAttempt(attemptJob, readinessBeforeAttempt);
        if (attemptJob === baseJob && baseJob.includeWorkspace) {
          await this.settleNarrowProjection(
            coordinator,
            baseJob,
            readinessBeforeAttempt,
          );
        }
        if (
          coordinator.upgradeJobId &&
          !attemptJob.includeWorkspace &&
          attemptJob.status !== 'denied'
        ) {
          const upgradeJob = this.tracker.jobs.get(coordinator.upgradeJobId);
          if (!upgradeJob) break;
          attemptJob = upgradeJob;
          readinessBeforeAttempt = this.effects.readReadiness(
            coordinator.contextGraphId,
          );
          continue;
        }
        if (!attemptJob.includeWorkspace) {
          this.settleQueuedJobFrom(coordinator.upgradeJobId, attemptJob);
        }
        break;
      }
    } catch (error) {
      attemptJob.error = error instanceof Error ? error.message : String(error);
      attemptJob.status = 'failed';
      attemptJob.finishedAt = this.now();
      this.settleQueuedJobFrom(coordinator.upgradeJobId, attemptJob);
      this.settleQueuedJobFrom(coordinator.narrowProjectionJobId, attemptJob);
      this.effects.trace?.(
        `[catchup] job=${attemptJob.jobId} contextGraph=${coordinator.contextGraphId} threw: ${attemptJob.error}`,
      );
    } finally {
      attemptJob.finishedAt ??= this.now();
      if (this.inFlightByContextGraph.get(coordinator.contextGraphId) === coordinator) {
        this.inFlightByContextGraph.delete(coordinator.contextGraphId);
      }
    }
  }

  private async runAttempt(
    job: CatchupJob,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<void> {
    job.status = 'running';
    job.startedAt ??= this.now();
    this.effects.trace?.(
      `[catchup] job=${job.jobId} contextGraph=${job.contextGraphId} started`,
    );
    const result = await this.effects.runner.run({
      contextGraphId: job.contextGraphId,
      includeSharedMemory: job.includeWorkspace,
    });
    await this.applyResult(job, result, readinessBeforeCatchup, true);
  }

  private async applyResult(
    job: CatchupJob,
    result: CatchupJobResult,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
    applyEffects: boolean,
  ): Promise<void> {
    job.result = result;
    job.error = undefined;

    if (result.deferredBackpressure > 0 && !result.denied) {
      job.status = 'deferred';
      job.error = 'Sync deferred by local scheduler backpressure; retry when capacity is available.';
    } else {
      const inspectReadiness = catchupResultHasCleanResponse(result);
      const hasConfirmedMeta = inspectReadiness
        ? await this.effects.hasConfirmedMeta(job.contextGraphId)
        : false;
      const isPrivate = hasConfirmedMeta
        ? await this.effects.isPrivate(job.contextGraphId)
        : false;
      const classification = classifyContextGraphCatchupReadiness({
        result,
        includeSharedMemory: job.includeWorkspace,
        hasConfirmedMeta,
        isPrivate,
        readinessBeforeCatchup,
      });
      job.status = classification.jobStatus;
      job.error = classification.error;
      if (applyEffects && classification.readinessPatch) {
        this.effects.writeReadiness(job.contextGraphId, classification.readinessPatch);
      }
      if (applyEffects && classification.statePatch) {
        this.effects.markSubscriptionState(
          job.contextGraphId,
          classification.statePatch,
        );
      }
      if (applyEffects && classification.eventPayload) {
        this.effects.emitProjectSynced(
          job.contextGraphId,
          classification.eventPayload,
        );
      }
      if (job.status === 'done' && result.deferredBackpressure > 0) {
        job.status = 'deferred';
        job.error = 'Sync deferred by local scheduler backpressure; retry when capacity is available.';
      }
    }
    job.finishedAt = this.now();
    this.effects.trace?.(
      `[catchup] job=${job.jobId} contextGraph=${job.contextGraphId} status=${job.status} ` +
        `peers=${result.peersTried}/${result.syncCapablePeers} ` +
        `connected=${result.totalPeers ?? result.connectedPeers} ` +
        `data=${result.dataSynced} swm=${result.sharedMemorySynced} denied=${result.denied}`,
    );
  }

  private settleQueuedJobFrom(
    targetJobId: string | undefined,
    source: CatchupJob,
  ): void {
    const target = targetJobId ? this.tracker.jobs.get(targetJobId) : undefined;
    if (!target || target.status !== 'queued') return;
    target.status = source.status;
    target.error = source.error;
    target.result = source.result;
    target.startedAt = source.startedAt;
    target.finishedAt = this.now();
  }

  private async settleNarrowProjection(
    coordinator: CatchupCoordinator,
    source: CatchupJob,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<void> {
    const projection = coordinator.narrowProjectionJobId
      ? this.tracker.jobs.get(coordinator.narrowProjectionJobId)
      : undefined;
    if (!projection || projection.status !== 'queued') return;

    if (!source.result || source.status === 'failed') {
      this.settleQueuedJobFrom(coordinator.narrowProjectionJobId, source);
      return;
    }

    projection.status = 'running';
    projection.startedAt = source.startedAt;
    try {
      await this.applyResult(
        projection,
        source.result,
        readinessBeforeCatchup,
        false,
      );
    } catch (error) {
      projection.status = 'failed';
      projection.error = error instanceof Error ? error.message : String(error);
      projection.finishedAt = this.now();
    }
  }
}
