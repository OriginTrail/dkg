import {
  SyncCoverageEvidenceJournal,
  type CoreAutomaticRoundHandle,
  type EdgeReconcilerJobHandle,
  type SyncCoverageEvidenceTrigger,
  type SyncCoverageVerifiedPlanes,
} from './coverage-evidence-journal.js';
import type {
  SharedMemoryContextGraphResult,
  SharedMemoryContextGraphTerminal,
} from '../dkg-agent-types.js';

export interface SyncCoverageEvidenceRecorderOptions {
  journal: SyncCoverageEvidenceJournal;
  trigger: SyncCoverageEvidenceTrigger | undefined;
  nodeRole: 'edge' | 'core';
  planningLane: string;
  configuredBatchSize: number;
}

export interface SyncCoverageEvidenceRoundInput {
  effectiveBatchSize: number;
  selectedContextGraphIds: readonly string[];
  automaticContextGraphIds: readonly string[];
  durableAlwaysOnEdgeContextGraphIds: readonly string[];
  startedAt?: number;
}

/**
 * Per-peer automatic-sync evidence state. Lifecycle code only reports phase
 * terminals; this recorder owns journal shapes, transitions, and fail-closed
 * completion rules.
 */
export class SyncCoverageEvidenceRecorder {
  private initialized = false;
  private finished = false;
  private coreRunning: CoreAutomaticRoundHandle | undefined;
  private edgeRunning: EdgeReconcilerJobHandle[] = [];
  private readonly evidenceContextGraphs = new Set<string>();
  private readonly metadataVerified = new Set<string>();
  private readonly durableVerified = new Set<string>();
  private readonly sharedMemoryVerified = new Set<string>();

  constructor(private readonly options: SyncCoverageEvidenceRecorderOptions) {}

  beginRound(input: SyncCoverageEvidenceRoundInput): void {
    if (this.initialized) return;
    this.initialized = true;
    const trigger = this.options.trigger;
    if (!trigger) return;
    const startedAt = input.startedAt ?? Date.now();
    if (this.options.nodeRole === 'core' && input.automaticContextGraphIds.length > 0) {
      for (const contextGraphId of input.automaticContextGraphIds) {
        this.evidenceContextGraphs.add(contextGraphId);
      }
      this.coreRunning = this.options.journal.startCoreAutomaticRound({
        planningLane: this.options.planningLane,
        trigger,
        configuredBatchSize: this.options.configuredBatchSize,
        effectiveBatchSize: input.effectiveBatchSize,
        explicitSelectedContextGraphIds: input.selectedContextGraphIds,
        automaticContextGraphIds: input.automaticContextGraphIds,
        startedAt,
      });
    }
    if (this.options.nodeRole === 'edge' && trigger === 'periodic-reconciler') {
      for (const contextGraphId of input.durableAlwaysOnEdgeContextGraphIds) {
        this.evidenceContextGraphs.add(contextGraphId);
      }
      this.edgeRunning = this.options.journal.startEdgeReconcilerJobs({
        contextGraphIds: input.durableAlwaysOnEdgeContextGraphIds,
        startedAt,
      });
    }
  }

  hasActiveEvidence(): boolean {
    return this.coreRunning !== undefined || this.edgeRunning.length > 0;
  }

  markMetadata(contextGraphIds: unknown): void {
    if (!this.hasActiveEvidence()) return;
    const verifiedContextGraphIds = iterableStringValues(contextGraphIds);
    if (!verifiedContextGraphIds) return;
    for (const contextGraphId of verifiedContextGraphIds) {
      this.metadataVerified.add(contextGraphId);
    }
  }

  markDurable(contextGraphIds: Iterable<string>, complete: boolean): void {
    if (!complete || !this.hasActiveEvidence()) return;
    for (const contextGraphId of contextGraphIds) {
      this.durableVerified.add(contextGraphId);
    }
  }

