import type { SyncSchedulerLane } from './policy.js';
import { syncReserveOf, type SyncReserve } from './sync-reserve.js';
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
 * instead of being refused, and is deferred after the queue timeout. A pull
 * admitted with `reservedSlotOnly` (the Edge safety-net pull) takes only a
 * reserved slot, so it never holds a general one.
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

/** The shared-memory reserve, resolved once per resolved sync policy like its other limits. */
export function sharedMemoryReserve(): SyncReserve {
  return Object.freeze({
    pool: SHARED_MEMORY_QUEUE_POOL,
    maxInflight: nonNegativeInteger(parseIntegerEnv('DKG_SYNC_SHARED_MEMORY_RESERVED_INFLIGHT'))
      ?? DEFAULT_SYNC_SHARED_MEMORY_RESERVED_INFLIGHT,
    queueLimit: DEFAULT_SYNC_SHARED_MEMORY_QUEUE_LIMIT,
    queueTimeoutMs: DEFAULT_SYNC_SHARED_MEMORY_QUEUE_TIMEOUT_MS,
    // Under partitions, shared-memory pulls are slow-lane work.
    partition: 'slow',
  });
}

/**
 * The reserve an admission may use: shared-memory lanes only, never the fast
 * partition (changelog and control-plane work keep their own bounded wait).
 */
export function sharedMemoryReserveFor(
  policy: object,
  lane: SyncSchedulerLane,
  fastPartition: boolean,
): SyncReserve | undefined {
  if (fastPartition) return undefined;
  return lane === 'shared_memory' || lane === 'swm_recovery'
    ? syncReserveOf(policy, SHARED_MEMORY_QUEUE_POOL)
    : undefined;
}
