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

export type SyncCoverageEvidenceDraft =
  | Omit<EdgeReconcilerSyncCoverageEvidence, 'sequence' | 'waveId'>
  | Omit<CoreAutomaticSyncCoverageEvidence, 'sequence' | 'waveId'>;

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

  append(draft: SyncCoverageEvidenceDraft): SyncCoverageEvidenceEntry {
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
