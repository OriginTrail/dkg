import { PROTOCOL_STORAGE_ACK, isStorageACKProtocol, type StorageACKProtocol } from '@origintrail-official/dkg-core';

export type ACKCapabilitySelectionPolicy =
  | { mode: 'rank'; corePeers?: ReadonlySet<string>; requestedProtocolPeers?: ReadonlySet<string> }
  | { mode: 'require'; corePeers: ReadonlySet<string>; requestedProtocolPeers?: ReadonlySet<string> };

export interface ACKCanonicalCandidatePeerSelectionInput {
  connectedPeers: readonly string[];
  /** The publishing core is eligible only while its local ACK endpoint is registered. */
  localCandidate?: { peerId: string; available: boolean };
  /** Legacy eligibility allowlist. When set, unlisted connected peers are not ACK candidates. */
  ackCandidatePeerIds?: readonly string[];
  /** Preference-only ranking list. Listed peers are ordered first within each tier but never gate eligibility. */
  preferredACKPeerIds?: readonly string[];
  /** Active-network admission filter. When set, peers outside this set are not ACK candidates. */
  verifiedSameNetworkPeerIds?: ReadonlySet<string>;
  /** One capability snapshot drives eligibility, ordering, and diagnostics. */
  capability?: ACKCapabilitySelectionPolicy;
  protocol?: StorageACKProtocol;
  selfPeerId?: string;
}

type ACKCandidateTierName = 'requestedProtocol' | 'confirmedCore' | 'rest';

interface ACKCandidateTier {
  name: ACKCandidateTierName;
  peers: string[];
}

export interface ACKCanonicalCandidatePeerDiagnostic {
  peerId: string;
  tier: ACKCandidateTierName;
  preferred: boolean;
  allowlisted: boolean;
  protocolMatch: boolean;
  selected: boolean;
  reason: string;
}

export interface ACKCanonicalCandidatePeerSelectionResult {
  peers: string[];
  diagnostics: ACKCanonicalCandidatePeerDiagnostic[];
}

