import { PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';

export interface ACKCandidatePeerSelectionInput {
  connectedPeers: readonly string[];
  /** Legacy eligibility allowlist. When set, unlisted connected peers are not ACK candidates. */
  ackCandidatePeerIds?: readonly string[];
  /** Preference-only ranking list. Listed peers are ordered first within each tier but never gate eligibility. */
  preferredACKPeerIds?: readonly string[];
  knownCorePeerIds?: ReadonlySet<string>;
  knownCorePeerIdsV2?: ReadonlySet<string>;
  requiredACKs: number;
  protocol?: string;
  selfPeerId?: string;
}

type ACKCandidateTierName = 'v2Advertised' | 'confirmedCore' | 'rest';

interface ACKCandidateTier {
  name: ACKCandidateTierName;
  peers: string[];
}

function normalizePeerIdSet(ids: readonly string[] | undefined): Set<string> {
  return new Set((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
}

function rankPreferredWithinTier(ids: readonly string[], preferred: ReadonlySet<string>): string[] {
  if (preferred.size === 0) return [...ids];
  const listed: string[] = [];
  const unlisted: string[] = [];
  for (const id of ids) (preferred.has(id) ? listed : unlisted).push(id);
  return [...listed, ...unlisted];
}

function flattenTiers(tiers: readonly ACKCandidateTier[], preferred: ReadonlySet<string>): string[] {
  return tiers.flatMap((tier) => rankPreferredWithinTier(tier.peers, preferred));
}

function buildCandidateTiers(input: {
  connected: readonly string[];
  knownCorePeerIds?: ReadonlySet<string>;
  knownCorePeerIdsV2?: ReadonlySet<string>;
  protocol?: string;
}): ACKCandidateTier[] {
  const confirmedCore = input.knownCorePeerIds
    ? input.connected.filter((id) => input.knownCorePeerIds!.has(id))
    : [];

  if (input.protocol === PROTOCOL_STORAGE_ACK_V2) {
    const v2Advertised = input.knownCorePeerIdsV2
      ? input.connected.filter((id) => input.knownCorePeerIdsV2!.has(id))
      : [];
    const v2Set = new Set(v2Advertised);
    const remainingConfirmedCore = confirmedCore.filter((id) => !v2Set.has(id));
    const seen = new Set([...v2Advertised, ...remainingConfirmedCore]);
    return [
      { name: 'v2Advertised', peers: v2Advertised },
      { name: 'confirmedCore', peers: remainingConfirmedCore },
      { name: 'rest', peers: input.connected.filter((id) => !seen.has(id)) },
    ];
  }

  const confirmedSet = new Set(confirmedCore);
  return [
    { name: 'confirmedCore', peers: confirmedCore },
    { name: 'rest', peers: input.connected.filter((id) => !confirmedSet.has(id)) },
  ];
}

export function selectACKCandidatePeers(input: ACKCandidatePeerSelectionInput): string[] {
  const connected = input.connectedPeers.filter((id) => id !== input.selfPeerId);
  const allowlistedACKPeers = normalizePeerIdSet(input.ackCandidatePeerIds);
  const preferredACKPeers = normalizePeerIdSet(input.preferredACKPeerIds);
  const eligible = allowlistedACKPeers.size > 0
    ? connected.filter((id) => allowlistedACKPeers.has(id))
    : connected;
  const tiers = buildCandidateTiers({
    connected: eligible,
    knownCorePeerIds: input.knownCorePeerIds,
    knownCorePeerIdsV2: input.knownCorePeerIdsV2,
    protocol: input.protocol,
  });

  if (input.protocol === PROTOCOL_STORAGE_ACK_V2) {
    // Identify metadata can be stale. Prefer advertised V2 peers, but keep
    // fallback candidates so wire negotiation, not cached metadata, is the gate.
    return flattenTiers(tiers, preferredACKPeers);
  }

  const confirmedCore = tiers.find((tier) => tier.name === 'confirmedCore')?.peers ?? [];
  if (confirmedCore.length >= input.requiredACKs && preferredACKPeers.size === 0) {
    return confirmedCore;
  }

  if (confirmedCore.length >= input.requiredACKs && preferredACKPeers.size > 0) {
    // Identify-time core claims are unverified and chain-agnostic, so a
    // quorum-sized confirmedCore can be entirely foreign-network peers
    // during the post-connect identify race (e.g. right after a daemon
    // restart redials stale peer-store entries). When the daemon supplies
    // network relays as a preference-only list, keep the remaining connected
    // candidates in the shortcut too; chain truth, not cached identify metadata,
    // decides which ACKs count.
    return flattenTiers(tiers, preferredACKPeers);
  }

  return flattenTiers(tiers, preferredACKPeers);
}
