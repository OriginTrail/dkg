import {
  contextGraphPriority,
  type SyncContextGraphPriorityConfig,
} from './policy.js';

export const DEFAULT_CORE_PUBLIC_SYNC_BATCH_SIZE = 8;

export interface CorePublicSyncCoverageStatus {
  enabled: boolean;
  batchSize: number;
  trackedContextGraphs: number;
  planningLanes: number;
  lastPlanAt?: number;
  lastPlan?: {
    selectedContextGraphs: number;
    coverageContextGraphs: number;
    totalContextGraphs: number;
  };
}

export interface CorePublicSyncPlan {
  contextGraphIds: string[];
  selectedContextGraphIds: string[];
  coverageContextGraphIds: string[];
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CORE_PUBLIC_SYNC_BATCH_SIZE;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError('syncCorePublicBatchSize must be a non-negative integer');
  }
  return value;
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = a;
  let right = b;
  while (right !== 0) {
    [left, right] = [right, left % right];
  }
  return left;
}

/** Ensure every CG eventually occupies the fail-fast batch's first slot. */
function rotationStride(batchSize: number, coverageSize: number): number {
  if (coverageSize <= 1) return 0;
  for (let candidate = Math.min(batchSize, coverageSize - 1); candidate >= 1; candidate -= 1) {
    if (greatestCommonDivisor(candidate, coverageSize) === 1) return candidate;
  }
  return 1;
}

export function resolveCorePublicSyncBatchSize(
  configured: number | undefined,
  envValue = process.env['DKG_SYNC_CORE_PUBLIC_BATCH_SIZE'],
): number {
  const trimmed = envValue?.trim();
  if (trimmed) {
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new TypeError(
        'DKG_SYNC_CORE_PUBLIC_BATCH_SIZE must be a non-negative integer',
      );
    }
    return parsed;
  }
  return normalizeBatchSize(configured);
}

/**
 * Rotating, bounded admission for automatic Core coverage. Explicitly selected
 * CGs are always included; only the automatic all-public tail is sliced.
 */
export class CorePublicSyncCoverageScheduler {
  private readonly tracked = new Set<string>();
  /** Per-peer cursors prevent a stable peer order from pinning each peer to one batch. */
  private readonly cursors = new Map<string, number>();
  private lastPlanAt?: number;
  private lastPlan?: CorePublicSyncCoverageStatus['lastPlan'];

  constructor(
    private readonly batchSize: number,
    private readonly now: () => number = Date.now,
  ) {
    normalizeBatchSize(batchSize);
  }

  register(contextGraphId: string): boolean {
    const normalized = contextGraphId.trim();
    if (!normalized) return false;
    const sizeBefore = this.tracked.size;
    this.tracked.add(normalized);
    return this.tracked.size !== sizeBefore;
  }

  unregister(contextGraphId: string): boolean {
    const removed = this.tracked.delete(contextGraphId);
    if (this.tracked.size === 0) {
      this.cursors.clear();
    } else {
      for (const [planningLane, cursor] of this.cursors) {
        this.cursors.set(planningLane, cursor % this.tracked.size);
      }
    }
    return removed;
  }

  plan(
    selectedContextGraphIds: readonly string[],
    priorities?: Readonly<SyncContextGraphPriorityConfig>,
    planningLane = 'default',
  ): CorePublicSyncPlan {
    const selected = [...new Set(
      selectedContextGraphIds.map((id) => id.trim()).filter(Boolean),
    )];
    const selectedSet = new Set(selected);
    const coverage = [...this.tracked]
      .map((contextGraphId, index) => ({ contextGraphId, index }))
      .filter(({ contextGraphId }) => !selectedSet.has(contextGraphId))
      .sort((a, b) => (
        contextGraphPriority(priorities, b.contextGraphId)
        - contextGraphPriority(priorities, a.contextGraphId)
        || a.index - b.index
      ))
      .map(({ contextGraphId }) => contextGraphId);

    const scheduledCoverage: string[] = [];
    if (this.batchSize > 0 && coverage.length > 0) {
      const count = Math.min(this.batchSize, coverage.length);
      const start = (this.cursors.get(planningLane) ?? 0) % coverage.length;
      for (let offset = 0; offset < count; offset += 1) {
        scheduledCoverage.push(coverage[(start + offset) % coverage.length]!);
      }
      this.cursors.set(
        planningLane,
        (start + rotationStride(count, coverage.length)) % coverage.length,
      );
    } else {
      this.cursors.delete(planningLane);
    }

    const contextGraphIds = [...selected, ...scheduledCoverage];
    this.lastPlanAt = this.now();
    this.lastPlan = {
      selectedContextGraphs: selected.length,
      coverageContextGraphs: scheduledCoverage.length,
      totalContextGraphs: contextGraphIds.length,
    };
    return {
      contextGraphIds,
      selectedContextGraphIds: selected,
      coverageContextGraphIds: scheduledCoverage,
    };
  }

  releasePlanningLane(planningLane: string): boolean {
    return this.cursors.delete(planningLane);
  }

  getStatus(enabled: boolean): CorePublicSyncCoverageStatus {
    return {
      enabled: enabled && this.batchSize > 0,
      batchSize: this.batchSize,
      trackedContextGraphs: this.tracked.size,
      planningLanes: this.cursors.size,
      ...(this.lastPlanAt !== undefined ? { lastPlanAt: this.lastPlanAt } : {}),
      ...(this.lastPlan ? { lastPlan: { ...this.lastPlan } } : {}),
    };
  }
}
