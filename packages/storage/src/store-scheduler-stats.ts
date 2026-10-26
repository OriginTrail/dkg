/**
 * In-process figures a store scheduler keeps beside its OTel metrics. OTel is
 * opt-in and write-only, so the periodic admission log line reads these
 * instead: the longest queue wait of each lane over the interval, and the
 * cumulative rejections by lane, operation family and reason.
 *
 * One `StoreSchedulerStats` belongs to one scheduler instance and is keyed by
 * lane name, so a further scheduler (the queue control path) brings its own
 * and registers it under its own id.
 */

const MAX_FAMILIES = 64;
const OTHER_FAMILY = 'other';

/** Bounded metric label for a scheduler operation (the caller's `source`). */
export function metricOperation(operation: string): string {
  const trimmed = operation.trim();
  if (!trimmed) return 'unknown';
  return trimmed.replace(/[^\w:./-]/g, '_').slice(0, 80) || 'unknown';
}

/**
 * Coarse grouping of an operation label: its first two dot-separated segments
 * (`publisher.asyncLift.claimCandidates` -> `publisher.asyncLift`). Never throws.
 */
export function storeOperationFamily(operation: string): string {
  return metricOperation(String(operation ?? '')).split('.', 2).join('.');
}

export interface StoreSchedulerLaneWait {
  lane: string;
  maxQueueWaitMs: number;
}

export interface StoreSchedulerRejectionTotal {
  lane: string;
  family: string;
  reason: string;
  count: number;
}

export class StoreSchedulerStats {
  private readonly maxWaitMs = new Map<string, number>();
  private readonly rejections = new Map<string, StoreSchedulerRejectionTotal>();
  private readonly families = new Set<string>();

  /** `lanes` are reported in this order, with 0 when no wait ended in the interval. */
  constructor(lanes: readonly string[]) {
    for (const lane of lanes) this.maxWaitMs.set(lane, 0);
  }

  /** A queue wait ended: the entry started, timed out or was cancelled while queued. */
  recordQueueWait(lane: string, waitMs: number): void {
    if (!Number.isFinite(waitMs)) return;
    this.maxWaitMs.set(lane, Math.max(this.maxWaitMs.get(lane) ?? 0, waitMs));
  }

  /**
   * Count one rejection, and the time it queued (0 when it never queued).
   * Returns the bounded family it was counted under: the first
   * `MAX_FAMILIES` distinct families keep their name, later ones count as `other`.
   */
  recordRejection(lane: string, operation: string, reason: string, waitMs = 0): string {
    let family = storeOperationFamily(operation);
    if (!this.families.has(family)) {
      if (this.families.size >= MAX_FAMILIES) family = OTHER_FAMILY;
      else this.families.add(family);
    }
    const key = `${lane}\u0000${family}\u0000${reason}`;
    const total = this.rejections.get(key);
    if (total) total.count += 1;
    else this.rejections.set(key, { lane, family, reason, count: 1 });
    this.recordQueueWait(lane, waitMs);
    return family;
  }

  /** Longest queue wait per lane since the previous call; starts a new interval. */
  takeIntervalMaxQueueWaitMs(): StoreSchedulerLaneWait[] {
    const taken = [...this.maxWaitMs].map(([lane, maxQueueWaitMs]) => ({ lane, maxQueueWaitMs }));
    for (const lane of this.maxWaitMs.keys()) this.maxWaitMs.set(lane, 0);
    return taken;
  }

  /** Rejections since the scheduler was built, ordered by lane, family and reason. */
  rejectionTotals(): StoreSchedulerRejectionTotal[] {
    return [...this.rejections.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, total]) => ({ ...total }));
  }
}

export interface StoreSchedulerStatsSource {
  /** The scheduler's backpressure id (`store` for the shared scheduler). */
  readonly backpressureId: string;
  readonly stats: StoreSchedulerStats;
}

export interface StoreSchedulerStatsReport {
  scheduler: string;
  maxQueueWaitMs: StoreSchedulerLaneWait[];
  rejections: StoreSchedulerRejectionTotal[];
}

const sources = new Map<string, StoreSchedulerStatsSource>();

/** Make a scheduler's figures visible to `takeStoreSchedulerStatsReports`. */
export function registerStoreSchedulerStats(source: StoreSchedulerStatsSource): () => void {
  const id = source.backpressureId;
  const existing = sources.get(id);
  if (existing && existing !== source) {
    throw new Error(`Store scheduler stats "${id}" are already registered`);
  }
  sources.set(id, source);
  return () => {
    if (sources.get(id) === source) sources.delete(id);
  };
}

/**
 * One report per registered scheduler, ordered by id. Taking a report ends the
 * interval of its max waits, so call it from one place only (the periodic line).
 */
export function takeStoreSchedulerStatsReports(): StoreSchedulerStatsReport[] {
  return [...sources.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scheduler, { stats }]) => ({
      scheduler,
      maxQueueWaitMs: stats.takeIntervalMaxQueueWaitMs(),
      rejections: stats.rejectionTotals(),
    }));
}
