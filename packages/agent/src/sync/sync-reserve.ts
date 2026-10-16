import type { SchedulerPressureCapacity } from '@origintrail-official/dkg-core';

/**
 * Sync capacity held back for one kind of small work that must not wait for
 * a large transfer: shared-memory pulls (#3251) and control-plane fetches
 * (#3280). That work takes a general slot when one is free and otherwise one
 * of its reserved slots, which no other work can take, so the limits of all
 * other work are unchanged and a reserved admission does not count against
 * them. While it can take neither, it waits in the reserve's own bounded
 * queue instead of being refused, and is refused after the queue timeout.
 */
export interface SyncReserve {
  /** Queue pool and owner key of the work waiting for this reserve; its name in log lines. */
  readonly pool: string;
  readonly maxInflight: number;
  readonly queueLimit: number;
  readonly queueTimeoutMs: number;
  /** The partition whose published capacity grows by this reserve under partitioned admission. */
  readonly partition?: 'slow';
}

type CapacityLimits = { queueLimit?: number | null; inflightLimit?: number | null };

const reserves = new WeakMap<object, readonly SyncReserve[]>();

/** Record a resolved sync policy's reserves, like its other limits. A reserve of 0 slots is off. */
export function recordSyncReserves(policy: object, ...policyReserves: SyncReserve[]): void {
  reserves.set(policy, Object.freeze(policyReserves.filter((reserve) => reserve.maxInflight > 0)));
}

/** The reserve of `pool` that a policy holds, unless it is off. */
export function syncReserveOf(policy: object, pool: string): SyncReserve | undefined {
  return reserves.get(policy)?.find((reserve) => reserve.pool === pool);
}

function grownBy(capacity: SchedulerPressureCapacity, reserve: SyncReserve): SchedulerPressureCapacity {
  const grow = (limits: CapacityLimits) => ({
    ...limits,
    queueLimit: (limits.queueLimit ?? 0) + reserve.queueLimit,
    inflightLimit: (limits.inflightLimit ?? 0) + reserve.maxInflight,
  });
  const lane = capacity.capacityModel === 'shared' || reserve.partition === undefined
    ? undefined
    : capacity.lanes?.[reserve.partition];
  if (lane === undefined) return { ...capacity, ...grow(capacity) } as SchedulerPressureCapacity;
  return {
    ...capacity,
    ...grow(capacity),
    lanes: { ...capacity.lanes, [reserve.partition!]: grow(lane) },
  } as SchedulerPressureCapacity;
}

/**
 * Count the reserved slots and their queues in the capacity a scheduler
 * publishes, so its pressure reads against everything it admits.
 */
export function withSyncReserveCapacity(
  capacity: SchedulerPressureCapacity,
  policy: object,
): SchedulerPressureCapacity {
  if (!capacity.inflightLimit) return capacity;
  return (reserves.get(policy) ?? []).reduce(grownBy, capacity);
}

/** Running count of the reserved slots of the one sync-global scheduler, per reserve. */
export class ReservedSyncSlots {
  readonly #inflight = new Map<string, number>();

  canTake(reserve: SyncReserve | undefined): boolean {
    return reserve !== undefined && this.inflight(reserve) < reserve.maxInflight;
  }

  take(reserve: SyncReserve): void {
    this.#inflight.set(reserve.pool, this.inflight(reserve) + 1);
  }

  give(reserve: SyncReserve): void {
    this.#inflight.set(reserve.pool, Math.max(0, this.inflight(reserve) - 1));
  }

  /** `, reserved shared-memory inflight=1/1, queued=0/16` for admission log lines. */
  describe(reserve: SyncReserve | undefined, queued: number): string {
    if (reserve === undefined) return '';
    return `, reserved ${reserve.pool} inflight=${this.inflight(reserve)}/${reserve.maxInflight}`
      + `, queued=${queued}/${reserve.queueLimit}`;
  }

  private inflight(reserve: SyncReserve): number {
    return this.#inflight.get(reserve.pool) ?? 0;
  }
}
