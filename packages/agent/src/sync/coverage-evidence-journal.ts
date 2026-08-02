import { randomUUID } from 'node:crypto';

export const SYNC_COVERAGE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_SYNC_COVERAGE_EVIDENCE_CAPACITY = 256;
export const MAX_SYNC_COVERAGE_EVIDENCE_CONTEXT_GRAPHS = 32;
const MAX_SYNC_COVERAGE_EVIDENCE_CONTEXT_GRAPH_ID_LENGTH = 256;

export type SyncCoverageEvidenceState = 'running' | 'complete' | 'failed';
export type SyncCoverageEvidenceTrigger =
  | 'connection-open'
  | 'peer-update'
  | 'periodic-reconciler';

export interface SyncCoverageVerifiedPlanes {
  metadata: boolean;
  durable: boolean;
  sharedMemory: boolean;
}

interface SyncCoverageEvidenceBase {
  sequence: number;
  waveId: string;
  jobId: string;
  state: SyncCoverageEvidenceState;
  startedAt: number;
  finishedAt?: number;
}

export interface EdgeReconcilerSyncCoverageEvidence extends SyncCoverageEvidenceBase {
  kind: 'edge-reconciler-job';
  contextGraphId: string;
  source: 'reconciler';
  trigger: 'periodic-reconciler';
  syncMode: 'always-on';
  rehydratedSelectionCount: number;
  evidenceTruncated: boolean;
  verified: SyncCoverageVerifiedPlanes;
}

export interface CoreAutomaticSyncCoverageCompletion {
  jobId: string;
  contextGraphId: string;
  state: SyncCoverageEvidenceState;
  verified: SyncCoverageVerifiedPlanes;
  finishedAt?: number;
}

export interface CoreAutomaticSyncCoverageEvidence extends SyncCoverageEvidenceBase {
  kind: 'core-automatic-round';
  planningLane: string;
  source: 'automatic-core-public';
  trigger: SyncCoverageEvidenceTrigger;
  configuredBatchSize: number;
  effectiveBatchSize: number;
  explicitSelectedContextGraphIds: string[];
  explicitSelectedContextGraphCount: number;
  automaticContextGraphIds: string[];
  automaticContextGraphCount: number;
  evidenceTruncated: boolean;
  completions: CoreAutomaticSyncCoverageCompletion[];
}

export type SyncCoverageEvidenceEntry =
  | EdgeReconcilerSyncCoverageEvidence
  | CoreAutomaticSyncCoverageEvidence;
type EdgeReconcilerSyncCoverageDraft = Omit<
  EdgeReconcilerSyncCoverageEvidence,
  'sequence' | 'waveId'
>;
type CoreAutomaticSyncCoverageDraft = Omit<
  CoreAutomaticSyncCoverageEvidence,
  'sequence' | 'waveId'
>;

export interface StartCoreAutomaticRoundInput {
  planningLane: string;
  trigger: SyncCoverageEvidenceTrigger;
  configuredBatchSize: number;
  effectiveBatchSize: number;
  explicitSelectedContextGraphIds: readonly string[];
  automaticContextGraphIds: readonly string[];
  startedAt: number;
}

export interface StartEdgeReconcilerJobsInput {
  contextGraphIds: readonly string[];
  startedAt: number;
}

export interface FinishSyncCoverageEvidenceInput {
  operationCompleted: boolean;
  verifiedByContextGraph: ReadonlyMap<string, SyncCoverageVerifiedPlanes>;
  finishedAt: number;
}

const syncCoverageEvidenceHandleBrand = Symbol('syncCoverageEvidenceHandle');

export interface CoreAutomaticRoundHandle {
  readonly [syncCoverageEvidenceHandleBrand]: true;
  readonly kind: 'core-automatic-round';
  readonly jobId: string;
}

export interface EdgeReconcilerJobHandle {
  readonly [syncCoverageEvidenceHandleBrand]: true;
  readonly kind: 'edge-reconciler-job';
  readonly jobId: string;
  readonly contextGraphId: string;
}

export interface SyncCoverageEvidenceSnapshotV1 {
  schemaVersion: typeof SYNC_COVERAGE_EVIDENCE_SCHEMA_VERSION;
  processStartedAt: number;
  waveId: string;
  capacity: number;
  nextSequence: number;
  droppedBeforeSequence: number;
  entries: SyncCoverageEvidenceEntry[];
}

function cloneVerified(verified: SyncCoverageVerifiedPlanes): SyncCoverageVerifiedPlanes {
  return { ...verified };
}

function cloneEntry(entry: SyncCoverageEvidenceEntry): SyncCoverageEvidenceEntry {
  if (entry.kind === 'edge-reconciler-job') {
    return { ...entry, verified: cloneVerified(entry.verified) };
  }
  return {
    ...entry,
    explicitSelectedContextGraphIds: [...entry.explicitSelectedContextGraphIds],
    automaticContextGraphIds: [...entry.automaticContextGraphIds],
    completions: entry.completions.map((completion) => ({
      ...completion,
      verified: cloneVerified(completion.verified),
    })),
  };
}

