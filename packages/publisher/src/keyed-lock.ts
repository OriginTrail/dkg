import { sharedMemoryScopeKey } from '@origintrail-official/dkg-core';

export { withKeyedLocks } from '@origintrail-official/dkg-core';

/**
 * The per-KA SWM write-lock key.
 *
 * EVERY path that writes a shared-working-memory per-KA layer graph must
 * serialize on this exact key, against the SAME lock map (the agent owns it and
 * injects it into SharedMemoryHandler). Live gossip already does; the public
 * catch-up materializer must too, or this interleaving destroys data:
 *
 *   1. catch-up observes the KA's assertion graph is absent
 *   2. gossip acquires its lock and commits a newer, richer graph
 *   3. catch-up replaces that graph with its older verified snapshot
 *
 * Deriving the key in ONE exported function is what makes drift impossible —
 * two hand-rolled copies of this string format would fail silently, as an
 * unequal key does not error, it just stops serializing.
 *
 * The UAL segment is lowercased: UAL address segments appear in both
 * checksummed and lowercase forms depending on the source (chain read vs head
 * subject), and a case mismatch would under-merge the lock. Over-merging two
 * distinct KAs into one key would merely coarsen serialization; under-merging
 * recreates the race. Lowercase is therefore the safe direction.
 */
export function swmKaWriteLockKey(
  contextGraphId: string,
  subGraphName: string | undefined,
  kaUal: string,
): string {
  return `${sharedMemoryScopeKey(contextGraphId, subGraphName)}\0ka\0${kaUal.toLowerCase()}`;
}

/**
 * Shared key for entity writes and expiration cleanup on the agent's lock map.
 * Preserve subject case: RDF subjects are case-sensitive, unlike KA addresses.
 */
export function swmEntityWriteLockKey(
  contextGraphId: string,
  subGraphName: string | undefined,
  subject: string,
): string {
  return `${sharedMemoryScopeKey(contextGraphId, subGraphName)}\0${subject}`;
}
