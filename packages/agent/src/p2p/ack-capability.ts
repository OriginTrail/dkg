import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';

/** Reconcile a populated identify record; an empty record means identify is still pending. */
export function reconcileACKCapabilities(
  peerId: string,
  protocols: readonly string[],
  knownCorePeerIds: Set<string>,
  knownCorePeerIdsV2: Set<string>,
): void {
  if (protocols.length === 0) return;
  if (protocols.includes(PROTOCOL_STORAGE_ACK)) knownCorePeerIds.add(peerId);
  else knownCorePeerIds.delete(peerId);
  if (protocols.includes(PROTOCOL_STORAGE_ACK_V2)) knownCorePeerIdsV2.add(peerId);
  else knownCorePeerIdsV2.delete(peerId);
}
