import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_STORAGE_UPDATE_ACK_V2, isStorageACKProtocol, type StorageACKProtocol } from '@origintrail-official/dkg-core';

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
  requiredACKs: number;
  protocol?: StorageACKProtocol;
  selfPeerId?: string;
}

/** @deprecated Use the canonical selector with `capability`. */
export interface ACKCandidatePeerSelectionInput extends ACKCanonicalCandidatePeerSelectionInput {
  knownCorePeerIds?: ReadonlySet<string>;
  knownCorePeerIdsV2?: ReadonlySet<string>;
}

type ACKCandidateTierName = 'requestedProtocol' | 'v2Advertised' | 'confirmedCore' | 'rest';

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

function adaptLegacyInput(input: ACKCandidatePeerSelectionInput): {
  canonical: ACKCanonicalCandidatePeerSelectionInput;
  legacyV2Tier: boolean;
} {
  if (input.protocol !== undefined && !isStorageACKProtocol(input.protocol)) {
    throw new Error(`Unsupported StorageACK protocol: ${input.protocol}`);
  }
  if (input.capability && (input.knownCorePeerIds || input.knownCorePeerIdsV2)) {
    throw new TypeError('Use either capability or legacy knownCorePeerIds fields');
  }
  if (input.capability) return { canonical: input, legacyV2Tier: false };
  if (!input.knownCorePeerIds && !input.knownCorePeerIdsV2) {
    return { canonical: input, legacyV2Tier: false };
  }
  const requestedProtocolPeers = input.protocol === PROTOCOL_STORAGE_ACK_V2
    || input.protocol === PROTOCOL_STORAGE_UPDATE_ACK_V2
    ? input.knownCorePeerIdsV2 ?? new Set<string>()
    : undefined;
  const { knownCorePeerIds: _knownCorePeerIds, knownCorePeerIdsV2: _knownCorePeerIdsV2, ...rest } = input;
  return {
    canonical: { ...rest, capability: { mode: 'rank', corePeers: input.knownCorePeerIds, requestedProtocolPeers } },
    legacyV2Tier: requestedProtocolPeers !== undefined,
  };
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

/** @deprecated Use selectCanonicalACKCandidateUniverse. */
export function selectACKCandidateUniverse(input: Pick<
  ACKCandidatePeerSelectionInput,
  'connectedPeers' | 'ackCandidatePeerIds' | 'selfPeerId' | 'localCandidate'
  | 'capability' | 'knownCorePeerIds' | 'knownCorePeerIdsV2' | 'protocol'
>): string[] {
  return selectCanonicalACKCandidateUniverse(adaptLegacyInput({ ...input, requiredACKs: 0 }).canonical);
}

function candidateUniverse(input: Pick<
  ACKCandidatePeerSelectionInput,
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
}): ACKCandidatePeerDiagnostic {
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
): ACKCandidatePeerSelectionResult {
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
  const localDiagnostic: ACKCandidatePeerDiagnostic = {
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

/** @deprecated Compatibility adapter for callers using knownCorePeerIds. */
export function selectACKCandidatePeersWithDiagnostics(
  input: ACKCandidatePeerSelectionInput,
): ACKCandidatePeerSelectionResult {
  const { canonical, legacyV2Tier } = adaptLegacyInput(input);
  const result = selectCanonicalACKCandidatePeersWithDiagnostics(canonical);
  if (!legacyV2Tier) return result;
  return {
    peers: result.peers,
    diagnostics: result.diagnostics.map((diagnostic) => diagnostic.tier === 'requestedProtocol'
      ? { ...diagnostic, tier: 'v2Advertised' }
      : diagnostic),
  };
}

export function selectACKCandidatePeers(input: ACKCandidatePeerSelectionInput): string[] {
  return selectACKCandidatePeersWithDiagnostics(input).peers;
}
