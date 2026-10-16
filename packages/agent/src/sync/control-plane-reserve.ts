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
 * reserved fetch does not count against them.
 *
 * The reserve adds room to run, not a queue. A fetch that finds this slot
 * busy too waits where it waited before, in the general queue, and on a node
 * without one it is refused at once as before. Its callers include the
 * authorization of an inbound sync request, which holds a responder slot
 * meanwhile, and loops that ask one peer after another, so a wait of their
 * own would cost more than the refusal. A refresh nested in an admitted sync
 * runs inside that admission and takes nothing here. Partitioned admission
 * has no control-plane reserve: its fast partition holds this work.
 *
 * Env DKG_SYNC_CONTROL_PLANE_RESERVED_INFLIGHT; 0 turns the reserve off.
 */
export const DEFAULT_SYNC_CONTROL_PLANE_RESERVED_INFLIGHT = 1;
const CONTROL_PLANE_RESERVE = 'control-plane';

/** The control-plane reserve of a shared sync policy, resolved like its other limits. */
export function controlPlaneReserve(): SyncReserve {
  return Object.freeze({
    pool: CONTROL_PLANE_RESERVE,
    maxInflight: nonNegativeInteger(parseIntegerEnv('DKG_SYNC_CONTROL_PLANE_RESERVED_INFLIGHT'))
      ?? DEFAULT_SYNC_CONTROL_PLANE_RESERVED_INFLIGHT,
  });
}

/** The reserve an admission may use: control-plane fetches only. */
export function controlPlaneReserveFor(
  policy: object,
  source: SyncAdmissionSource,
): SyncReserve | undefined {
  return source === 'control-plane' ? syncReserveOf(policy, CONTROL_PLANE_RESERVE) : undefined;
}
