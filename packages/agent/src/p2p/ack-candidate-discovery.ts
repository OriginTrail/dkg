import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { isStorageACKProtocol } from './storage-ack-protocols.js';
import { ACKCapabilityRegistry, type ACKCapabilitySnapshot } from './ack-capability.js';
import {
  selectACKCandidateUniverse,
  selectACKCandidatePeersWithDiagnostics,
  type ACKCandidatePeerSelectionInput,
  type ACKCandidatePeerSelectionResult,
} from '@origintrail-official/dkg-publisher';

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

/** Bounded ACK discovery and final candidate planning for publish rounds. */
export class ACKCandidateDiscoveryCoordinator {
  private preferredProbeCursor = 0;
  private otherProbeCursor = 0;

  constructor(private readonly registry: ACKCapabilityRegistry) {}

  selectCandidates(
    input: Omit<ACKCandidatePeerSelectionInput, 'capability' | 'selfPeerId' | 'localCandidate'>,
    localCandidate: LocalACKCandidate,
    snapshot: ACKCapabilitySnapshot = this.registry.snapshot(),
  ): ACKCandidatePeerSelectionResult {
    const requestedProtocolPeers = input.protocol && input.protocol !== PROTOCOL_STORAGE_ACK && isStorageACKProtocol(input.protocol)
      ? snapshot.supportByProtocol.get(input.protocol)
      : undefined;
    return selectACKCandidatePeersWithDiagnostics({
      ...input,
      localCandidate,
      capability: { mode: 'require', corePeers: snapshot.corePeerIds, requestedProtocolPeers },
    });
  }

  async resolveRound(ports: ACKRoundPorts): Promise<ACKCandidatePeerSelectionResult> {
    if (!isStorageACKProtocol(ports.protocol)) throw new Error(`Unsupported ACK protocol: ${ports.protocol}`);
    const requestedProtocol = ports.protocol;
    await Promise.all(ports.connectedPeers.map(async (peerId) => {
      this.registry.observeIdentify(peerId, await ports.getPeerProtocols(peerId));
    }));
    // Keep preflight and final selection on this round's snapshot even if
    // peer:update changes the registry while the round is in progress.
    const round = this.registry.beginRound();
    const base = {
      connectedPeers: ports.connectedPeers,
      ackCandidatePeerIds: ports.ackCandidatePeerIds,
      selfPeerId: ports.localCandidate.peerId,
      capability: { mode: 'require' as const, corePeers: round.snapshot().corePeerIds },
    };
    await ports.preflight(selectACKCandidateUniverse(base));

    // One spare beyond bare quorum lets the collector survive one candidate
    // decline or timeout without another discovery round.
    const target = ports.requiredACKs + 1;
    const admitted = (): number => selectACKCandidateUniverse({
      connectedPeers: ports.connectedPeers,
      ackCandidatePeerIds: ports.ackCandidatePeerIds,
      selfPeerId: ports.localCandidate.peerId,
    })
      .filter((peerId) => round.supports(peerId, requestedProtocol) && ports.isAcceptedPeer(peerId)).length +
      Number(ports.localCandidate.available);
    if (ports.probeProtocol) {
      const unconfirmed = selectACKCandidateUniverse({
        connectedPeers: ports.connectedPeers,
        ackCandidatePeerIds: ports.ackCandidatePeerIds,
        selfPeerId: ports.localCandidate.peerId,
      }).filter((peerId) => !round.supports(peerId, requestedProtocol));
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
        // ACK preflight may bypass an automatic admission retry cooldown.
        // Without it, the router gate rejects an unknown peer before the
        // capability negotiation can discover a late StorageACK handler.
        await ports.preflight(batch);
        const discovered = (await Promise.all(batch.map(async (peerId) => {
          if (await ports.probeProtocol!(peerId, requestedProtocol) !== 'supported') return null;
          if (!round.supports(peerId, PROTOCOL_STORAGE_ACK)) {
            if (requestedProtocol !== PROTOCOL_STORAGE_ACK &&
                await ports.probeProtocol!(peerId, PROTOCOL_STORAGE_ACK) !== 'supported') return null;
            round.observeNegotiated(peerId, PROTOCOL_STORAGE_ACK);
          }
          round.observeNegotiated(peerId, requestedProtocol);
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
    }, ports.localCandidate, round.snapshot());
  }
}
