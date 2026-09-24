import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_STORAGE_UPDATE_ACK_V2 } from '@origintrail-official/dkg-core';

export type ACKCapabilitySelectionPolicy =
  | { mode: 'rank'; corePeers?: ReadonlySet<string>; requestedProtocolPeers?: ReadonlySet<string>; v1?: never; v2?: never }
  | { mode: 'require'; corePeers: ReadonlySet<string>; requestedProtocolPeers?: ReadonlySet<string>; v1?: never; v2?: never }
  /** @deprecated Version-shaped capability fields remain for existing callers. */
  | { mode: 'rank'; v1?: ReadonlySet<string>; v2?: ReadonlySet<string>; corePeers?: never; requestedProtocolPeers?: never }
  | { mode: 'require'; v1: ReadonlySet<string>; v2?: ReadonlySet<string>; corePeers?: never; requestedProtocolPeers?: never };

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
  /** @deprecated Use capability instead. Retained for existing selector callers. */
  knownCorePeerIds?: ReadonlySet<string>;
  /** @deprecated Use capability instead. Retained for existing selector callers. */
  knownCorePeerIdsV2?: ReadonlySet<string>;
  requiredACKs: number;
  protocol?: string;
  selfPeerId?: string;
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

function resolveCapability(input: Pick<ACKCandidatePeerSelectionInput,
  'capability' | 'knownCorePeerIds' | 'knownCorePeerIdsV2'>): ACKCapabilitySelectionPolicy | undefined {
  if (input.capability && (input.knownCorePeerIds || input.knownCorePeerIdsV2)) {
    throw new TypeError('Use either capability or legacy knownCorePeerIds fields');
  }
  return input.capability ?? ((input.knownCorePeerIds || input.knownCorePeerIdsV2)
    ? { mode: 'rank', v1: input.knownCorePeerIds, v2: input.knownCorePeerIdsV2 }
    : undefined);
}

function capabilityViews(capability: ACKCapabilitySelectionPolicy | undefined, protocol?: string): {
  corePeers?: ReadonlySet<string>;
  requestedProtocolPeers?: ReadonlySet<string>;
  requestedTier: 'requestedProtocol' | 'v2Advertised';
} {
  if (!capability) return { requestedTier: 'requestedProtocol' };
  if (capability.corePeers !== undefined || capability.requestedProtocolPeers !== undefined) {
    return {
      corePeers: capability.corePeers,
      requestedProtocolPeers: capability.requestedProtocolPeers,
      requestedTier: 'requestedProtocol',
    };
  }
  return {
    corePeers: capability.v1,
    requestedProtocolPeers: protocol === PROTOCOL_STORAGE_ACK_V2 || protocol === PROTOCOL_STORAGE_UPDATE_ACK_V2
      ? capability.v2 ?? new Set<string>() : undefined,
    requestedTier: 'v2Advertised',
  };
}

export function selectACKCandidateUniverse(input: Pick<
  ACKCandidatePeerSelectionInput,
  'connectedPeers' | 'ackCandidatePeerIds' | 'selfPeerId'
  | 'capability' | 'knownCorePeerIds' | 'knownCorePeerIdsV2'
>): string[] {
  const connected = [...new Set(input.connectedPeers)]
    .filter((id) => id !== input.selfPeerId);
  const allowlistedACKPeers = normalizePeerIdSet(input.ackCandidatePeerIds);
  const allowlisted = allowlistedACKPeers.size > 0
    ? connected.filter((id) => allowlistedACKPeers.has(id))
    : connected;
  const capability = resolveCapability(input);
  const { corePeers } = capabilityViews(capability);
  return capability?.mode === 'require'
    ? allowlisted.filter((id) => corePeers?.has(id))
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
  requestedTier: 'requestedProtocol' | 'v2Advertised';
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
      { name: input.requestedTier, peers: requested },
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

export function selectACKCandidatePeersWithDiagnostics(
  input: ACKCandidatePeerSelectionInput,
): ACKCandidatePeerSelectionResult {
  const capability = resolveCapability(input);
  const views = capabilityViews(capability, input.protocol);
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
    ...views,
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
    capability,
    corePeers: views.corePeers,
    requestedProtocolPeers: views.requestedProtocolPeers,
  }));

  return { peers, diagnostics };
}

export function selectACKCandidatePeers(input: ACKCandidatePeerSelectionInput): string[] {
  return selectACKCandidatePeersWithDiagnostics(input).peers;
}
