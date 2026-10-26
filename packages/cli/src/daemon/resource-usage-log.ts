import { getHeapStatistics } from 'node:v8';
import {
  backpressureRegistry,
  createOperationContext,
  Logger,
  type BackpressureOperationSummary,
  type BackpressureRegistry,
  type BackpressureSnapshot,
} from '@origintrail-official/dkg-core';

/**
 * One `resource_usage` line every five minutes: the daemon's memory, the store
 * scheduler's lanes and the sync slots in flight.
 *
 * The daemon logged no such figures, so the log of a node that was killed for
 * memory could not show how its memory grew or what its store and sync work
 * were doing meanwhile. Every figure here is already kept by the process
 * (`process.memoryUsage()`, the V8 heap limit, and the backpressure registry
 * behind `/api/status`), so a line costs one snapshot of each; 288 lines a day
 * add well under 1 MB. It is logfmt, like `rpc_usage`.
 *
 * Line shape (one line, wrapped here):
 *   resource_usage rss_mb=1806 heap_used_mb=812 heap_limit_mb=4144 external_mb=95
 *     store_ack=0/4 store_ack_queued=0 store_health=0/3 store_health_queued=0
 *     store_normal=1/2 store_normal_queued=3 store_normal_active=agent.query.select:0.4s
 *     store_background=1/1 store_background_queued=12
 *     store_background_active=agent.durableSync.graphScopedMaterialization:9.8s
 *     sync=3/3 sync_queued=0/16 sync_active=durable:vm-recovery:62.0s,durable:control-plane*2:0.3s
 *
 * `<lane>=a/b` is work running against the lane's ceiling, `_queued` work
 * waiting, and `_active` each operation holding a slot (`*n` when n of it do)
 * with the age of its oldest run, oldest first. The sync figures count the
 * reserved slots too. A scheduler that never registered is left out.
 */
export const RESOURCE_USAGE_LOG_INTERVAL_MS = 5 * 60_000;

/** Store lanes in admission priority order; any other lane follows. */
const STORE_LANE_ORDER = ['ack', 'health', 'normal', 'background'];
const MAX_ACTIVE_OPERATIONS = 8;
const MIB = 1024 * 1024;

export interface ResourceUsageSample {
  rssBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  externalBytes: number;
  store?: BackpressureSnapshot;
  sync?: BackpressureSnapshot;
}

export function captureResourceUsage(
  registry: Pick<BackpressureRegistry, 'capture'> = backpressureRegistry,
): ResourceUsageSample {
  const memory = process.memoryUsage();
  const { schedulers } = registry.capture();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapLimitBytes: getHeapStatistics().heap_size_limit,
    externalBytes: memory.external,
    store: schedulers.find((scheduler) => scheduler.scheduler === 'store'),
    sync: schedulers.find((scheduler) => scheduler.scheduler === 'sync-global'),
  };
}

function megabytes(bytes: number): number {
  return Math.round(bytes / MIB);
}

function ofLimit(value: number, limit: number | null): string {
  return limit === null ? `${value}` : `${value}/${limit}`;
}

/** `op:age` per operation, oldest first, merged across lanes. */
function activeOperations(operations: readonly BackpressureOperationSummary[]): string {
  const merged = new Map<string, BackpressureOperationSummary>();
  for (const operation of operations) {
    const seen = merged.get(operation.operation);
    merged.set(operation.operation, seen
      ? {
        operation: operation.operation,
        count: seen.count + operation.count,
        oldestAgeMs: Math.max(seen.oldestAgeMs, operation.oldestAgeMs),
      }
      : operation);
  }
  return [...merged.values()]
    .sort((a, b) => b.oldestAgeMs - a.oldestAgeMs || a.operation.localeCompare(b.operation))
    .slice(0, MAX_ACTIVE_OPERATIONS)
    .map((operation) => `${operation.operation}${operation.count > 1 ? `*${operation.count}` : ''}`
      + `:${(operation.oldestAgeMs / 1000).toFixed(1)}s`)
    .join(',');
}

function storeLaneRank(lane: string): number {
  const rank = STORE_LANE_ORDER.indexOf(lane);
  return rank < 0 ? STORE_LANE_ORDER.length : rank;
}

export function formatResourceUsageLine(sample: ResourceUsageSample): string {
  const fields = [
    `rss_mb=${megabytes(sample.rssBytes)}`,
    `heap_used_mb=${megabytes(sample.heapUsedBytes)}`,
    `heap_limit_mb=${megabytes(sample.heapLimitBytes)}`,
    `external_mb=${megabytes(sample.externalBytes)}`,
  ];
  const storeLanes = [...(sample.store?.lanes ?? [])]
    .sort((a, b) => storeLaneRank(a.lane) - storeLaneRank(b.lane) || a.lane.localeCompare(b.lane));
  for (const lane of storeLanes) {
    const key = `store_${lane.lane.replace(/\W/g, '_')}`;
    fields.push(`${key}=${ofLimit(lane.inflight, lane.inflightLimit)}`, `${key}_queued=${lane.queued}`);
    if (lane.activeOperations.length > 0) {
      fields.push(`${key}_active=${activeOperations(lane.activeOperations)}`);
    }
  }
  if (sample.sync) {
    const { totals, lanes } = sample.sync;
    fields.push(
      `sync=${ofLimit(totals.inflight, totals.inflightLimit)}`,
      `sync_queued=${ofLimit(totals.queued, totals.queueLimit)}`,
    );
    const active = lanes.flatMap((lane) => lane.activeOperations);
    if (active.length > 0) fields.push(`sync_active=${activeOperations(active)}`);
  }
  return `resource_usage ${fields.join(' ')}`;
}

/** Log one line now and one every `intervalMs` until stopped. */
export function startResourceUsageLog(options: {
  emit?: (line: string) => void;
  capture?: () => ResourceUsageSample;
  intervalMs?: number;
} = {}): { stop(): void } {
  const logger = new Logger('resources');
  const emit = options.emit ?? ((line: string) => logger.info(createOperationContext('system'), line));
  const capture = options.capture ?? (() => captureResourceUsage());
  const write = (): void => {
    try {
      emit(formatResourceUsageLine(capture()));
    } catch {
      // A failed sample is skipped; the next one is taken on time.
    }
  };
  write();
  const timer = setInterval(write, options.intervalMs ?? RESOURCE_USAGE_LOG_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
