import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { STORAGE_ACK_PROTOCOLS, isStorageACKProtocol, type StorageACKProtocol } from './storage-ack-protocols.js';
export interface PeerCapabilitySnapshot {
  corePeerIds: ReadonlySet<string>;
  supportByProtocol: ReadonlyMap<StorageACKProtocol, ReadonlySet<string>>;
}

interface PeerCapabilityEvidence {
  advertised: Set<string>;
  negotiated: Set<string>;
}

function supportsProtocol(record: PeerCapabilityEvidence, protocol: string): boolean {
  if (isStorageACKProtocol(protocol) && protocol !== PROTOCOL_STORAGE_ACK &&
      !record.advertised.has(PROTOCOL_STORAGE_ACK) &&
      !record.negotiated.has(PROTOCOL_STORAGE_ACK)) return false;
  return record.advertised.has(protocol) || record.negotiated.has(protocol);
}

function protocolPeers(peers: ReadonlyMap<string, PeerCapabilityEvidence>, protocol: string): ReadonlySet<string> {
  const result = new Set<string>();
  for (const [peerId, evidence] of peers) if (supportsProtocol(evidence, protocol)) result.add(peerId);
  return result;
}

function snapshotEvidence(peers: ReadonlyMap<string, PeerCapabilityEvidence>): PeerCapabilitySnapshot {
  const corePeerIds = protocolPeers(peers, PROTOCOL_STORAGE_ACK);
  return {
    corePeerIds,
    supportByProtocol: new Map(STORAGE_ACK_PROTOCOLS.map(([protocol]) => [
      protocol, protocol === PROTOCOL_STORAGE_ACK ? corePeerIds : protocolPeers(peers, protocol),
    ])),
  };
}

/** Isolated evidence for one round; observations also commit to the registry. */
export class PeerCapabilityRound {
  private readonly peers: Map<string, PeerCapabilityEvidence>;

  constructor(private readonly registry: PeerCapabilityRegistry, source: ReadonlyMap<string, PeerCapabilityEvidence>) {
    this.peers = new Map([...source].map(([peerId, evidence]) => [peerId, {
      advertised: new Set(evidence.advertised),
      negotiated: new Set(evidence.negotiated),
    }]));
  }

  supports(peerId: string, protocol: string): boolean {
    const evidence = this.peers.get(peerId);
    return evidence !== undefined && supportsProtocol(evidence, protocol);
  }

  observeNegotiated(peerId: string, protocol: string): void {
    let evidence = this.peers.get(peerId);
    if (!evidence) {
      evidence = { advertised: new Set(), negotiated: new Set() };
      this.peers.set(peerId, evidence);
    }
    evidence.negotiated.add(protocol);
    this.registry.observeNegotiated(peerId, protocol);
  }

  snapshot(): PeerCapabilitySnapshot { return snapshotEvidence(this.peers); }
}

/** Shared P2P protocol evidence and derived core role for all agent consumers. */
export class PeerCapabilityRegistry {
  private readonly peers = new Map<string, PeerCapabilityEvidence>();

  private record(peerId: string): PeerCapabilityEvidence {
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
    record.advertised = new Set(protocols);
  }

  /** Identify cache reads can lag a live probe; retain negotiated support. */
  observeIdentify(peerId: string, protocols: readonly string[]): void {
    if (protocols.length === 0) return;
    this.record(peerId).advertised = new Set(protocols);
  }

  forget(peerId: string): void {
    this.peers.delete(peerId);
  }

  observeNegotiated(peerId: string, protocol: string): void {
    this.record(peerId).negotiated.add(protocol);
  }

  supports(peerId: string, protocol: string): boolean {
    const evidence = this.peers.get(peerId);
    return evidence !== undefined && supportsProtocol(evidence, protocol);
  }

  supportsCore(peerId: string): boolean { return this.supports(peerId, PROTOCOL_STORAGE_ACK); }
  hasCoreCapability(peerId: string): boolean { return this.supportsCore(peerId); }
  snapshotCorePeerIds(): ReadonlySet<string> { return protocolPeers(this.peers, PROTOCOL_STORAGE_ACK); }
  snapshotProtocolPeers(protocol: string): ReadonlySet<string> { return protocolPeers(this.peers, protocol); }
  beginRound(): PeerCapabilityRound { return new PeerCapabilityRound(this, this.peers); }

  snapshot(): PeerCapabilitySnapshot {
    return snapshotEvidence(this.peers);
  }

}
