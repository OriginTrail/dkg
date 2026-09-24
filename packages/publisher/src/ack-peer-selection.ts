import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_STORAGE_UPDATE_ACK_V2 } from '@origintrail-official/dkg-core';

export type ACKCapabilitySelectionPolicy =
  | { mode: 'rank'; v1?: ReadonlySet<string>; v2?: ReadonlySet<string> }
  | { mode: 'require'; v1: ReadonlySet<string>; v2?: ReadonlySet<string> };

export interface ACKCandidatePeerSelectionInput {
  connectedPeers: readonly string[];
  /** Legacy eligibility allowlist. When set, unlisted connected peers are not ACK candidates. */
  ackCandidatePeerIds?: readonly string[];
  /** Preference-only ranking list. Listed peers are ordered first within each tier but never gate eligibility. */
  preferredACKPeerIds?: readonly string[];
  /** Active-network admission filter. When set, peers outside this set are not ACK candidates. */
  verifiedSameNetworkPeerIds?: ReadonlySet<string>;
  /** One capability snapshot drives eligibility, ordering, and diagnostics. */
  capability?: ACKCapabilitySelectionPolicy;
  requiredACKs: number;
  protocol?: string;
  selfPeerId?: string;
}

type ACKCandidateTierName = 'v2Advertised' | 'confirmedCore' | 'rest';

interface ACKCandidateTier {
  name: ACKCandidateTierName;
  peers: string[];
}

export interface ACKCandidatePeerDiagnostic {
  peerId: string;
  tier: ACKCandidateTierName;
  preferred: boolean;
  allowlisted: boolean;
  protocolMatch: boolean;
  selected: boolean;
  reason: string;
}

export interface ACKCandidatePeerSelectionResult {
  peers: string[];
  diagnostics: ACKCandidatePeerDiagnostic[];
}

function normalizePeerIdSet(ids: readonly string[] | undefined): Set<string> {
  return new Set((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
}

export function selectACKCandidateUniverse(input: Pick<
  ACKCandidatePeerSelectionInput,
  'connectedPeers' | 'ackCandidatePeerIds' | 'selfPeerId'
  | 'capability'
>): string[] {
  const connected = [...new Set(input.connectedPeers)]
    .filter((id) => id !== input.selfPeerId);
  const allowlistedACKPeers = normalizePeerIdSet(input.ackCandidatePeerIds);
  const allowlisted = allowlistedACKPeers.size > 0
    ? connected.filter((id) => allowlistedACKPeers.has(id))
    : connected;
  const capability = input.capability;
  return capability?.mode === 'require'
    ? allowlisted.filter((id) => capability.v1.has(id))
    : allowlisted;
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
  capability?: ACKCapabilitySelectionPolicy;
  protocol?: string;
}): ACKCandidateTier[] {
  const confirmedCore = input.capability?.v1
    ? input.connected.filter((id) => input.capability?.v1?.has(id))
    : [];

  if (input.protocol === PROTOCOL_STORAGE_ACK_V2 || input.protocol === PROTOCOL_STORAGE_UPDATE_ACK_V2) {
    const v2Advertised = input.capability?.v2
      ? input.connected.filter((id) => input.capability?.v2?.has(id))
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

function tierByPeer(tiers: readonly ACKCandidateTier[]): Map<string, ACKCandidateTierName> {
  const result = new Map<string, ACKCandidateTierName>();
  for (const tier of tiers) {
    for (const peerId of tier.peers) result.set(peerId, tier.name);
  }
  return result;
}

function diagnosticForPeer(input: {
  peerId: string;
  selected: ReadonlySet<string>;
  tier: ACKCandidateTierName;
  preferred: ReadonlySet<string>;
  allowlisted: boolean;
  protocol?: string;
  capability?: ACKCapabilitySelectionPolicy;
}): ACKCandidatePeerDiagnostic {
  const protocolMatch = input.protocol === PROTOCOL_STORAGE_ACK_V2 || input.protocol === PROTOCOL_STORAGE_UPDATE_ACK_V2
    ? (input.capability?.v2?.has(input.peerId) ?? false)
    : input.protocol === PROTOCOL_STORAGE_ACK
      ? (input.capability?.v1?.has(input.peerId) ?? false)
      : true;
  const selected = input.selected.has(input.peerId);
  let reason = selected ? 'selected' : 'not-selected';
  if (!input.allowlisted) reason = 'not-allowlisted';
  else if (input.capability?.mode === 'require' && !input.capability.v1.has(input.peerId)) reason = 'not-core-capable';
  else if (!protocolMatch && (input.protocol === PROTOCOL_STORAGE_ACK_V2 || input.protocol === PROTOCOL_STORAGE_UPDATE_ACK_V2)) reason = selected ? 'selected-protocol-fallback' : 'protocol-fallback';
  return {
    peerId: input.peerId,
    tier: input.tier,
    preferred: input.preferred.has(input.peerId),
    allowlisted: input.allowlisted,
    protocolMatch,
    selected,
    reason,
  };
}

export function selectACKCandidatePeersWithDiagnostics(
  input: ACKCandidatePeerSelectionInput,
): ACKCandidatePeerSelectionResult {
  const connected = [...new Set(input.connectedPeers)]
    .filter((id) => id !== input.selfPeerId);
  const allowlistedACKPeers = normalizePeerIdSet(input.ackCandidatePeerIds);
  const preferredACKPeers = normalizePeerIdSet(input.preferredACKPeerIds);
  const allowlistEnabled = allowlistedACKPeers.size > 0;
  const allowlisted = selectACKCandidateUniverse(input);
  const eligible = input.verifiedSameNetworkPeerIds
    ? allowlisted.filter((id) => input.verifiedSameNetworkPeerIds!.has(id))
    : allowlisted;
  const tiers = buildCandidateTiers({
    connected: eligible,
    capability: input.capability,
    protocol: input.protocol,
  });

  const peers = flattenTiers(tiers, preferredACKPeers);

  const tierMap = tierByPeer(tiers);
  const selected = new Set(peers);
  const diagnostics = connected.map((peerId) => diagnosticForPeer({
    peerId,
    selected,
    tier: tierMap.get(peerId) ?? 'rest',
    preferred: preferredACKPeers,
    allowlisted:
      (!allowlistEnabled || allowlistedACKPeers.has(peerId)) &&
      (!input.verifiedSameNetworkPeerIds || input.verifiedSameNetworkPeerIds.has(peerId)),
    protocol: input.protocol,
    capability: input.capability,
  }));

  return { peers, diagnostics };
}

export function selectACKCandidatePeers(input: ACKCandidatePeerSelectionInput): string[] {
  return selectACKCandidatePeersWithDiagnostics(input).peers;
}
