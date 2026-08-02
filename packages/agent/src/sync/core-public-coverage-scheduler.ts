import {
  contextGraphPriority,
  type SyncContextGraphPriorityConfig,
} from './policy.js';

export const DEFAULT_CORE_PUBLIC_SYNC_BATCH_SIZE = 8;
export const DEFAULT_CORE_PUBLIC_SYNC_MAX_PLANNING_LANES = 2_048;

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

export interface CorePublicSyncCoveragePlanOptions {
  priorities?: Readonly<SyncContextGraphPriorityConfig>;
  planningLane?: string;
  effectiveBatchSize?: number;
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CORE_PUBLIC_SYNC_BATCH_SIZE;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError('syncCorePublicBatchSize must be a non-negative integer');
  }
  return value;
}

function resolveEffectiveBatchSize(
  configuredBatchSize: number,
  effectiveBatchSize: number | undefined,
): number {
  if (effectiveBatchSize === undefined) return configuredBatchSize;
  if (!Number.isInteger(effectiveBatchSize) || effectiveBatchSize < 0) {
    throw new TypeError('effective Core public sync batch size must be a non-negative integer');
  }
  return Math.min(configuredBatchSize, effectiveBatchSize);
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

/** Rotating, bounded admission for the automatic Core-public tail only. */
export class CorePublicSyncCoverageScheduler {
  private readonly tracked = new Set<string>();
  /**
   * Bounded LRU lane anchors keep active-peer fairness without a lifecycle cleanup contract.
   * Each value names the graph that most recently occupied the lane's first slot, so the
   * state remains meaningful when priorities or tracked membership rebuild the ordered list.
   */
  private readonly laneAnchors = new Map<string, string>();
  private lastPlanAt?: number;
  private lastPlan?: CorePublicSyncCoverageStatus['lastPlan'];

  constructor(
    private readonly batchSize: number,
    private readonly now: () => number = Date.now,
    private readonly maxPlanningLanes = DEFAULT_CORE_PUBLIC_SYNC_MAX_PLANNING_LANES,
  ) {
    normalizeBatchSize(batchSize);
    if (!Number.isInteger(maxPlanningLanes) || maxPlanningLanes <= 0) {
      throw new TypeError('maxPlanningLanes must be a positive integer');
    }
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
      this.laneAnchors.clear();
    } else if (removed) {
      for (const [planningLane, anchorContextGraphId] of this.laneAnchors) {
        if (anchorContextGraphId === contextGraphId) {
          this.laneAnchors.delete(planningLane);
        }
      }
    }
    return removed;
  }

  planAutomaticCoverage(
    selectedContextGraphIds: readonly string[],
    priorities?: Readonly<SyncContextGraphPriorityConfig>,
    planningLane = 'default',
  ): string[] {
    return this.planAutomaticCoverageWithOptions(selectedContextGraphIds, {
      priorities,
      planningLane,
    });
  }

  /** Canonical named planning boundary; the positional wrapper preserves outside call shapes. */
  planAutomaticCoverageWithOptions(
    selectedContextGraphIds: readonly string[],
    options: Readonly<CorePublicSyncCoveragePlanOptions> = {},
  ): string[] {
    const {
      priorities,
      planningLane = 'default',
      effectiveBatchSize,
    } = options;
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
    const batchSize = resolveEffectiveBatchSize(this.batchSize, effectiveBatchSize);
    if (batchSize > 0 && coverage.length > 0) {
      const count = Math.min(batchSize, coverage.length);
      const previousAnchor = this.laneAnchors.get(planningLane);
      const previousAnchorIndex = previousAnchor === undefined
        ? -1
        : coverage.indexOf(previousAnchor);
      const start = previousAnchorIndex < 0
        ? 0
        : (previousAnchorIndex + rotationStride(count, coverage.length)) % coverage.length;
      for (let offset = 0; offset < count; offset += 1) {
        scheduledCoverage.push(coverage[(start + offset) % coverage.length]!);
      }
      // Delete-before-set refreshes LRU order for an existing active lane.
      if (previousAnchor !== undefined) this.laneAnchors.delete(planningLane);
      this.laneAnchors.set(planningLane, coverage[start]!);
      while (this.laneAnchors.size > this.maxPlanningLanes) {
        const oldestLane = this.laneAnchors.keys().next().value as string | undefined;
        if (oldestLane === undefined) break;
        this.laneAnchors.delete(oldestLane);
      }
    } else {
      this.laneAnchors.delete(planningLane);
    }

    this.lastPlanAt = this.now();
    this.lastPlan = {
      selectedContextGraphs: selected.length,
      coverageContextGraphs: scheduledCoverage.length,
      totalContextGraphs: selected.length + scheduledCoverage.length,
    };
    return scheduledCoverage;
  }

  /** Pure demand check for automatic public coverage beyond the current batch. */
  hasAutomaticCoverageBacklog(
    selectedContextGraphIds: readonly string[],
    effectiveBatchSize?: number,
  ): boolean {
    if (this.batchSize === 0) return false;
    const batchSize = resolveEffectiveBatchSize(this.batchSize, effectiveBatchSize);
    const selected = new Set(
      selectedContextGraphIds.map((id) => id.trim()).filter(Boolean),
    );
    let candidates = 0;
    for (const contextGraphId of this.tracked) {
      if (selected.has(contextGraphId)) continue;
      candidates += 1;
      if (candidates > batchSize) return true;
    }
    return false;
  }

  getStatus(enabled: boolean): CorePublicSyncCoverageStatus {
    return {
      enabled: enabled && this.batchSize > 0,
      batchSize: this.batchSize,
      trackedContextGraphs: this.tracked.size,
      planningLanes: this.laneAnchors.size,
      ...(this.lastPlanAt !== undefined ? { lastPlanAt: this.lastPlanAt } : {}),
      ...(this.lastPlan ? { lastPlan: { ...this.lastPlan } } : {}),
    };
  }
}
