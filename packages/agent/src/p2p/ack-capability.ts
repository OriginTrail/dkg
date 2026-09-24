import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_STORAGE_UPDATE_ACK_V2 } from '@origintrail-official/dkg-core';
import { isStorageACKProtocol, type StorageACKProtocol } from './storage-ack-protocols.js';
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

export interface LocalACKCandidate {
  peerId: string;
  available: boolean;
}

export interface ACKRoundPorts {
  connectedPeers: readonly string[];
  ackCandidatePeerIds?: readonly string[];
  preferredACKPeerIds?: readonly string[];
  requiredACKs: number;
  protocol: string;
  localCandidate: LocalACKCandidate;
  verifiedSameNetworkPeerIds(): ReadonlySet<string> | undefined;
  getPeerProtocols(peerId: string): Promise<string[]>;
  preflight(peerIds: string[]): Promise<void>;
  isAcceptedPeer(peerId: string): boolean;
  probeProtocol?(peerId: string, protocol: string): Promise<'supported' | 'unsupported' | 'unavailable'>;
}

function rotated<T>(items: readonly T[], cursor: number): T[] {
  if (items.length === 0) return [];
  const offset = cursor % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/** Owns ACK capability state and bounded, fair discovery for a publish round. */
export class ACKCapabilityRegistry {
  private readonly peers = new Map<string, {
    advertised: Set<StorageACKProtocol>;
    negotiated: Set<StorageACKProtocol>;
  }>();
  private preferredProbeCursor = 0;
  private otherProbeCursor = 0;

  get knownCorePeerIds(): ReadonlySet<string> {
    return this.supporters(PROTOCOL_STORAGE_ACK);
  }

  get knownCorePeerIdsV2(): ReadonlySet<string> {
    return this.supporters(PROTOCOL_STORAGE_ACK_V2);
  }

  private record(peerId: string): { advertised: Set<StorageACKProtocol>; negotiated: Set<StorageACKProtocol> } {
    let record = this.peers.get(peerId);
    if (!record) {
      record = { advertised: new Set(), negotiated: new Set() };
      this.peers.set(peerId, record);
    }
    return record;
  }

  /** A populated peer:update supersedes earlier negotiation evidence. */
  reconcile(peerId: string, protocols: readonly string[]): void {
    if (protocols.length === 0) return;
    const record = this.record(peerId);
    record.negotiated.clear();
    record.advertised = new Set(protocols.filter(isStorageACKProtocol));
  }

  /** Identify cache reads can lag a live probe; retain negotiated support. */
  private refresh(peerId: string, protocols: readonly string[]): void {
    if (protocols.length === 0) return;
    this.record(peerId).advertised = new Set(protocols.filter(isStorageACKProtocol));
  }

  forget(peerId: string): void {
    this.peers.delete(peerId);
  }

  private markNegotiated(peerId: string, protocol: StorageACKProtocol): void {
    this.record(peerId).negotiated.add(protocol);
  }

  private supporters(protocol: StorageACKProtocol): Set<string> {
    const peers = new Set<string>();
    for (const [peerId, record] of this.peers) {
      if (protocol !== PROTOCOL_STORAGE_ACK &&
          !record.advertised.has(PROTOCOL_STORAGE_ACK) &&
          !record.negotiated.has(PROTOCOL_STORAGE_ACK)) continue;
      if (record.advertised.has(protocol) || record.negotiated.has(protocol)) peers.add(peerId);
    }
    return peers;
  }

  snapshot(): ACKCapabilitySnapshot {
    return {
      knownCorePeerIds: new Set(this.knownCorePeerIds),
      knownCorePeerIdsV2: new Set(this.knownCorePeerIdsV2),
    };
  }

  selectCandidates(
    input: Omit<ACKCandidatePeerSelectionInput, 'capability' | 'selfPeerId'>,
    localCandidate: LocalACKCandidate,
    snapshot: ACKCapabilitySnapshot = this.snapshot(),
  ): ACKCandidatePeerSelectionResult {
    const remote = selectACKCandidatePeersWithDiagnostics({
      ...input,
      selfPeerId: localCandidate.peerId,
      capability: { mode: 'require', v1: snapshot.knownCorePeerIds, v2: snapshot.knownCorePeerIdsV2 },
    });
    const local = {
      peerId: localCandidate.peerId,
      tier: 'confirmedCore' as const,
      preferred: false,
      allowlisted: true,
      protocolMatch: localCandidate.available,
      selected: localCandidate.available,
      reason: localCandidate.available ? 'selected-local' : 'local-unavailable',
    };
    return {
      peers: localCandidate.available ? [local.peerId, ...remote.peers] : remote.peers,
      diagnostics: [local, ...remote.diagnostics],
    };
  }

  async resolveRound(ports: ACKRoundPorts): Promise<ACKCandidatePeerSelectionResult> {
    if (!isStorageACKProtocol(ports.protocol)) throw new Error(`Unsupported ACK protocol: ${ports.protocol}`);
    const requestedProtocol = ports.protocol;
    await Promise.all(ports.connectedPeers.map(async (peerId) => {
      this.refresh(peerId, await ports.getPeerProtocols(peerId));
    }));
    // Keep preflight and final selection on this round's snapshot even if
    // peer:update changes the registry while the round is in progress.
    const corePeerIds = new Set(this.knownCorePeerIds);
    const protocolPeerIds = requestedProtocol === PROTOCOL_STORAGE_ACK
      ? corePeerIds : this.supporters(requestedProtocol);
    const corePeerIdsV2 = requestedProtocol === PROTOCOL_STORAGE_ACK_V2
      ? new Set(this.knownCorePeerIdsV2)
      : this.supporters(requestedProtocol);
    const base = {
      connectedPeers: ports.connectedPeers,
      ackCandidatePeerIds: ports.ackCandidatePeerIds,
      selfPeerId: ports.localCandidate.peerId,
      capability: { mode: 'require' as const, v1: corePeerIds },
    };
    await ports.preflight(selectACKCandidateUniverse(base));

    // One spare beyond bare quorum lets the collector survive one candidate
    // decline or timeout without another discovery round.
    const target = ports.requiredACKs + 1;
    const admitted = (): number => selectACKCandidateUniverse(base)
      .filter((peerId) => protocolPeerIds.has(peerId) && ports.isAcceptedPeer(peerId)).length +
      Number(ports.localCandidate.available);
    if (ports.probeProtocol) {
      const unconfirmed = selectACKCandidateUniverse({
        connectedPeers: ports.connectedPeers,
        ackCandidatePeerIds: ports.ackCandidatePeerIds,
        selfPeerId: ports.localCandidate.peerId,
      }).filter((peerId) => !protocolPeerIds.has(peerId));
      const preferredIds = new Set(ports.preferredACKPeerIds ?? []);
      const preferred = unconfirmed.filter((peerId) => preferredIds.has(peerId));
      const other = unconfirmed.filter((peerId) => !preferredIds.has(peerId));
      // Reserve a few slots for nonpreferred peers if preferences alone exceed
      // the per-round cap. Both groups rotate so no stable prefix can starve.
      // A non-base probe may need a second negotiation to confirm the core
      // role, so cap it at 16 peers to retain 32 total protocol probes.
      const peerLimit = requestedProtocol === PROTOCOL_STORAGE_ACK ? 32 : 16;
      const preferredBudget = other.length > 0 && preferred.length >= peerLimit
        ? peerLimit - 8 : peerLimit;
      const chosen = [
        ...rotated(preferred, this.preferredProbeCursor).slice(0, preferredBudget),
        ...rotated(other, this.otherProbeCursor).slice(0, peerLimit - Math.min(preferred.length, preferredBudget)),
      ];
      for (let offset = 0; offset < chosen.length; offset += 4) {
        const batch = chosen.slice(offset, offset + 4);
        const discovered = (await Promise.all(batch.map(async (peerId) => {
          if (await ports.probeProtocol!(peerId, requestedProtocol) !== 'supported') return null;
          if (!corePeerIds.has(peerId)) {
            if (requestedProtocol !== PROTOCOL_STORAGE_ACK &&
                await ports.probeProtocol!(peerId, PROTOCOL_STORAGE_ACK) !== 'supported') return null;
            this.markNegotiated(peerId, PROTOCOL_STORAGE_ACK);
            corePeerIds.add(peerId);
          }
          this.markNegotiated(peerId, requestedProtocol);
          protocolPeerIds.add(peerId);
          if (requestedProtocol === PROTOCOL_STORAGE_ACK_V2 || requestedProtocol === PROTOCOL_STORAGE_UPDATE_ACK_V2) {
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
    return this.selectCandidates({
      connectedPeers: ports.connectedPeers,
      ackCandidatePeerIds: ports.ackCandidatePeerIds,
      preferredACKPeerIds: ports.preferredACKPeerIds,
      verifiedSameNetworkPeerIds: ports.verifiedSameNetworkPeerIds(),
      requiredACKs: ports.requiredACKs,
      protocol: requestedProtocol,
    }, ports.localCandidate, {
      knownCorePeerIds: corePeerIds,
      knownCorePeerIdsV2: corePeerIdsV2,
    });
  }
}
