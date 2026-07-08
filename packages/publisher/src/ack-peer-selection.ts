import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';

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

const FALLBACK_CANDIDATE_MULTIPLIER = 2;

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

function appendUnique(target: string[], ids: readonly string[], max: number): void {
  for (const id of ids) {
    if (target.length >= max) return;
    if (!target.includes(id)) target.push(id);
  }
}

function boundedCandidateLimit(requiredACKs: number): number {
  return Math.max(1, requiredACKs) * FALLBACK_CANDIDATE_MULTIPLIER;
}

function appendBoundedFallback(
  selected: string[],
  fallback: readonly string[],
  requiredACKs: number,
): string[] {
  const max = Math.max(selected.length, boundedCandidateLimit(requiredACKs));
  appendUnique(selected, fallback, max);
  return selected;
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
  knownCorePeerIds?: ReadonlySet<string>;
  knownCorePeerIdsV2?: ReadonlySet<string>;
}): ACKCandidatePeerDiagnostic {
  const protocolMatch = input.protocol === PROTOCOL_STORAGE_ACK_V2
    ? (input.knownCorePeerIdsV2?.has(input.peerId) ?? false)
    : input.protocol === PROTOCOL_STORAGE_ACK
      ? (input.knownCorePeerIds?.has(input.peerId) ?? false)
      : true;
  const selected = input.selected.has(input.peerId);
  let reason = selected ? 'selected' : 'bounded-fallback';
  if (!input.allowlisted) reason = 'not-allowlisted';
  else if (!protocolMatch && input.protocol === PROTOCOL_STORAGE_ACK_V2) reason = selected ? 'selected-protocol-fallback' : 'protocol-fallback';
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
  const connected = input.connectedPeers.filter((id) => id !== input.selfPeerId);
  const allowlistedACKPeers = normalizePeerIdSet(input.ackCandidatePeerIds);
  const preferredACKPeers = normalizePeerIdSet(input.preferredACKPeerIds);
  const allowlistEnabled = allowlistedACKPeers.size > 0;
  const eligible = allowlistEnabled
    ? connected.filter((id) => allowlistedACKPeers.has(id))
    : connected;
  const tiers = buildCandidateTiers({
    connected: eligible,
    knownCorePeerIds: input.knownCorePeerIds,
    knownCorePeerIdsV2: input.knownCorePeerIdsV2,
    protocol: input.protocol,
  });

  let peers: string[];
  if (allowlistEnabled) {
    peers = flattenTiers(tiers, preferredACKPeers);
  } else if (input.protocol === PROTOCOL_STORAGE_ACK_V2) {
    const v2Advertised = tiers.find((tier) => tier.name === 'v2Advertised')?.peers ?? [];
    peers = rankPreferredWithinTier(v2Advertised, preferredACKPeers);
    appendBoundedFallback(
      peers,
      flattenTiers(tiers.filter((tier) => tier.name !== 'v2Advertised'), preferredACKPeers),
      input.requiredACKs,
    );
  } else {
    const confirmedCore = tiers.find((tier) => tier.name === 'confirmedCore')?.peers ?? [];
    const rest = flattenTiers(tiers.filter((tier) => tier.name === 'rest'), preferredACKPeers);
    if (confirmedCore.length >= input.requiredACKs) {
      peers = rankPreferredWithinTier(confirmedCore, preferredACKPeers);
      if (preferredACKPeers.size > 0) {
        appendBoundedFallback(peers, rest, input.requiredACKs);
      }
    } else if (confirmedCore.length > 0) {
      peers = rankPreferredWithinTier(confirmedCore, preferredACKPeers);
      appendBoundedFallback(peers, rest, input.requiredACKs);
    } else {
      peers = [];
      appendBoundedFallback(peers, flattenTiers(tiers, preferredACKPeers), input.requiredACKs);
    }
  }

  const tierMap = tierByPeer(tiers);
  const selected = new Set(peers);
  const diagnostics = connected.map((peerId) => diagnosticForPeer({
    peerId,
    selected,
    tier: tierMap.get(peerId) ?? 'rest',
    preferred: preferredACKPeers,
    allowlisted: !allowlistEnabled || allowlistedACKPeers.has(peerId),
    protocol: input.protocol,
    knownCorePeerIds: input.knownCorePeerIds,
    knownCorePeerIdsV2: input.knownCorePeerIdsV2,
  }));

  return { peers, diagnostics };
}

export function selectACKCandidatePeers(input: ACKCandidatePeerSelectionInput): string[] {
  return selectACKCandidatePeersWithDiagnostics(input).peers;
}
