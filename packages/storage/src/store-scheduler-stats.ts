/**
 * In-process figures a store scheduler keeps beside its OTel metrics. OTel is
 * opt-in and write-only, so the periodic admission log line reads these
 * instead: the longest queue wait of each lane over the interval, how many
 * waits fell in each fixed bucket (enough to estimate a P95 within about 10 %),
 * and the cumulative rejections by lane, operation family and reason.
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

/**
 * Inclusive upper bounds (ms) of the queue-wait buckets; one more bucket counts anything longer.
 *
 * They grow by about 10 % per step: `round(1.1 ** k)` for k = 0, 1, 2 ... with duplicates dropped, up to 9412,
 * then 10000 (the default queue-wait timeout). From 7 ms up a step is at most 15 %, so a bucket upper bound
 * overstates the true value by that much at most, and "not worse than 25 %" can be judged on two of them;
 * below 7 ms the whole-millisecond steps are coarser, which is within clock noise there.
 *
 * Do not change the list once a release ships it: the testnet test and the mainnet monitoring compare figures
 * from different builds, which only works when both count in the same buckets.
 */
export const STORE_QUEUE_WAIT_BUCKET_UPPER_MS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 26, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 117, 129, 142, 156, 172, 189, 208, 229, 252, 277, 304, 335, 368,
  405, 446, 490, 539, 593, 653, 718, 790, 869, 956, 1051, 1156, 1272, 1399, 1539, 1693, 1862, 2048, 2253,
  2479, 2726, 2999, 3299, 3629, 3992, 4391, 4830, 5313, 5844, 6429, 7072, 7779, 8557, 9412, 10000,
];

/** Index of the bucket a wait falls in: the first whose upper bound it does not exceed, else the overflow bucket. */
function queueWaitBucketIndex(waitMs: number): number {
  let low = 0;
  let high = STORE_QUEUE_WAIT_BUCKET_UPPER_MS.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (waitMs <= STORE_QUEUE_WAIT_BUCKET_UPPER_MS[mid]) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * Estimate a percentile (`0 < percentile <= 1`, default P95) of queue waits from
 * bucket counts. It is the upper bound of the bucket holding that rank, so the
 * true value is at most this and can be up to one bucket width lower. It is 0
 * when no wait was counted, and `overflowMs` (the interval max, else Infinity)
 * when the rank falls in the overflow bucket.
 */
export function estimateQueueWaitPercentileMs(buckets: readonly number[], percentile = 0.95, overflowMs = Infinity): number {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (total <= 0) return 0;
  const rank = Math.max(1, Math.ceil(total * Math.min(1, percentile)));
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i];
    if (seen >= rank) return STORE_QUEUE_WAIT_BUCKET_UPPER_MS[i] ?? overflowMs;
  }
  return overflowMs;
}

export interface StoreSchedulerLaneWait {
  lane: string;
  maxQueueWaitMs: number;
  /** Waits that ended in the interval (the sum of `queueWaitBuckets`). */
  queueWaitCount: number;
  /** Waits per bucket: `STORE_QUEUE_WAIT_BUCKET_UPPER_MS` in order, then the overflow bucket. */
  queueWaitBuckets: number[];
}

export interface StoreSchedulerRejectionTotal {
  lane: string;
  family: string;
  reason: string;
  count: number;
}

const emptyLaneWaits = () => ({ maxMs: 0, buckets: Array.from({ length: STORE_QUEUE_WAIT_BUCKET_UPPER_MS.length + 1 }, () => 0) });

export class StoreSchedulerStats {
  private readonly laneWaits = new Map<string, ReturnType<typeof emptyLaneWaits>>();
  private readonly rejections = new Map<string, StoreSchedulerRejectionTotal>();
  private readonly families = new Set<string>();

  /** `lanes` are reported in this order, with 0 when no wait ended in the interval. */
  constructor(lanes: readonly string[]) {
    for (const lane of lanes) this.laneWaits.set(lane, emptyLaneWaits());
  }

  /**
   * A queue wait ended: the entry started, timed out or was cancelled while queued. Work that starts at
   * once counts too, as a wait of about 0 ms.
   */
  recordQueueWait(lane: string, waitMs: number): void {
    if (!Number.isFinite(waitMs)) return;
    let waits = this.laneWaits.get(lane);
    if (!waits) this.laneWaits.set(lane, (waits = emptyLaneWaits()));
    waits.maxMs = Math.max(waits.maxMs, waitMs);
    waits.buckets[queueWaitBucketIndex(waitMs)] += 1;
  }

  /**
   * Count one rejection, and the time it queued (omitted when it never queued,
   * so a full queue does not count as a zero-length wait).
   * Returns the bounded family it was counted under: the first
   * `MAX_FAMILIES` distinct families keep their name, later ones count as `other`.
   */
  recordRejection(lane: string, operation: string, reason: string, waitMs?: number): string {
    let family = storeOperationFamily(operation);
    if (!this.families.has(family)) {
      if (this.families.size >= MAX_FAMILIES) family = OTHER_FAMILY;
      else this.families.add(family);
    }
    const key = `${lane}\u0000${family}\u0000${reason}`;
    const total = this.rejections.get(key);
    if (total) total.count += 1;
    else this.rejections.set(key, { lane, family, reason, count: 1 });
    if (waitMs !== undefined) this.recordQueueWait(lane, waitMs);
    return family;
  }

  /** Longest queue wait and per-bucket wait counts per lane since the previous call; starts a new interval. */
  takeIntervalQueueWaits(): StoreSchedulerLaneWait[] {
    const taken = [...this.laneWaits].map(([lane, { maxMs, buckets }]) => ({
      lane,
      maxQueueWaitMs: maxMs,
      queueWaitCount: buckets.reduce((sum, count) => sum + count, 0),
      queueWaitBuckets: buckets,
    }));
    for (const lane of this.laneWaits.keys()) this.laneWaits.set(lane, emptyLaneWaits());
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
  queueWaits: StoreSchedulerLaneWait[];
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
 * interval of its queue waits (the max and the bucket counts), so call it from one place only (the periodic line).
 */
export function takeStoreSchedulerStatsReports(): StoreSchedulerStatsReport[] {
  return [...sources.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scheduler, { stats }]) => ({
      scheduler,
      queueWaits: stats.takeIntervalQueueWaits(),
      rejections: stats.rejectionTotals(),
    }));
}
