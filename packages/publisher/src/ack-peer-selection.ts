import { PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';

export interface ACKCandidatePeerSelectionInput {
  connectedPeers: readonly string[];
  ackCandidatePeerIds?: readonly string[];
  knownCorePeerIds?: ReadonlySet<string>;
  knownCorePeerIdsV2?: ReadonlySet<string>;
  requiredACKs: number;
  protocol?: string;
  selfPeerId?: string;
}

export function selectACKCandidatePeers(input: ACKCandidatePeerSelectionInput): string[] {
  const connected = input.connectedPeers.filter((id) => id !== input.selfPeerId);
  const allowedACKPeers = new Set(
    (input.ackCandidatePeerIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
  );
  const eligible = allowedACKPeers.size > 0
    ? connected.filter((id) => allowedACKPeers.has(id))
    : connected;
  const confirmedCore = input.knownCorePeerIds
    ? eligible.filter((id) => input.knownCorePeerIds!.has(id))
    : [];

  if (input.protocol === PROTOCOL_STORAGE_ACK_V2) {
    const v2Advertised = input.knownCorePeerIdsV2
      ? eligible.filter((id) => input.knownCorePeerIdsV2!.has(id))
      : [];
    const v2Set = new Set(v2Advertised);
    const remainingConfirmedCore = confirmedCore.filter((id) => !v2Set.has(id));
    const seen = new Set([...v2Advertised, ...remainingConfirmedCore]);
    const rest = eligible.filter((id) => !seen.has(id));
    // Identify metadata can be stale. Prefer advertised V2 peers, but keep
    // fallback candidates so wire negotiation, not cached metadata, is the gate.
    return [...v2Advertised, ...remainingConfirmedCore, ...rest];
  }

  if (confirmedCore.length >= input.requiredACKs) return confirmedCore;
  const rest = eligible.filter((id) => !input.knownCorePeerIds?.has(id));
  return [...confirmedCore, ...rest];
}