/**
 * Process-local, append-only operator evidence. State transitions append a new
 * immutable row so polling with afterSequence never misses a terminal update.
 */
export class SyncCoverageEvidenceJournal {
  private readonly entries: SyncCoverageEvidenceEntry[] = [];
  private readonly runningByJobId = new Map<string, SyncCoverageEvidenceEntry>();
  private nextSequence = 1;
  private droppedBeforeSequence = 0;

  constructor(
    readonly processStartedAt: number,
    readonly waveId: string,
    private readonly capacity = DEFAULT_SYNC_COVERAGE_EVIDENCE_CAPACITY,
  ) {
    if (!Number.isSafeInteger(processStartedAt) || processStartedAt < 0) {
      throw new TypeError('sync coverage evidence processStartedAt must be a non-negative safe integer');
    }
    if (!waveId.trim()) {
      throw new TypeError('sync coverage evidence waveId must be non-empty');
    }
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new TypeError('sync coverage evidence capacity must be a positive safe integer');
    }
  }

  private append(draft: EdgeReconcilerSyncCoverageDraft): EdgeReconcilerSyncCoverageEvidence;
  private append(draft: CoreAutomaticSyncCoverageDraft): CoreAutomaticSyncCoverageEvidence;
  private append(
    draft: EdgeReconcilerSyncCoverageDraft | CoreAutomaticSyncCoverageDraft,
  ): SyncCoverageEvidenceEntry {
    const entry = cloneEntry({
      ...draft,
      sequence: this.nextSequence,
      waveId: this.waveId,
    } as SyncCoverageEvidenceEntry);
    this.nextSequence += 1;
    this.entries.push(entry);
    while (this.entries.length > this.capacity) {
      const dropped = this.entries.shift();
      if (dropped) this.droppedBeforeSequence = dropped.sequence;
    }
    return cloneEntry(entry);
  }

  startCoreAutomaticRound(
    input: StartCoreAutomaticRoundInput,
  ): CoreAutomaticRoundHandle {
    const explicitSelected = boundedSyncCoverageContextGraphIds(
      input.explicitSelectedContextGraphIds,
    );
    const automatic = boundedSyncCoverageContextGraphIds(input.automaticContextGraphIds);
    const jobId = randomUUID();
    const running = this.append({
      kind: 'core-automatic-round',
      jobId,
      planningLane: input.planningLane,
      source: 'automatic-core-public',
      trigger: input.trigger,
      configuredBatchSize: input.configuredBatchSize,
      effectiveBatchSize: input.effectiveBatchSize,
      explicitSelectedContextGraphIds: explicitSelected.ids,
      explicitSelectedContextGraphCount: explicitSelected.count,
      automaticContextGraphIds: automatic.ids,
      automaticContextGraphCount: automatic.count,
      evidenceTruncated: explicitSelected.truncated || automatic.truncated,
      state: 'running',
      startedAt: input.startedAt,
      completions: automatic.ids.map((contextGraphId) => ({
        jobId,
        contextGraphId,
        state: 'running' as const,
        verified: { metadata: false, durable: false, sharedMemory: false },
      })),
    });
    this.runningByJobId.set(jobId, cloneEntry(running));
    return Object.freeze({
      [syncCoverageEvidenceHandleBrand]: true as const,
      kind: 'core-automatic-round',
      jobId,
    });
  }

  finishCoreAutomaticRound(
    handle: CoreAutomaticRoundHandle,
    input: FinishSyncCoverageEvidenceInput,
  ): CoreAutomaticSyncCoverageEvidence {
    const running = this.takeRunning(handle);
    if (running.kind !== 'core-automatic-round') {
      throw new TypeError('sync coverage evidence handle kind does not match Core round');
    }
    const completions: CoreAutomaticSyncCoverageCompletion[] = running.completions.map(
      (completion) => {
        const verified = input.verifiedByContextGraph.get(completion.contextGraphId)
          ?? { metadata: false, durable: false, sharedMemory: false };
        return {
          ...completion,
          state: input.operationCompleted && verifiedPlanesComplete(verified)
            ? 'complete'
            : 'failed',
          verified,
          finishedAt: input.finishedAt,
        };
      },
    );
    return this.append({
      kind: 'core-automatic-round',
      jobId: running.jobId,
      planningLane: running.planningLane,
      source: 'automatic-core-public',
      trigger: running.trigger,
      configuredBatchSize: running.configuredBatchSize,
      effectiveBatchSize: running.effectiveBatchSize,
      explicitSelectedContextGraphIds: running.explicitSelectedContextGraphIds,
      explicitSelectedContextGraphCount: running.explicitSelectedContextGraphCount,
      automaticContextGraphIds: running.automaticContextGraphIds,
      automaticContextGraphCount: running.automaticContextGraphCount,
      evidenceTruncated: running.evidenceTruncated,
      state: input.operationCompleted
        && !running.evidenceTruncated
        && completions.length === running.automaticContextGraphCount
        && completions.every((completion) => completion.state === 'complete')
          ? 'complete'
          : 'failed',
      startedAt: running.startedAt,
      finishedAt: input.finishedAt,
      completions,
    });
  }

  startEdgeReconcilerJobs(
    input: StartEdgeReconcilerJobsInput,
  ): EdgeReconcilerJobHandle[] {
    const bounded = boundedSyncCoverageContextGraphIds(input.contextGraphIds);
    return bounded.ids.map((contextGraphId) => {
      const jobId = randomUUID();
      const running = this.append({
        kind: 'edge-reconciler-job',
        jobId,
        contextGraphId,
        source: 'reconciler',
        trigger: 'periodic-reconciler',
        syncMode: 'always-on',
        rehydratedSelectionCount: bounded.count,
        evidenceTruncated: bounded.truncated,
        state: 'running',
        verified: { metadata: false, durable: false, sharedMemory: false },
        startedAt: input.startedAt,
      });
      this.runningByJobId.set(jobId, cloneEntry(running));
      return Object.freeze({
        [syncCoverageEvidenceHandleBrand]: true as const,
        kind: 'edge-reconciler-job',
        jobId,
        contextGraphId,
      });
    });
  }

  finishEdgeReconcilerJob(
    handle: EdgeReconcilerJobHandle,
    input: FinishSyncCoverageEvidenceInput,
  ): EdgeReconcilerSyncCoverageEvidence {
    const running = this.takeRunning(handle);
    if (running.kind !== 'edge-reconciler-job') {
      throw new TypeError('sync coverage evidence handle kind does not match Edge job');
    }
    const verified = input.verifiedByContextGraph.get(running.contextGraphId)
      ?? { metadata: false, durable: false, sharedMemory: false };
    return this.append({
      kind: 'edge-reconciler-job',
      jobId: running.jobId,
      contextGraphId: running.contextGraphId,
      source: 'reconciler',
      trigger: 'periodic-reconciler',
      syncMode: 'always-on',
      rehydratedSelectionCount: running.rehydratedSelectionCount,
      evidenceTruncated: running.evidenceTruncated,
      state: input.operationCompleted
        && !running.evidenceTruncated
        && verifiedPlanesComplete(verified)
          ? 'complete'
          : 'failed',
      verified,
      startedAt: running.startedAt,
      finishedAt: input.finishedAt,
    });
  }

  snapshot(afterSequence = 0): SyncCoverageEvidenceSnapshotV1 {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError('afterSequence must be a non-negative safe integer');
    }
    return {
      schemaVersion: SYNC_COVERAGE_EVIDENCE_SCHEMA_VERSION,
      processStartedAt: this.processStartedAt,
      waveId: this.waveId,
      capacity: this.capacity,
      nextSequence: this.nextSequence,
      droppedBeforeSequence: this.droppedBeforeSequence,
      entries: this.entries
        .filter((entry) => entry.sequence > afterSequence)
        .map(cloneEntry),
    };
  }

  private takeRunning(
    handle: CoreAutomaticRoundHandle | EdgeReconcilerJobHandle,
  ): SyncCoverageEvidenceEntry {
    if (handle[syncCoverageEvidenceHandleBrand] !== true) {
      throw new TypeError('sync coverage evidence handle was not issued by this module');
    }
    const running = this.runningByJobId.get(handle.jobId);
    if (!running || running.kind !== handle.kind) {
      throw new TypeError('sync coverage evidence handle is unknown or already finished');
    }
    this.runningByJobId.delete(handle.jobId);
    return cloneEntry(running);
  }
}

function verifiedPlanesComplete(verified: SyncCoverageVerifiedPlanes): boolean {
  return verified.metadata && verified.durable && verified.sharedMemory;
}

export function boundedSyncCoverageContextGraphIds(
  contextGraphIds: readonly string[],
): { ids: string[]; count: number; truncated: boolean } {
  const unique = [...new Set(contextGraphIds)];
  const boundedIds = unique
    .filter((contextGraphId) =>
      contextGraphId.length <= MAX_SYNC_COVERAGE_EVIDENCE_CONTEXT_GRAPH_ID_LENGTH)
    .slice(0, MAX_SYNC_COVERAGE_EVIDENCE_CONTEXT_GRAPHS);
  return {
    ids: boundedIds,
    count: unique.length,
    truncated: boundedIds.length !== unique.length,
  };
}
