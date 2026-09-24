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

/** Stable read-only view: membership is a map lookup; iteration is explicit. */
class CapabilityPeerView implements ReadonlySet<string> {
  constructor(
    private readonly records: ReadonlyMap<string, PeerCapabilityEvidence>,
    private readonly protocol: StorageACKProtocol,
  ) {}

  private supports(record: PeerCapabilityEvidence): boolean {
    if (this.protocol !== PROTOCOL_STORAGE_ACK &&
        !record.advertised.has(PROTOCOL_STORAGE_ACK) &&
        !record.negotiated.has(PROTOCOL_STORAGE_ACK)) return false;
    return record.advertised.has(this.protocol) || record.negotiated.has(this.protocol);
  }

  has(peerId: string): boolean {
    const record = this.records.get(peerId);
    return record !== undefined && this.supports(record);
  }

  get size(): number {
    let count = 0;
    for (const record of this.records.values()) if (this.supports(record)) count++;
    return count;
  }

  *values(): SetIterator<string> {
    for (const [peerId, record] of this.records) if (this.supports(record)) yield peerId;
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

  private supporters(protocol: StorageACKProtocol): Set<string> {
    return new Set(new CapabilityPeerView(this.peers, protocol));
  }

  hasCoreCapability(peerId: string): boolean { return this.knownCorePeerIds.has(peerId); }
  snapshotCorePeerIds(): ReadonlySet<string> { return new Set(this.knownCorePeerIds); }

  snapshot(): ACKCapabilitySnapshot {
    return {
      corePeerIds: this.snapshotCorePeerIds(),
      supportByProtocol: new Map(STORAGE_ACK_PROTOCOLS.map(([protocol]) => [protocol, this.supporters(protocol)])),
    };
  }

}
