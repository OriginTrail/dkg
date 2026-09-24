import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_STORAGE_UPDATE_ACK_V2 } from '@origintrail-official/dkg-core';
import { STORAGE_ACK_PROTOCOLS } from './storage-ack-protocols.js';
import {
  selectACKCandidateUniverse,
  selectACKCandidatePeersWithDiagnostics,
  type ACKCandidatePeerSelectionInput,
  type ACKCandidatePeerSelectionResult,
} from '@origintrail-official/dkg-publisher';

export interface ACKCapabilitySnapshot {
  knownCorePeerIds: ReadonlySet<string>;
  knownCorePeerIdsV2: ReadonlySet<string>;
}

export interface ACKRoundPorts {
  connectedPeers: readonly string[];
  selfPeerId: string;
  ackCandidatePeerIds?: readonly string[];
  preferredACKPeerIds?: readonly string[];
  requiredACKs: number;
  protocol: string;
  selfCount: number;
  getPeerProtocols(peerId: string): Promise<string[]>;
  preflight(peerIds: string[]): Promise<void>;
  isAcceptedPeer(peerId: string): boolean;
  probeProtocol?(peerId: string, protocol: string): Promise<'supported' | 'unsupported' | 'unavailable'>;
}

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

function rotated<T>(items: readonly T[], cursor: number): T[] {
  if (items.length === 0) return [];
  const offset = cursor % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/** Owns ACK capability state and bounded, fair discovery for a publish round. */
export class ACKCapabilityRegistry {
  readonly knownCorePeerIds = new Set<string>();
  readonly knownCorePeerIdsV2 = new Set<string>();
  private readonly advertised = new Map<string, Set<string>>();
  private readonly negotiated = new Map<string, Set<string>>();
  private preferredProbeCursor = 0;
  private otherProbeCursor = 0;

  reconcile(peerId: string, protocols: readonly string[]): void {
    if (protocols.length === 0) return;
    for (const peers of this.negotiated.values()) peers.delete(peerId);
    this.refresh(peerId, protocols);
  }

  private refresh(peerId: string, protocols: readonly string[]): void {
    if (protocols.length === 0) return;
    reconcileACKCapabilities(peerId, protocols, this.knownCorePeerIds, this.knownCorePeerIdsV2);
    for (const [protocol] of STORAGE_ACK_PROTOCOLS) {
      let peers = this.advertised.get(protocol);
      if (!peers) this.advertised.set(protocol, peers = new Set());
      if (protocols.includes(protocol)) peers.add(peerId);
      else peers.delete(peerId);
    }
    if (this.negotiated.get(PROTOCOL_STORAGE_ACK)?.has(peerId)) this.knownCorePeerIds.add(peerId);
    if (this.negotiated.get(PROTOCOL_STORAGE_ACK_V2)?.has(peerId)) this.knownCorePeerIdsV2.add(peerId);
  }

  forget(peerId: string): void {
    this.knownCorePeerIds.delete(peerId);
    this.knownCorePeerIdsV2.delete(peerId);
    for (const peers of this.advertised.values()) peers.delete(peerId);
    for (const peers of this.negotiated.values()) peers.delete(peerId);
  }

  private markNegotiated(peerId: string, protocol: string): void {
    let peers = this.negotiated.get(protocol);
    if (!peers) this.negotiated.set(protocol, peers = new Set());
    peers.add(peerId);
    if (protocol === PROTOCOL_STORAGE_ACK) this.knownCorePeerIds.add(peerId);
    if (protocol === PROTOCOL_STORAGE_ACK_V2) this.knownCorePeerIdsV2.add(peerId);
  }

  private supporters(protocol: string): Set<string> {
    return new Set([
      ...(this.advertised.get(protocol) ?? []),
      ...(this.negotiated.get(protocol) ?? []),
    ]);
  }

  snapshot(): ACKCapabilitySnapshot {
    return {
      knownCorePeerIds: new Set(this.knownCorePeerIds),
      knownCorePeerIdsV2: new Set(this.knownCorePeerIdsV2),
    };
  }

  selectCandidates(
    input: Omit<ACKCandidatePeerSelectionInput, 'capability'>,
    snapshot: ACKCapabilitySnapshot = this.snapshot(),
  ): ACKCandidatePeerSelectionResult {
    return selectACKCandidatePeersWithDiagnostics({
      ...input,
      capability: { mode: 'require', v1: snapshot.knownCorePeerIds, v2: snapshot.knownCorePeerIdsV2 },
    });
  }

  async resolveRound(ports: ACKRoundPorts): Promise<ACKCapabilitySnapshot> {
    await Promise.all(ports.connectedPeers.map(async (peerId) => {
      this.refresh(peerId, await ports.getPeerProtocols(peerId));
    }));
    // Keep preflight and final selection on this round's snapshot even if
    // peer:update changes the registry while the round is in progress.
    const corePeerIds = new Set(this.knownCorePeerIds);
    const protocolPeerIds = ports.protocol === PROTOCOL_STORAGE_ACK
      ? corePeerIds : this.supporters(ports.protocol);
    const corePeerIdsV2 = ports.protocol === PROTOCOL_STORAGE_ACK_V2
      ? new Set(this.knownCorePeerIdsV2)
      : this.supporters(ports.protocol);
    const base = {
      connectedPeers: ports.connectedPeers,
      ackCandidatePeerIds: ports.ackCandidatePeerIds,
      selfPeerId: ports.selfPeerId,
      capability: { mode: 'require' as const, v1: corePeerIds },
    };
    await ports.preflight(selectACKCandidateUniverse(base));

    // One spare beyond bare quorum lets the collector survive one candidate
    // decline or timeout without another discovery round.
    const target = ports.requiredACKs + 1;
    const admitted = (): number => selectACKCandidateUniverse(base)
      .filter((peerId) => protocolPeerIds.has(peerId) && ports.isAcceptedPeer(peerId)).length + ports.selfCount;
    if (ports.probeProtocol) {
      const unconfirmed = selectACKCandidateUniverse({
        connectedPeers: ports.connectedPeers,
        ackCandidatePeerIds: ports.ackCandidatePeerIds,
        selfPeerId: ports.selfPeerId,
      }).filter((peerId) => !protocolPeerIds.has(peerId));
      const preferredIds = new Set(ports.preferredACKPeerIds ?? []);
      const preferred = unconfirmed.filter((peerId) => preferredIds.has(peerId));
      const other = unconfirmed.filter((peerId) => !preferredIds.has(peerId));
      // Reserve a few slots for nonpreferred peers if preferences alone exceed
      // the per-round cap. Both groups rotate so no stable prefix can starve.
      // A non-base probe may need a second negotiation to confirm the core
      // role, so cap it at 16 peers to retain 32 total protocol probes.
      const peerLimit = ports.protocol === PROTOCOL_STORAGE_ACK ? 32 : 16;
      const preferredBudget = other.length > 0 && preferred.length >= peerLimit
        ? peerLimit - 8 : peerLimit;
      const chosen = [
        ...rotated(preferred, this.preferredProbeCursor).slice(0, preferredBudget),
        ...rotated(other, this.otherProbeCursor).slice(0, peerLimit - Math.min(preferred.length, preferredBudget)),
      ];
      for (let offset = 0; offset < chosen.length; offset += 4) {
        const batch = chosen.slice(offset, offset + 4);
        const discovered = (await Promise.all(batch.map(async (peerId) => {
          if (await ports.probeProtocol!(peerId, ports.protocol) !== 'supported') return null;
          if (!corePeerIds.has(peerId)) {
            if (ports.protocol !== PROTOCOL_STORAGE_ACK &&
                await ports.probeProtocol!(peerId, PROTOCOL_STORAGE_ACK) !== 'supported') return null;
            this.markNegotiated(peerId, PROTOCOL_STORAGE_ACK);
            corePeerIds.add(peerId);
          }
          this.markNegotiated(peerId, ports.protocol);
          protocolPeerIds.add(peerId);
          if (ports.protocol === PROTOCOL_STORAGE_ACK_V2 || ports.protocol === PROTOCOL_STORAGE_UPDATE_ACK_V2) {
            corePeerIdsV2.add(peerId);
          }
          return peerId;
        }))).filter((peerId): peerId is string => peerId !== null);
        this.preferredProbeCursor += batch.filter((peerId) => preferredIds.has(peerId)).length;
        this.otherProbeCursor += batch.filter((peerId) => !preferredIds.has(peerId)).length;
        if (discovered.length > 0) await ports.preflight(discovered);
        // Always sample at least one batch, even when advertised peers meet
        // target: advertisements do not prove valid independent ACK signers.
        if (admitted() >= target) break;
      }
    }
    return { knownCorePeerIds: corePeerIds, knownCorePeerIdsV2: corePeerIdsV2 };
  }
}
