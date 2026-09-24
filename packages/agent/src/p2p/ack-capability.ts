import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';
import { STORAGE_ACK_PROTOCOLS, isStorageACKProtocol, type StorageACKProtocol } from './storage-ack-protocols.js';
export interface ACKCapabilitySnapshot {
  corePeerIds: ReadonlySet<string>;
  supportByProtocol: ReadonlyMap<StorageACKProtocol, ReadonlySet<string>>;
}

interface PeerCapabilityEvidence {
  advertised: Set<StorageACKProtocol>;
  negotiated: Set<StorageACKProtocol>;
}

function supportsProtocol(record: PeerCapabilityEvidence, protocol: StorageACKProtocol): boolean {
  if (protocol !== PROTOCOL_STORAGE_ACK &&
      !record.advertised.has(PROTOCOL_STORAGE_ACK) &&
      !record.negotiated.has(PROTOCOL_STORAGE_ACK)) return false;
  return record.advertised.has(protocol) || record.negotiated.has(protocol);
}

function snapshotEvidence(peers: ReadonlyMap<string, PeerCapabilityEvidence>): ACKCapabilitySnapshot {
  const supporters = (protocol: StorageACKProtocol): ReadonlySet<string> =>
    new Set(new CapabilityPeerView(peers, protocol));
  const corePeerIds = supporters(PROTOCOL_STORAGE_ACK);
  return {
    corePeerIds,
    supportByProtocol: new Map(STORAGE_ACK_PROTOCOLS.map(([protocol]) => [
      protocol, protocol === PROTOCOL_STORAGE_ACK ? corePeerIds : supporters(protocol),
    ])),
  };
}

/** Stable read-only view: membership is a map lookup; iteration is explicit. */
class CapabilityPeerView implements ReadonlySet<string> {
  constructor(
    private readonly records: ReadonlyMap<string, PeerCapabilityEvidence>,
    private readonly protocol: StorageACKProtocol,
  ) {}

  has(peerId: string): boolean {
    const record = this.records.get(peerId);
    return record !== undefined && supportsProtocol(record, this.protocol);
  }

  get size(): number {
    let count = 0;
    for (const record of this.records.values()) if (supportsProtocol(record, this.protocol)) count++;
    return count;
  }

  *values(): SetIterator<string> {
    for (const [peerId, record] of this.records) if (supportsProtocol(record, this.protocol)) yield peerId;
  }

  keys(): SetIterator<string> { return this.values(); }

  *entries(): SetIterator<[string, string]> {
    for (const peerId of this.values()) yield [peerId, peerId];
  }

  forEach(callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    for (const peerId of this.values()) callback.call(thisArg, peerId, peerId, this);
  }

  [Symbol.iterator](): SetIterator<string> { return this.values(); }
  get [Symbol.toStringTag](): string { return 'Set'; }
}

/** Isolated evidence for one ACK round; observations also commit to the registry. */
export class ACKCapabilityRound {
  private readonly peers: Map<string, PeerCapabilityEvidence>;

  constructor(private readonly registry: ACKCapabilityRegistry, source: ReadonlyMap<string, PeerCapabilityEvidence>) {
    this.peers = new Map([...source].map(([peerId, evidence]) => [peerId, {
      advertised: new Set(evidence.advertised),
      negotiated: new Set(evidence.negotiated),
    }]));
  }

  supports(peerId: string, protocol: StorageACKProtocol): boolean {
    const evidence = this.peers.get(peerId);
    return evidence !== undefined && supportsProtocol(evidence, protocol);
  }

  observeNegotiated(peerId: string, protocol: StorageACKProtocol): void {
    let evidence = this.peers.get(peerId);
    if (!evidence) {
      evidence = { advertised: new Set(), negotiated: new Set() };
      this.peers.set(peerId, evidence);
    }
    evidence.negotiated.add(protocol);
    this.registry.observeNegotiated(peerId, protocol);
  }

  snapshot(): ACKCapabilitySnapshot { return snapshotEvidence(this.peers); }
}

/** Owns peer capability evidence; round discovery lives in the coordinator. */
export class ACKCapabilityRegistry {
  private readonly peers = new Map<string, PeerCapabilityEvidence>();
  readonly knownCorePeerIds: ReadonlySet<string> = new CapabilityPeerView(this.peers, PROTOCOL_STORAGE_ACK);
  readonly knownCorePeerIdsV2: ReadonlySet<string> = new CapabilityPeerView(this.peers, PROTOCOL_STORAGE_ACK_V2);

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
  observeIdentify(peerId: string, protocols: readonly string[]): void {
    if (protocols.length === 0) return;
    this.record(peerId).advertised = new Set(protocols.filter(isStorageACKProtocol));
  }

  forget(peerId: string): void {
    this.peers.delete(peerId);
  }

  observeNegotiated(peerId: string, protocol: StorageACKProtocol): void {
    this.record(peerId).negotiated.add(protocol);
  }

  hasCoreCapability(peerId: string): boolean { return this.knownCorePeerIds.has(peerId); }
  snapshotCorePeerIds(): ReadonlySet<string> { return new Set(this.knownCorePeerIds); }
  beginRound(): ACKCapabilityRound { return new ACKCapabilityRound(this, this.peers); }

  snapshot(): ACKCapabilitySnapshot {
    return snapshotEvidence(this.peers);
  }

}
