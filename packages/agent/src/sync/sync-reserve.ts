import type { SchedulerPressureCapacity } from '@origintrail-official/dkg-core';

/**
 * Sync capacity held back for one kind of work that must not wait for a
 * large transfer of another graph: shared-memory pulls (#3251) and curator
 * metadata refreshes (#3280). That work takes a general slot when one is free
 * and otherwise one of its reserved slots, which no other work can take, so
 * the limits of all other work are unchanged and a reserved admission does
 * not count against them.
 */
export interface SyncReserve {
  /** Name of the reserve in log lines, and the queue pool of its own queue. */
  readonly pool: string;
  readonly maxInflight: number;
  /**
   * A bounded queue of the reserve's own. Work that finds no slot waits there
   * instead of being refused, and is refused after the timeout. Without one,
   * the work waits where it would wait without a reserve: in the general
   * queue, or nowhere on a node without one.
   */
  readonly queue?: Readonly<{ limit: number; timeoutMs: number }>;
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

/**
 * Count the reserved slots and their queues in the capacity a scheduler
 * publishes, so its pressure reads against everything it admits. Under
 * partitions only shared-memory pulls hold a reserve, and they are slow-lane
 * work.
 */
export function withSyncReserveCapacity(
  capacity: SchedulerPressureCapacity,
  policy: object,
): SchedulerPressureCapacity {
  if (!capacity.inflightLimit) return capacity;
  return (reserves.get(policy) ?? []).reduce((grown, reserve) => {
    const grow = (limits: CapacityLimits) => ({
      ...limits,
      queueLimit: (limits.queueLimit ?? 0) + (reserve.queue?.limit ?? 0),
      inflightLimit: (limits.inflightLimit ?? 0) + reserve.maxInflight,
    });
    if (grown.capacityModel === 'shared' || grown.lanes?.slow === undefined) {
      return { ...grown, ...grow(grown) } as SchedulerPressureCapacity;
    }
    return { ...grown, ...grow(grown), lanes: { ...grown.lanes, slow: grow(grown.lanes.slow) } };
  }, capacity);
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
  describe(reserve: SyncReserve, queued: number): string {
    const running = `, reserved ${reserve.pool} inflight=${this.inflight(reserve)}/${reserve.maxInflight}`;
    return reserve.queue ? `${running}, queued=${queued}/${reserve.queue.limit}` : running;
  }

  private inflight(reserve: SyncReserve): number {
    return this.#inflight.get(reserve.pool) ?? 0;
  }
}
