import { canonicalPeerIdString, tryCanonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';

export interface NetworkAdmissionOptions {
  networkId?: string;
  selfPeerId?: string;
}

export interface NetworkAdmissionSnapshot {
  enabled: boolean;
  verifiedPeerIds: string[];
  quarantinedPeerIds: string[];
}

export interface CanonicalMultiaddrPeerTarget {
  raw: string;
  canonical: CanonicalPeerId;
}

export function peerIdsFromMultiaddr(addr: string): string[] {
  const peerIds: string[] = [];
  const matches = addr.matchAll(/\/p2p\/([^/]+)/g);
  for (const match of matches) {
    const peerId = match[1]?.trim();
    if (peerId) peerIds.push(peerId);
  }
  return peerIds;
}

export function targetPeerIdFromMultiaddr(addr: string): string | undefined {
  return peerIdsFromMultiaddr(addr).at(-1);
}

export function canonicalTargetPeerIdFromMultiaddr(addr: string): CanonicalMultiaddrPeerTarget | undefined {
  const raw = targetPeerIdFromMultiaddr(addr);
  return raw ? { raw, canonical: canonicalPeerIdString(raw) } : undefined;
}

export function peerIdsFromMultiaddrs(addrs: readonly string[] | undefined): Set<string> {
  const peerIds = new Set<string>();
  for (const addr of addrs ?? []) {
    for (const peerId of peerIdsFromMultiaddr(addr)) peerIds.add(peerId);
  }
  return peerIds;
}

/**
 * Process-local admission registry for active-network peers.
 *
 * The core overlay isolation keeps accidental cross-network peers out of the
 * normal DHT/GossipSub path. This registry is the application boundary: it
 * admits only peers promoted by the signed same-network verifier and self.
 * Configured relays/bootstrap peers are retained as transport/probe seeds, but
 * do not become app/ACK eligible until verification succeeds. Unknown peers
 * fail closed when `networkId` is known; legacy/in-process tests without
 * network identity keep the previous allow-all behavior.
 */
export class NetworkAdmissionService {
  private readonly networkId?: string;
  private readonly selfPeerId?: CanonicalPeerId;
  private readonly verifiedPeerIds = new Set<CanonicalPeerId>();
  private readonly quarantinedPeerIds = new Set<CanonicalPeerId>();

  constructor(options: NetworkAdmissionOptions = {}) {
    this.networkId = options.networkId;
    this.selfPeerId = options.selfPeerId ? canonicalPeerIdString(options.selfPeerId) : undefined;
  }

  get enabled(): boolean {
    return Boolean(this.networkId);
  }

  markVerifiedSameNetwork(peerId: string): void {
    const canonicalPeerId = tryCanonicalPeerIdString(peerId);
    if (!canonicalPeerId) return;
    this.markVerifiedSameNetworkCanonical(canonicalPeerId);
  }

  markVerifiedSameNetworkCanonical(peerId: CanonicalPeerId): void {
    this.verifiedPeerIds.add(peerId);
    this.quarantinedPeerIds.delete(peerId);
  }

  quarantinePeer(peerId: string): void {
    const canonicalPeerId = tryCanonicalPeerIdString(peerId);
    if (!canonicalPeerId) return;
    this.quarantinePeerCanonical(canonicalPeerId);
  }

  quarantinePeerCanonical(peerId: CanonicalPeerId): void {
    this.quarantinedPeerIds.add(peerId);
    this.verifiedPeerIds.delete(peerId);
  }

  isAcceptedPeer(peerId: string): boolean {
    if (!this.enabled) return true;
    const canonicalPeerId = tryCanonicalPeerIdString(peerId);
    return canonicalPeerId ? this.isAcceptedPeerCanonical(canonicalPeerId) : false;
  }

  isAcceptedPeerCanonical(peerId: CanonicalPeerId): boolean {
    if (!this.enabled) return true;
    if (peerId === this.selfPeerId) return true;
    if (this.quarantinedPeerIds.has(peerId)) return false;
    return this.verifiedPeerIds.has(peerId);
  }

  isRejectedPeer(peerId: string): boolean {
    if (!this.enabled) return false;
    const canonicalPeerId = tryCanonicalPeerIdString(peerId);
    return canonicalPeerId ? this.isRejectedPeerCanonical(canonicalPeerId) : true;
  }

  isRejectedPeerCanonical(peerId: CanonicalPeerId): boolean {
    if (!this.enabled) return false;
    return this.quarantinedPeerIds.has(peerId);
  }

  verifiedSameNetworkPeerIds(): ReadonlySet<string> {
    if (!this.enabled) return new Set();
    return new Set(
      [...this.verifiedPeerIds]
        .filter((peerId) => !this.quarantinedPeerIds.has(peerId)),
    );
  }

  snapshot(): NetworkAdmissionSnapshot {
    return {
      enabled: this.enabled,
      verifiedPeerIds: [...this.verifiedPeerIds].sort(),
      quarantinedPeerIds: [...this.quarantinedPeerIds].sort(),
    };
  }
}
