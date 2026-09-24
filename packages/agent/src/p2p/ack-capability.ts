import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';
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
  selfCount: number;
  getPeerProtocols(peerId: string): Promise<string[]>;
  preflight(peerIds: string[]): Promise<void>;
  isAcceptedPeer(peerId: string): boolean;
  probeProtocol?(peerId: string, protocol: string): Promise<boolean>;
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
  private preferredProbeCursor = 0;
  private otherProbeCursor = 0;

  reconcile(peerId: string, protocols: readonly string[]): void {
    reconcileACKCapabilities(peerId, protocols, this.knownCorePeerIds, this.knownCorePeerIdsV2);
  }

  forget(peerId: string): void {
    this.knownCorePeerIds.delete(peerId);
    this.knownCorePeerIdsV2.delete(peerId);
  }

  markNegotiatedCore(peerId: string): void {
    this.knownCorePeerIds.add(peerId);
  }

  snapshot(): ACKCapabilitySnapshot {
    return {
      knownCorePeerIds: new Set(this.knownCorePeerIds),
      knownCorePeerIdsV2: new Set(this.knownCorePeerIdsV2),
    };
  }

  selectCandidates(
    input: Omit<ACKCandidatePeerSelectionInput, 'knownCorePeerIds' | 'knownCorePeerIdsV2' | 'eligiblePeerIds'>,
    snapshot: ACKCapabilitySnapshot = this.snapshot(),
  ): ACKCandidatePeerSelectionResult {
    return selectACKCandidatePeersWithDiagnostics({
      ...input,
      knownCorePeerIds: snapshot.knownCorePeerIds,
      knownCorePeerIdsV2: snapshot.knownCorePeerIdsV2,
      eligiblePeerIds: snapshot.knownCorePeerIds,
    });
  }

  async resolveRound(ports: ACKRoundPorts): Promise<ACKCapabilitySnapshot> {
    await Promise.all(ports.connectedPeers.map(async (peerId) => {
      this.reconcile(peerId, await ports.getPeerProtocols(peerId));
    }));
    // Keep preflight and final selection on this round's snapshot even if
    // peer:update changes the registry while the round is in progress.
    const corePeerIds = new Set(this.knownCorePeerIds);
    const corePeerIdsV2 = new Set(this.knownCorePeerIdsV2);
    const base = {
      connectedPeers: ports.connectedPeers,
      ackCandidatePeerIds: ports.ackCandidatePeerIds,
      selfPeerId: ports.selfPeerId,
      eligiblePeerIds: corePeerIds,
    };
    await ports.preflight(selectACKCandidateUniverse(base));

    // One spare beyond bare quorum lets the collector survive one candidate
    // decline or timeout without another discovery round.
    const target = ports.requiredACKs + 1;
    const admitted = (): number => selectACKCandidateUniverse(base)
      .filter((peerId) => ports.isAcceptedPeer(peerId)).length + ports.selfCount;
    if (ports.probeProtocol && admitted() < target) {
      const unconfirmed = selectACKCandidateUniverse({
        connectedPeers: ports.connectedPeers,
        ackCandidatePeerIds: ports.ackCandidatePeerIds,
        selfPeerId: ports.selfPeerId,
      }).filter((peerId) => !corePeerIds.has(peerId));
      const preferredIds = new Set(ports.preferredACKPeerIds ?? []);
      const preferred = unconfirmed.filter((peerId) => preferredIds.has(peerId));
      const other = unconfirmed.filter((peerId) => !preferredIds.has(peerId));
      // Reserve a few slots for nonpreferred peers if preferences alone exceed
      // the per-round cap. Both groups rotate so no stable prefix can starve.
      const preferredBudget = other.length > 0 && preferred.length >= 32 ? 24 : 32;
      const chosen = [
        ...rotated(preferred, this.preferredProbeCursor).slice(0, preferredBudget),
        ...rotated(other, this.otherProbeCursor).slice(0, 32 - Math.min(preferred.length, preferredBudget)),
      ];
      for (let offset = 0; offset < chosen.length; offset += 4) {
        const batch = chosen.slice(offset, offset + 4);
        const discovered = (await Promise.all(batch.map(async (peerId) => {
          if (!await ports.probeProtocol!(peerId, PROTOCOL_STORAGE_ACK)) return null;
          this.markNegotiatedCore(peerId);
          corePeerIds.add(peerId);
          return peerId;
        }))).filter((peerId): peerId is string => peerId !== null);
        this.preferredProbeCursor += batch.filter((peerId) => preferredIds.has(peerId)).length;
        this.otherProbeCursor += batch.filter((peerId) => !preferredIds.has(peerId)).length;
        if (discovered.length > 0) await ports.preflight(discovered);
        if (admitted() >= target) break;
      }
    }
    return { knownCorePeerIds: corePeerIds, knownCorePeerIdsV2: corePeerIdsV2 };
  }
}
