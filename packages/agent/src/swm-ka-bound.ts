import type { SwmKaGraphBound } from '@origintrail-official/dkg-storage';
import { unpackKnowledgeAssetId } from './ka-identity.js';

/**
 * Derive the per-author SWM under-graph bound for the finalization gossip read
 * from a KA batch's packed `startKAId`/`endKAId` (#1549).
 *
 * `startKAId`/`endKAId` are packed `(author << 96) | number` (see
 * `packKnowledgeAssetIdFromIdentity`), whereas the SWM under-graph URI's last
 * segment is only the low-96 per-author number. We therefore unpack both ends and
 * bound on `(agentAddress, [startNumber, endNumber])`. A range whose two ends
 * unpack to DIFFERENT authors is not a contiguous per-author number range — the
 * low-96 numbers wrap independently of the high-160 address — so no single
 * `SwmKaGraphBound` can describe it and we return `undefined` (unbounded).
 *
 * PURE: identical inputs always yield an identical result, so this has no home in
 * the message handler. The ops kill-switch (`DKG_DISABLE_SWM_KA_BOUND`) is applied
 * by the finalization orchestration before calling this, not here. Returning
 * `undefined` is always safe: the caller widens to the unbounded read on
 * empty-or-mismatch before it defers.
 */
export function deriveSwmKaGraphBound(startKAId: bigint, endKAId: bigint): SwmKaGraphBound | undefined {
  if (startKAId <= 0n || endKAId < startKAId) return undefined;
  const start = unpackKnowledgeAssetId(startKAId);
  const end = unpackKnowledgeAssetId(endKAId);
  // Both sides come from `unpack`, which is already lowercase, so a plain compare
  // suffices here. The graph-URI side is NOT — see the case-insensitive compare in
  // storage's bounded resolver.
  if (start.agentAddress !== end.agentAddress) return undefined;
  return {
    agentAddress: start.agentAddress,
    startNumber: start.kaNumber,
    endNumber: end.kaNumber,
  };
}