function normalizePeerIdSet(ids: readonly string[] | undefined): Set<string> {
  return new Set((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
}

export function selectCanonicalACKCandidateUniverse(input: Pick<
  ACKCanonicalCandidatePeerSelectionInput,
  'connectedPeers' | 'ackCandidatePeerIds' | 'selfPeerId' | 'localCandidate' | 'capability' | 'protocol'
>): string[] {
  if (input.protocol !== undefined && !isStorageACKProtocol(input.protocol)) {
    throw new Error(`Unsupported StorageACK protocol: ${input.protocol}`);
  }
  return candidateUniverse(input, input.capability);
}

function candidateUniverse(input: Pick<
  ACKCanonicalCandidatePeerSelectionInput,
  'connectedPeers' | 'ackCandidatePeerIds' | 'selfPeerId' | 'localCandidate'
>, capability: ACKCapabilitySelectionPolicy | undefined): string[] {
  const selfPeerId = input.localCandidate?.peerId ?? input.selfPeerId;
  const connected = [...new Set(input.connectedPeers)]
    .filter((id) => id !== selfPeerId);
  const allowlistedACKPeers = normalizePeerIdSet(input.ackCandidatePeerIds);
  const allowlisted = allowlistedACKPeers.size > 0
    ? connected.filter((id) => allowlistedACKPeers.has(id))
    : connected;
  return capability?.mode === 'require'
    ? allowlisted.filter((id) => capability.corePeers.has(id))
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
  corePeers?: ReadonlySet<string>;
  requestedProtocolPeers?: ReadonlySet<string>;
}): ACKCandidateTier[] {
  const confirmedCore = input.corePeers
    ? input.connected.filter((id) => input.corePeers?.has(id))
    : [];

  if (input.requestedProtocolPeers) {
    const requested = input.requestedProtocolPeers
      ? input.connected.filter((id) => input.requestedProtocolPeers?.has(id))
      : [];
    const requestedSet = new Set(requested);
    const remainingConfirmedCore = confirmedCore.filter((id) => !requestedSet.has(id));
    const seen = new Set([...requested, ...remainingConfirmedCore]);
    return [
      { name: 'requestedProtocol', peers: requested },
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
  protocol?: StorageACKProtocol;
  capability?: ACKCapabilitySelectionPolicy;
  corePeers?: ReadonlySet<string>;
  requestedProtocolPeers?: ReadonlySet<string>;
}): ACKCanonicalCandidatePeerDiagnostic {
  const protocolMatch = input.requestedProtocolPeers
    ? input.requestedProtocolPeers.has(input.peerId)
    : input.protocol === PROTOCOL_STORAGE_ACK
      ? (input.corePeers?.has(input.peerId) ?? false)
      : true;
  const selected = input.selected.has(input.peerId);
  let reason = selected ? 'selected' : 'not-selected';
  if (!input.allowlisted) reason = 'not-allowlisted';
  else if (input.capability?.mode === 'require' && !input.corePeers?.has(input.peerId)) reason = 'not-core-capable';
  else if (!protocolMatch && input.requestedProtocolPeers) reason = selected ? 'selected-protocol-fallback' : 'protocol-fallback';
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

export function selectCanonicalACKCandidatePeersWithDiagnostics(
  input: ACKCanonicalCandidatePeerSelectionInput,
): ACKCanonicalCandidatePeerSelectionResult {
  if (input.protocol !== undefined && !isStorageACKProtocol(input.protocol)) {
    throw new Error(`Unsupported StorageACK protocol: ${input.protocol}`);
  }
  const capability = input.capability;
  const selfPeerId = input.localCandidate?.peerId ?? input.selfPeerId;
  const connected = [...new Set(input.connectedPeers)]
    .filter((id) => id !== selfPeerId);
  const allowlistedACKPeers = normalizePeerIdSet(input.ackCandidatePeerIds);
  const preferredACKPeers = normalizePeerIdSet(input.preferredACKPeerIds);
  const allowlistEnabled = allowlistedACKPeers.size > 0;
  const allowlisted = candidateUniverse(input, capability);
  const eligible = input.verifiedSameNetworkPeerIds
    ? allowlisted.filter((id) => input.verifiedSameNetworkPeerIds!.has(id))
    : allowlisted;
  const tiers = buildCandidateTiers({
    connected: eligible,
    corePeers: capability?.corePeers,
    requestedProtocolPeers: capability?.requestedProtocolPeers,
  });

  const remotePeers = flattenTiers(tiers, preferredACKPeers);

  const tierMap = tierByPeer(tiers);
  const selected = new Set(remotePeers);
  const remoteDiagnostics = connected.map((peerId) => diagnosticForPeer({
    peerId,
    selected,
    tier: tierMap.get(peerId) ?? 'rest',
    preferred: preferredACKPeers,
    allowlisted:
      (!allowlistEnabled || allowlistedACKPeers.has(peerId)) &&
      (!input.verifiedSameNetworkPeerIds || input.verifiedSameNetworkPeerIds.has(peerId)),
    protocol: input.protocol,
    capability,
    corePeers: capability?.corePeers,
    requestedProtocolPeers: capability?.requestedProtocolPeers,
  }));

  const local = input.localCandidate;
  if (!local) return { peers: remotePeers, diagnostics: remoteDiagnostics };
  const localDiagnostic: ACKCanonicalCandidatePeerDiagnostic = {
    peerId: local.peerId,
    tier: 'confirmedCore',
    preferred: false,
    allowlisted: true,
    protocolMatch: local.available,
    selected: local.available,
    reason: local.available ? 'selected-local' : 'local-unavailable',
  };
  return {
    peers: local.available ? [local.peerId, ...remotePeers] : remotePeers,
    diagnostics: [localDiagnostic, ...remoteDiagnostics],
  };
}
