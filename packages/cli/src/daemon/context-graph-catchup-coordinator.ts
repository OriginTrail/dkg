import type { ContextGraphReadinessProvenance } from '@origintrail-official/dkg-node-ui';
import type { CatchupRunner } from '../catchup-runner.js';
import type { CatchupJobResult } from '../catchup-result-wire.js';
import {
  catchupClassificationNeedsMetadata,
  classifyContextGraphCatchupReadiness,
  type ContextGraphCatchupReadinessClassification,
} from '../context-graph-readiness.js';
import type {
  CatchupCoordinator,
  CatchupJob,
  CatchupScope,
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

type CatchupResultClassification = ContextGraphCatchupReadinessClassification;

export class ContextGraphCatchupCoordinatorService {
  private readonly now: () => number;
  private readonly createJobId: () => string;
  private readonly inFlightByContextGraph = new Map<string, CatchupCoordinator>();

  constructor(
    private readonly tracker: CatchupTracker,
    private readonly effects: ContextGraphCatchupCoordinatorEffects,
  ) {
    this.now = effects.now ?? Date.now;
    this.createJobId = effects.createJobId ?? (() =>
      `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  }

  /** Reuse active work while preserving each caller's immutable plane scope. */
  coalesceActive(input: {
    contextGraphId: string;
    includeSharedMemory: boolean;
  }): CatchupJob | undefined {
    const coordinator = this.inFlightByContextGraph.get(input.contextGraphId);
    if (!coordinator) return undefined;
    if (!this.hasActiveJob(coordinator)) return undefined;

    const requestedScope = this.toScope(input.includeSharedMemory);
    const existingJobId = this.jobIdForScope(coordinator, requestedScope);
    if (existingJobId) {
      const existingJob = this.tracker.jobs.get(existingJobId);
      if (existingJob) return this.markLatest(existingJob);
    }

    if (requestedScope === 'durable') {
      if (coordinator.initialScope !== 'durable-and-shared-memory') return undefined;
      const durable = this.createJob(input.contextGraphId, requestedScope);
      coordinator.durableJobId = durable.jobId;
      return this.markLatest(durable);
    }

    if (coordinator.initialScope !== 'durable') return undefined;
    const full = this.createJob(input.contextGraphId, requestedScope);
    coordinator.fullJobId = full.jobId;
    return this.markLatest(full);
  }

  /** Start one detached serialized worker for a fresh per-CG catch-up. */
  start(input: {
    contextGraphId: string;
    includeSharedMemory: boolean;
    readinessBeforeCatchup: ContextGraphReadinessProvenance;
  }): CatchupJob {
    const scope = this.toScope(input.includeSharedMemory);
    const job = this.createJob(input.contextGraphId, scope);
    const coordinator: CatchupCoordinator = {
      contextGraphId: input.contextGraphId,
      initialScope: scope,
      ...(scope === 'durable'
        ? { durableJobId: job.jobId }
        : { fullJobId: job.jobId }),
    };
    this.inFlightByContextGraph.set(input.contextGraphId, coordinator);
    this.pruneCompletedJobs();
    void this.run(coordinator, input.readinessBeforeCatchup);
    return this.markLatest(job);
  }

  private toScope(includeSharedMemory: boolean): CatchupScope {
    return includeSharedMemory ? 'durable-and-shared-memory' : 'durable';
  }

  private createJob(contextGraphId: string, scope: CatchupScope): CatchupJob {
    const job: CatchupJob = {
      jobId: this.createJobId(),
      contextGraphId,
      includeSharedMemory: scope === 'durable-and-shared-memory',
      status: 'queued',
      queuedAt: this.now(),
    };
    this.tracker.jobs.set(job.jobId, job);
    return job;
  }

  private markLatest(job: CatchupJob): CatchupJob {
    this.tracker.latestByContextGraph.set(job.contextGraphId, job.jobId);
    return job;
  }

  private jobIdForScope(
    coordinator: CatchupCoordinator,
    scope: CatchupScope,
  ): string | undefined {
    return scope === 'durable'
      ? coordinator.durableJobId
      : coordinator.fullJobId;
  }

  private hasActiveJob(coordinator: CatchupCoordinator): boolean {
    return [coordinator.durableJobId, coordinator.fullJobId].some((jobId) => {
      if (!jobId) return false;
      const job = this.tracker.jobs.get(jobId);
      return job?.status === 'queued' || job?.status === 'running';
    });
  }

  private pruneCompletedJobs(): void {
    const activeJobIds = new Set<string>();
    for (const coordinator of this.inFlightByContextGraph.values()) {
      if (coordinator.durableJobId) activeJobIds.add(coordinator.durableJobId);
      if (coordinator.fullJobId) activeJobIds.add(coordinator.fullJobId);
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
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<void> {
    try {
      if (coordinator.initialScope === 'durable') {
        await this.runDurableFirst(coordinator, readinessBeforeCatchup);
      } else {
        await this.runFullFirst(coordinator, readinessBeforeCatchup);
      }
    } finally {
      if (this.inFlightByContextGraph.get(coordinator.contextGraphId) === coordinator) {
        this.inFlightByContextGraph.delete(coordinator.contextGraphId);
      }
    }
  }

  private async runDurableFirst(
    coordinator: CatchupCoordinator,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<void> {
    const durable = coordinator.durableJobId
      ? this.tracker.jobs.get(coordinator.durableJobId)
      : undefined;
    if (!durable || durable.status !== 'queued') return;
    try {
      const attempt = await this.runAttempt(durable, readinessBeforeCatchup);
      if (attempt.status === 'denied') {
        this.settleFullSlotFrom(coordinator, durable);
        return;
      }
    } catch (error) {
      this.settleThrownJob(durable, error);
      this.settleFullSlotFrom(coordinator, durable);
      return;
    }

    const full = coordinator.fullJobId
      ? this.tracker.jobs.get(coordinator.fullJobId)
      : undefined;
    if (!full || full.status !== 'queued') return;
    try {
      await this.runAttempt(full, this.effects.readReadiness(coordinator.contextGraphId));
    } catch (error) {
      this.settleThrownJob(full, error);
    }
  }

  private async runFullFirst(
    coordinator: CatchupCoordinator,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<void> {
    const full = coordinator.fullJobId
      ? this.tracker.jobs.get(coordinator.fullJobId)
      : undefined;
    if (!full || full.status !== 'queued') return;
    try {
      const attempt = await this.runAttempt(full, readinessBeforeCatchup);
      await this.settleDurableSlot(
        coordinator,
        full,
        attempt.result,
        readinessBeforeCatchup,
        this.classificationHasEffects(attempt.classification),
      );
    } catch (error) {
      this.settleThrownJob(full, error);
      this.settleDurableSlotFrom(coordinator, full);
    }
  }

  private settleThrownJob(job: CatchupJob, error: unknown): void {
    job.error = error instanceof Error ? error.message : String(error);
    job.status = 'failed';
    job.finishedAt = this.now();
    this.effects.trace?.(
      `[catchup] job=${job.jobId} contextGraph=${job.contextGraphId} threw: ${job.error}`,
    );
  }

  private async runAttempt(
    job: CatchupJob,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<{
    result: CatchupJobResult;
    status: CatchupJob['status'];
    classification: CatchupResultClassification;
  }> {
    job.status = 'running';
    job.startedAt ??= this.now();
    this.effects.trace?.(
      `[catchup] job=${job.jobId} contextGraph=${job.contextGraphId} started`,
    );
    const result = await this.effects.runner.run({
      contextGraphId: job.contextGraphId,
      includeSharedMemory: job.includeSharedMemory,
    });
    const classification = await this.classifyResult(
      job,
      result,
      readinessBeforeCatchup,
    );
    this.applyExecutionEffects(job.contextGraphId, classification);
    this.settleClassifiedJob(job, result, classification);
    return { result, status: job.status, classification };
  }

  private classificationHasEffects(
    classification: CatchupResultClassification,
  ): boolean {
    return classification.readinessPatch !== undefined ||
      classification.statePatch !== undefined ||
      classification.eventPayload !== undefined;
  }

  private async classifyResult(
    job: CatchupJob,
    result: CatchupJobResult,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<CatchupResultClassification> {
    const inspectReadiness = catchupClassificationNeedsMetadata({
      result,
      includeSharedMemory: job.includeSharedMemory,
    });
    const hasConfirmedMeta = inspectReadiness
      ? await this.effects.hasConfirmedMeta(job.contextGraphId)
      : false;
    const isPrivate = hasConfirmedMeta
      ? await this.effects.isPrivate(job.contextGraphId)
      : false;
    return classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: job.includeSharedMemory,
      hasConfirmedMeta,
      isPrivate,
      readinessBeforeCatchup,
    });
  }

  private applyExecutionEffects(
    contextGraphId: string,
    classification: CatchupResultClassification,
  ): void {
    if (classification.readinessPatch) {
      this.effects.writeReadiness(contextGraphId, classification.readinessPatch);
    }
    if (classification.statePatch) {
      this.effects.markSubscriptionState(contextGraphId, classification.statePatch);
    }
    if (classification.eventPayload) {
      this.effects.emitProjectSynced(contextGraphId, classification.eventPayload);
    }
  }

  private settleClassifiedJob(
    job: CatchupJob,
    result: CatchupJobResult,
    classification: CatchupResultClassification,
  ): void {
    job.result = result;
    job.status = classification.jobStatus;
    job.error = classification.error;
    job.finishedAt = this.now();
    this.effects.trace?.(
      `[catchup] job=${job.jobId} contextGraph=${job.contextGraphId} status=${job.status} ` +
        `peers=${result.peersTried}/${result.syncCapablePeers} ` +
        `connected=${result.totalPeers ?? result.connectedPeers} ` +
        `data=${result.dataSynced} swm=${result.sharedMemorySynced} denied=${result.denied}`,
    );
  }

  private settleQueuedJobFrom(targetJobId: string, source: CatchupJob): void {
    const target = this.tracker.jobs.get(targetJobId);
    if (!target || target.status !== 'queued') return;
    target.status = source.status;
    target.error = source.error;
    target.result = source.result;
    target.startedAt = source.startedAt;
    target.finishedAt = this.now();
  }

  private async settleDurableSlot(
    coordinator: CatchupCoordinator,
    full: CatchupJob,
    result: CatchupJobResult,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
    sourceAppliedEffects: boolean,
  ): Promise<void> {
    const durable = coordinator.durableJobId
      ? this.tracker.jobs.get(coordinator.durableJobId)
      : undefined;
    if (!durable || durable.status !== 'queued') return;
    durable.status = 'running';
    durable.startedAt = full.startedAt;
    try {
      const classification = await this.classifyResult(
        durable,
        result,
        readinessBeforeCatchup,
      );
      // Full success already persisted every plane. When the full attempt had
      // no effects (for example SWM-only local deferral), the independently
      // successful durable slot owns its scoped readiness and event instead.
      if (!sourceAppliedEffects) {
        this.applyExecutionEffects(durable.contextGraphId, classification);
      }
      this.settleClassifiedJob(durable, result, classification);
    } catch (error) {
      this.settleThrownJob(durable, error);
    }
  }

  private settleDurableSlotFrom(
    coordinator: CatchupCoordinator,
    source: CatchupJob,
  ): void {
    if (coordinator.durableJobId) {
      this.settleQueuedJobFrom(coordinator.durableJobId, source);
    }
  }

  private settleFullSlotFrom(
    coordinator: CatchupCoordinator,
    source: CatchupJob,
  ): void {
    if (coordinator.fullJobId) {
      this.settleQueuedJobFrom(coordinator.fullJobId, source);
    }
  }
}
