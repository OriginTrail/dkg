import type { SchedulerPressureCapacity } from '@origintrail-official/dkg-core';
import type { SyncSchedulerLane } from './policy.js';
import { nonNegativeInteger, parseIntegerEnv } from './sync-switches.js';

/**
 * Reserved sync capacity for shared-memory pulls (#3251).
 *
 * A node that runs one sync slot with no queue refused every pull of a small
 * graph's shared memory while a large Verified Memory transfer of another
 * graph held that slot, and the pull came back only with the next connection
 * or reconcile run. Shared-memory pulls (the public SWM lane and private SWM
 * recovery) therefore take a general slot when one is free and otherwise one
 * of these reserved slots, which no durable or changelog work can take: the
 * limits of those transfers are unchanged, and a reserved pull does not count
 * against them. A pull that finds no slot waits in its own bounded queue
 * instead of being refused, and is deferred after the queue timeout.
 *
 * Env DKG_SYNC_SHARED_MEMORY_RESERVED_INFLIGHT; 0 turns the reserve off.
 */
export const DEFAULT_SYNC_SHARED_MEMORY_RESERVED_INFLIGHT = 1;
/** Shared-memory pulls wait in their own queue, not in the global one. */
export const DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT = 16;
/** Longest wait of a queued shared-memory pull before it is deferred. */
export const DEFAULT_SYNC_SHARED_MEMORY_QUEUE_TIMEOUT_MS = 60_000;
/** Queue pool and owner key of waiting shared-memory pulls. */
export const SHARED_MEMORY_QUEUE_POOL = 'shared-memory';

export interface SharedMemoryReserve {
  readonly maxInflight: number;
  readonly queueLimit: number;
  readonly queueTimeoutMs: number;
}

const reserves = new WeakMap<object, SharedMemoryReserve>();

/** Resolve the reserve once per resolved sync policy, like its other limits. */
export function recordSharedMemoryReserve(policy: object): void {
  reserves.set(policy, Object.freeze({
    maxInflight: nonNegativeInteger(parseIntegerEnv('DKG_SYNC_SHARED_MEMORY_RESERVED_INFLIGHT'))
      ?? DEFAULT_SYNC_SHARED_MEMORY_RESERVED_INFLIGHT,
    queueLimit: DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT,
    queueTimeoutMs: DEFAULT_SYNC_SHARED_MEMORY_QUEUE_TIMEOUT_MS,
  }));
}

/**
 * The reserve an admission may use: shared-memory lanes only, never the fast
 * partition (changelog and control-plane work keep their own bounded wait).
 */
export function sharedMemoryReserveFor(
  policy: object,
  lane: SyncSchedulerLane,
  fastPartition: boolean,
): SharedMemoryReserve | undefined {
  const reserve = reserves.get(policy);
  if (reserve === undefined || reserve.maxInflight === 0 || fastPartition) return undefined;
  return lane === 'shared_memory' || lane === 'swm_recovery' ? reserve : undefined;
}

/**
 * Count the reserved slots and their queue in the capacity a scheduler
 * publishes, so its pressure reads against everything it admits. Under
 * partitions, shared-memory pulls are slow-lane work.
 */
export function withSharedMemoryReserveCapacity(
  capacity: SchedulerPressureCapacity,
  policy: object,
): SchedulerPressureCapacity {
  const reserve = reserves.get(policy);
  if (reserve === undefined || reserve.maxInflight === 0 || !capacity.inflightLimit) return capacity;
  const grow = (limits: { queueLimit?: number | null; inflightLimit?: number | null }) => ({
    ...limits,
    queueLimit: (limits.queueLimit ?? 0) + reserve.queueLimit,
    inflightLimit: (limits.inflightLimit ?? 0) + reserve.maxInflight,
  });
  if (capacity.capacityModel === 'shared' || capacity.lanes?.slow === undefined) {
    return { ...capacity, ...grow(capacity) } as SchedulerPressureCapacity;
  }
  return {
    ...capacity,
    ...grow(capacity),
    lanes: { ...capacity.lanes, slow: grow(capacity.lanes.slow) },
  };
}

/** Running count of the reserved slots of the one sync-global scheduler. */
export class ReservedSharedMemorySlots {
  #inflight = 0;

  canTake(reserve: SharedMemoryReserve | undefined): boolean {
    return reserve !== undefined && this.#inflight < reserve.maxInflight;
  }

  take(): void {
    this.#inflight += 1;
  }

  give(): void {
    this.#inflight = Math.max(0, this.#inflight - 1);
  }

  /** `, reserved shared-memory inflight=1/1, queued=0/16` for admission log lines. */
  describe(reserve: SharedMemoryReserve | undefined, queued: number): string {
    if (reserve === undefined) return '';
    return `, reserved shared-memory inflight=${this.#inflight}/${reserve.maxInflight}`
      + `, queued=${queued}/${reserve.queueLimit}`;
  }
}
