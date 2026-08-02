import type { ContextGraphReadinessProvenance } from '@origintrail-official/dkg-node-ui';
import type { CatchupRunner } from '../catchup-runner.js';
import type { CatchupJobResult } from '../catchup-result-wire.js';
import {
  catchupResultHasCleanResponse,
  classifyContextGraphCatchupReadiness,
  type ContextGraphCatchupReadinessClassification,
} from '../context-graph-readiness.js';
import type {
  CatchupCoordinator,
  CatchupExecution,
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

type CatchupResultClassification =
  | ContextGraphCatchupReadinessClassification
  | {
      jobStatus: 'deferred';
      error: string;
      readinessPatch?: undefined;
      statePatch?: undefined;
      eventPayload?: undefined;
    };

/** Normalize the explicitly optional legacy tracker boundary exactly once. */
export function getOrCreateCatchupCoordinatorIndex(
  tracker: CatchupTracker,
): Map<string, CatchupCoordinator> {
  const existing = tracker.inFlightByContextGraph;
  if (existing) return existing;
  const created = new Map<string, CatchupCoordinator>();
  tracker.inFlightByContextGraph = created;
  return created;
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
    this.inFlightByContextGraph = getOrCreateCatchupCoordinatorIndex(tracker);
  }

  /** Reuse active work while preserving each caller's immutable plane scope. */
  coalesceActive(input: {
    contextGraphId: string;
    includeSharedMemory: boolean;
  }): CatchupJob | undefined {
    const coordinator = this.inFlightByContextGraph.get(input.contextGraphId);
    if (!coordinator) return undefined;
    const hasActiveExecution = coordinator.executions.some((execution) => {
      const job = this.tracker.jobs.get(execution.jobId);
      return job?.status === 'queued' || job?.status === 'running';
    });
    if (!hasActiveExecution) return undefined;

    const requestedScope = this.toScope(input.includeSharedMemory);
    const existingView = coordinator.viewsByScope.get(requestedScope);
    if (existingView) {
      const existingJob = this.tracker.jobs.get(existingView.jobId);
      if (existingJob) return this.markLatest(existingJob);
    }

    if (requestedScope === 'durable') {
      const broadExecution = coordinator.executions.find((execution) =>
        execution.scope === 'durable-and-shared-memory' &&
        this.isExecutionActive(execution));
      if (!broadExecution) return undefined;

      const projection = this.createJob(input.contextGraphId, requestedScope);
      coordinator.viewsByScope.set(requestedScope, {
        jobId: projection.jobId,
        scope: requestedScope,
        sourceExecutionJobId: broadExecution.jobId,
        kind: 'projection',
      });
      return this.markLatest(projection);
    }

    const upgrade = this.createJob(input.contextGraphId, requestedScope);
    const execution: CatchupExecution = {
      jobId: upgrade.jobId,
      scope: requestedScope,
    };
    coordinator.executions.push(execution);
    coordinator.viewsByScope.set(requestedScope, {
      jobId: upgrade.jobId,
      scope: requestedScope,
      kind: 'execution',
    });
    return this.markLatest(upgrade);
  }

  /** Start one detached serialized worker for a fresh per-CG catch-up. */
  start(input: {
    contextGraphId: string;
    includeSharedMemory: boolean;
    readinessBeforeCatchup: ContextGraphReadinessProvenance;
  }): CatchupJob {
    const scope = this.toScope(input.includeSharedMemory);
    const job = this.createJob(input.contextGraphId, scope);
    const execution: CatchupExecution = { jobId: job.jobId, scope };
    const coordinator: CatchupCoordinator = {
      contextGraphId: input.contextGraphId,
      executions: [execution],
      viewsByScope: new Map([
        [scope, {
          jobId: job.jobId,
          scope,
          kind: 'execution',
        }],
      ]),
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
      includeWorkspace: scope === 'durable-and-shared-memory',
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

  private isExecutionActive(execution: CatchupExecution): boolean {
    const job = this.tracker.jobs.get(execution.jobId);
    return job?.status === 'queued' || job?.status === 'running';
  }

  private pruneCompletedJobs(): void {
    const activeJobIds = new Set<string>();
    for (const coordinator of this.inFlightByContextGraph.values()) {
      for (const view of coordinator.viewsByScope.values()) {
        activeJobIds.add(view.jobId);
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
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<void> {
    try {
      for (let index = 0; index < coordinator.executions.length; index += 1) {
        const execution = coordinator.executions[index];
        const job = this.tracker.jobs.get(execution.jobId);
        if (!job || job.status !== 'queued') continue;
        const readinessBeforeAttempt = index === 0
          ? readinessBeforeCatchup
          : this.effects.readReadiness(coordinator.contextGraphId);

        try {
          const attempt = await this.runAttempt(job, readinessBeforeAttempt);
          await this.settleProjectionViews(
            coordinator,
            execution,
            attempt.result,
            readinessBeforeAttempt,
          );
          if (attempt.status === 'denied') {
            this.settleRemainingExecutionsFrom(coordinator, index + 1, job);
            break;
          }
        } catch (error) {
          job.error = error instanceof Error ? error.message : String(error);
          job.status = 'failed';
          job.finishedAt = this.now();
          this.settleProjectionViewsFrom(coordinator, execution, job);
          this.settleRemainingExecutionsFrom(coordinator, index + 1, job);
          this.effects.trace?.(
            `[catchup] job=${job.jobId} contextGraph=${coordinator.contextGraphId} threw: ${job.error}`,
          );
          break;
        }
      }
    } finally {
      if (this.inFlightByContextGraph.get(coordinator.contextGraphId) === coordinator) {
        this.inFlightByContextGraph.delete(coordinator.contextGraphId);
      }
    }
  }

  private async runAttempt(
    job: CatchupJob,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<{ result: CatchupJobResult; status: CatchupJob['status'] }> {
    job.status = 'running';
    job.startedAt ??= this.now();
    this.effects.trace?.(
      `[catchup] job=${job.jobId} contextGraph=${job.contextGraphId} started`,
    );
    const result = await this.effects.runner.run({
      contextGraphId: job.contextGraphId,
      includeSharedMemory: job.includeWorkspace,
    });
    const classification = await this.classifyResult(
      job,
      result,
      readinessBeforeCatchup,
    );
    this.applyExecutionEffects(job.contextGraphId, classification);
    this.settleClassifiedJob(job, result, classification);
    return { result, status: job.status };
  }

  private async classifyResult(
    job: CatchupJob,
    result: CatchupJobResult,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<CatchupResultClassification> {
    if (result.deferredBackpressure > 0 && !result.denied) {
      return {
        jobStatus: 'deferred' as const,
        error: 'Sync deferred by local scheduler backpressure; retry when capacity is available.',
        readinessPatch: undefined,
        statePatch: undefined,
        eventPayload: undefined,
      };
    }

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
    // Denial can coexist with usable data from another peer. If local
    // admission also deferred part of that mixed round, the clean data must
    // not turn the attempt into success: finalizeCatchup deliberately leaves
    // any backpressured round incomplete. Preserve a pure ACL denial, but
    // downgrade an otherwise-successful mixed result before effects are
    // applied so no readiness bit is frozen from partial work.
    if (result.deferredBackpressure > 0 && classification.jobStatus === 'done') {
      return {
        jobStatus: 'deferred',
        error: 'Sync deferred by local scheduler backpressure; retry when capacity is available.',
      };
    }
    return classification;
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

  private async settleProjectionViews(
    coordinator: CatchupCoordinator,
    execution: CatchupExecution,
    result: CatchupJobResult,
    readinessBeforeCatchup: ContextGraphReadinessProvenance,
  ): Promise<void> {
    const source = this.tracker.jobs.get(execution.jobId);
    if (!source) return;
    for (const view of coordinator.viewsByScope.values()) {
      if (
        view.kind !== 'projection' ||
        view.sourceExecutionJobId !== execution.jobId
      ) continue;
      const projection = this.tracker.jobs.get(view.jobId);
      if (!projection || projection.status !== 'queued') continue;
      projection.status = 'running';
      projection.startedAt = source.startedAt;
      try {
        const classification = await this.classifyResult(
          projection,
          result,
          readinessBeforeCatchup,
        );
        this.settleClassifiedJob(projection, result, classification);
      } catch (error) {
        projection.status = 'failed';
        projection.error = error instanceof Error ? error.message : String(error);
        projection.finishedAt = this.now();
      }
    }
  }

  private settleProjectionViewsFrom(
    coordinator: CatchupCoordinator,
    execution: CatchupExecution,
    source: CatchupJob,
  ): void {
    for (const view of coordinator.viewsByScope.values()) {
      if (
        view.kind === 'projection' &&
        view.sourceExecutionJobId === execution.jobId
      ) {
        this.settleQueuedJobFrom(view.jobId, source);
      }
    }
  }

  private settleRemainingExecutionsFrom(
    coordinator: CatchupCoordinator,
    startIndex: number,
    source: CatchupJob,
  ): void {
    for (const execution of coordinator.executions.slice(startIndex)) {
      this.settleQueuedJobFrom(execution.jobId, source);
      this.settleProjectionViewsFrom(coordinator, execution, source);
    }
  }
}
