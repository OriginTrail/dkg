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
  const preferredACKPeers = new Set(
    (input.ackCandidatePeerIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
  );
  // `ackCandidatePeerIds` never gates eligibility — it only orders the
  // returned array (listed peers first within each tier). The ordering is
  // cosmetic today: ACKCollector dials every candidate concurrently, so
  // the effective change vs. the PR #1482 hard filter is precisely the
  // un-filtering. The authoritative "may this peer sign?" check is chain
  // truth, enforced per collected ACK (operational-key purpose + active
  // sharding-table membership — i.e. a staked core; see
  // `verifyACKIdentityDetailed`) and re-verified on-chain by the publish
  // tx itself. Hard-filtering candidacy to the static network-config
  // relay list capped the pool at 4-6 specific peers and made quorum
  // arithmetically unreachable whenever enough of those relays were
  // degraded or mid-upgrade — the 2026-07-07 Base/Gnosis mainnet ACK
  // outage — while other staked cores sat connected but undialable. A
  // foreign-network or stale peer in the pool cannot produce a
  // chain-valid ACK; it costs a wasted concurrent dial (and, in failing
  // rounds, deferral of the impossible-quorum fast-fail until it
  // settles — bounded, and identical to the pre-#1482 baseline).
  const preferListed = (ids: string[]): string[] => {
    if (preferredACKPeers.size === 0) return ids;
    const listed: string[] = [];
    const unlisted: string[] = [];
    for (const id of ids) (preferredACKPeers.has(id) ? listed : unlisted).push(id);
    return [...listed, ...unlisted];
  };
  const confirmedCore = input.knownCorePeerIds
    ? connected.filter((id) => input.knownCorePeerIds!.has(id))
    : [];

  if (input.protocol === PROTOCOL_STORAGE_ACK_V2) {
    const v2Advertised = input.knownCorePeerIdsV2
      ? connected.filter((id) => input.knownCorePeerIdsV2!.has(id))
      : [];
    const v2Set = new Set(v2Advertised);
    const remainingConfirmedCore = confirmedCore.filter((id) => !v2Set.has(id));
    const seen = new Set([...v2Advertised, ...remainingConfirmedCore]);
    const rest = connected.filter((id) => !seen.has(id));
    // Identify metadata can be stale. Prefer advertised V2 peers, but keep
    // fallback candidates so wire negotiation, not cached metadata, is the gate.
    return [
      ...preferListed(v2Advertised),
      ...preferListed(remainingConfirmedCore),
      ...preferListed(rest),
    ];
  }

  if (confirmedCore.length >= input.requiredACKs) {
    if (preferredACKPeers.size === 0) return confirmedCore;
    // Identify-time core claims are unverified and chain-agnostic, so a
    // quorum-sized confirmedCore can be entirely foreign-network peers
    // during the post-connect identify race (e.g. right after a daemon
    // restart redials stale peer-store entries). Never let the shortcut
    // exclude connected LISTED peers — they are this network's configured
    // relays and the recovery path when the confirmed set is poisoned.
    // Residual corner: connected UNLISTED cores whose identify is still
    // pending stay outside a firing shortcut until reclassification;
    // closing that fully needs chain-truth candidacy (peer IDs derivable
    // from the sharding table), which today's random profile `nodeId`s
    // prevent.
    const confirmedSet = new Set(confirmedCore);
    const listedRest = connected.filter(
      (id) => preferredACKPeers.has(id) && !confirmedSet.has(id),
    );
    return [...preferListed(confirmedCore), ...listedRest];
  }
  const rest = connected.filter((id) => !input.knownCorePeerIds?.has(id));
  return [...preferListed(confirmedCore), ...preferListed(rest)];
}
