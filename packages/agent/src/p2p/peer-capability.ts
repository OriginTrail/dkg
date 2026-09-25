import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';

/** Provenance decides whether a populated protocol list can revoke a live probe. */
export type PeerCapabilityObservation =
  | { readonly source: 'identify-snapshot'; readonly protocols: readonly string[] }
  | { readonly source: 'peer-update'; readonly protocols: readonly string[] }
  | { readonly source: 'negotiation'; readonly protocol: string };

interface PeerCapabilityEvidence {
  identified: Set<string>;
  updated: Set<string> | null;
  negotiated: Set<string>;
}

function supports(record: PeerCapabilityEvidence, protocol: string): boolean {
  return (record.updated ?? record.identified).has(protocol) || record.negotiated.has(protocol);
}

function applyObservation(record: PeerCapabilityEvidence, observation: PeerCapabilityObservation): void {
  if (observation.source === 'negotiation') {
    record.negotiated.add(observation.protocol);
    return;
  }
  // An empty identify or peer:update contains no authoritative protocol list.
  if (observation.protocols.length === 0) return;
  if (observation.source === 'peer-update') {
    // A live event is authoritative until disconnect or another event.
    record.updated = new Set(observation.protocols);
    record.negotiated.clear();
  } else {
    // A cached identify snapshot cannot undo a newer live update or probe.
    record.identified = new Set(observation.protocols);
  }
}

function protocolPeers(peers: ReadonlyMap<string, PeerCapabilityEvidence>, protocol: string): ReadonlySet<string> {
  const result = new Set<string>();
  for (const [peerId, record] of peers) {
    if (supports(record, protocol)) result.add(peerId);
  }
  return result;
}

/** A stable copy of evidence for one operation; live probes also update the owner. */
export class PeerCapabilityRound {
  private readonly peers: Map<string, PeerCapabilityEvidence>;

  constructor(private readonly registry: PeerCapabilityRegistry, source: ReadonlyMap<string, PeerCapabilityEvidence>) {
    this.peers = new Map([...source].map(([peerId, record]) => [peerId, {
      identified: new Set(record.identified),
      updated: record.updated ? new Set(record.updated) : null,
      negotiated: new Set(record.negotiated),
    }]));
  }

  supports(peerId: string, protocol: string): boolean {
    const record = this.peers.get(peerId);
    return record !== undefined && supports(record, protocol);
  }

  observe(peerId: string, observation: Extract<PeerCapabilityObservation, { source: 'negotiation' }>): void {
    let record = this.peers.get(peerId);
    if (!record) {
      record = { identified: new Set(), updated: null, negotiated: new Set() };
      this.peers.set(peerId, record);
    }
    applyObservation(record, observation);
    this.registry.observe(peerId, observation);
  }

  snapshotCorePeerIds(): ReadonlySet<string> { return this.snapshotProtocolPeers(PROTOCOL_STORAGE_ACK); }
  snapshotProtocolPeers(protocol: string): ReadonlySet<string> { return protocolPeers(this.peers, protocol); }
}

/** One canonical owner of advertised and negotiated P2P protocol evidence. */
export class PeerCapabilityRegistry {
  private readonly peers = new Map<string, PeerCapabilityEvidence>();

  observe(peerId: string, observation: PeerCapabilityObservation): void {
    if (observation.source !== 'negotiation' && observation.protocols.length === 0) return;
    let record = this.peers.get(peerId);
    if (!record) {
      record = { identified: new Set(), updated: null, negotiated: new Set() };
      this.peers.set(peerId, record);
    }
    applyObservation(record, observation);
  }

  forget(peerId: string): void { this.peers.delete(peerId); }

  supports(peerId: string, protocol: string): boolean {
    const record = this.peers.get(peerId);
    return record !== undefined && supports(record, protocol);
  }

  supportsCore(peerId: string): boolean { return this.supports(peerId, PROTOCOL_STORAGE_ACK); }
  snapshotCorePeerIds(): ReadonlySet<string> { return this.snapshotProtocolPeers(PROTOCOL_STORAGE_ACK); }
  snapshotProtocolPeers(protocol: string): ReadonlySet<string> { return protocolPeers(this.peers, protocol); }
  beginRound(): PeerCapabilityRound { return new PeerCapabilityRound(this, this.peers); }
}