  markSharedMemoryResult(result: unknown): void {
    if (!this.hasActiveEvidence()) return;
    let outcomes: unknown;
    try {
      if (typeof result !== 'object' || result === null) return;
      outcomes = (result as Record<string, unknown>).contextGraphTerminals;
    } catch {
      return;
    }
    this.markSharedMemory(outcomes);
  }

  markSharedMemory(outcomes: unknown): void {
    if (!this.hasActiveEvidence()) return;
    const verifiedContextGraphIds = verifiedSharedMemoryContextGraphIds(outcomes);
    if (!verifiedContextGraphIds) return;
    for (const contextGraphId of verifiedContextGraphIds) {
      this.sharedMemoryVerified.add(contextGraphId);
    }
  }

  finish(operationCompleted: boolean, finishedAt = Date.now()): void {
    if (this.finished) return;
    this.finished = true;
    const verifiedByContextGraph = new Map<string, SyncCoverageVerifiedPlanes>();
    for (const contextGraphId of this.evidenceContextGraphs) {
      verifiedByContextGraph.set(contextGraphId, {
        metadata: this.metadataVerified.has(contextGraphId),
        durable: this.durableVerified.has(contextGraphId),
        sharedMemory: this.sharedMemoryVerified.has(contextGraphId),
      });
    }
    if (this.coreRunning) {
      this.options.journal.finishCoreAutomaticRound(this.coreRunning, {
        operationCompleted,
        verifiedByContextGraph,
        finishedAt,
      });
    }
    for (const running of this.edgeRunning) {
      this.options.journal.finishEdgeReconcilerJob(running, {
        operationCompleted,
        verifiedByContextGraph,
        finishedAt,
      });
    }
  }
}

function iterableStringValues(value: unknown): string[] | undefined {
  try {
    if (
      (typeof value !== 'object' && typeof value !== 'function')
      || value === null
      || typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function'
    ) {
      return undefined;
    }
    const strings: string[] = [];
    for (const candidate of value as Iterable<unknown>) {
      if (typeof candidate !== 'string') return undefined;
      strings.push(candidate);
    }
    return strings;
  } catch {
    // Legacy JavaScript overrides may return void or hostile iterables. Evidence
    // remains unverified, but observer parsing must never alter sync control flow.
    return undefined;
  }
}

function verifiedSharedMemoryContextGraphIds(outcomes: unknown): string[] | undefined {
  try {
    if (!Array.isArray(outcomes)) return undefined;
    const verifiedContextGraphIds: string[] = [];
    for (const outcome of outcomes) {
      const verifiedContextGraphId = verifiedSharedMemoryContextGraphId(outcome);
      if (verifiedContextGraphId !== undefined) {
        verifiedContextGraphIds.push(verifiedContextGraphId);
      }
    }
    return verifiedContextGraphIds;
  } catch {
    // Evidence is an observer. Host-defined arrays/proxies that throw during
    // inspection make the plane unverifiable, but never alter sync control flow.
    return undefined;
  }
}

function verifiedSharedMemoryContextGraphId(outcome: unknown): string | undefined {
  if (typeof outcome !== 'object' || outcome === null) return undefined;
  const terminal = outcome as Partial<SharedMemoryContextGraphTerminal>;
  if (
    terminal.disposition !== 'settled'
    || typeof terminal.contextGraphId !== 'string'
    || typeof terminal.result !== 'object'
    || terminal.result === null
  ) {
    return undefined;
  }
  return sharedMemoryTerminalCompletedCleanly(terminal.result)
    ? terminal.contextGraphId
    : undefined;
}

function sharedMemoryTerminalCompletedCleanly(
  result: Readonly<SharedMemoryContextGraphResult>,
): boolean {
  return result.failedPhases === 0
    && result.failedPeers === 0
    && result.timedOutPhases === 0
    && result.deniedPhases === 0
    && result.droppedDataTriples === 0
    && (result.backoffWorthyFailures ?? 0) === 0
    && (result.deferredBackpressure ?? 0) === 0
    && result.completedPhases + result.emptyResponses >= 1;
}
