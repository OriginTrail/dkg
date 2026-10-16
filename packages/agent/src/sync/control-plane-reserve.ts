import type { SyncAdmissionSource } from './policy.js';
import { syncReserveOf, type SyncReserve } from './sync-reserve.js';
import { nonNegativeInteger, parseIntegerEnv } from './sync-switches.js';

/**
 * Reserved sync capacity for control-plane fetches (#3280).
 *
 * A member that ran one sync slot with no queue refused every curator
 * metadata refresh while another transfer held that slot ("Sync backpressure
 * rejected durable:control-plane (global inflight=1/1, queued=0/0)"), so it
 * never obtained a registered graph's definition or a private graph's member
 * list, and nothing that waits on those could start. Control-plane fetches
 * (admission source `control-plane`: a curator metadata refresh that no sync
 * operation encloses, on the requester and on the responder side) therefore
 * take a general slot when one is free and otherwise this reserved slot,
 * which no transfer can take: the limits of transfers are unchanged, and a
 * reserved fetch does not count against them. A fetch that finds no slot
 * waits in its own bounded queue instead of being refused, and is refused
 * after the queue timeout. A refresh nested in an admitted sync runs inside
 * that admission and takes nothing here. Partitioned admission has no
 * control-plane reserve: its fast partition holds that work.
 *
 * Env DKG_SYNC_CONTROL_PLANE_RESERVED_INFLIGHT; 0 turns the reserve off.
 */
export const DEFAULT_SYNC_CONTROL_PLANE_RESERVED_INFLIGHT = 1;
/** Control-plane fetches wait in their own queue, not in the global one. */
export const DEFAULT_SYNC_CONTROL_PLANE_QUEUE_LIMIT = 16;
/** Longest wait of a queued control-plane fetch before it is refused. */
export const DEFAULT_SYNC_CONTROL_PLANE_QUEUE_TIMEOUT_MS = 60_000;
/** Queue pool and owner key of waiting control-plane fetches. */
export const CONTROL_PLANE_QUEUE_POOL = 'control-plane';

/** The control-plane reserve of a shared sync policy, resolved like its other limits. */
export function controlPlaneReserve(): SyncReserve {
  return Object.freeze({
    pool: CONTROL_PLANE_QUEUE_POOL,
    maxInflight: nonNegativeInteger(parseIntegerEnv('DKG_SYNC_CONTROL_PLANE_RESERVED_INFLIGHT'))
      ?? DEFAULT_SYNC_CONTROL_PLANE_RESERVED_INFLIGHT,
    queueLimit: DEFAULT_SYNC_CONTROL_PLANE_QUEUE_LIMIT,
    queueTimeoutMs: DEFAULT_SYNC_CONTROL_PLANE_QUEUE_TIMEOUT_MS,
  });
}

/** The reserve an admission may use: control-plane fetches only. */
export function controlPlaneReserveFor(
  policy: object,
  source: SyncAdmissionSource,
): SyncReserve | undefined {
  return source === 'control-plane' ? syncReserveOf(policy, CONTROL_PLANE_QUEUE_POOL) : undefined;
}
