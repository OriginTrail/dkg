export type NetworkAdmissionDirection = 'inbound' | 'outbound' | 'gossip';

export interface NetworkAdmissionOptions {
  networkId?: string;
  selfPeerId?: string;
  trustedPeerIds?: Iterable<string>;
}

export interface NetworkAdmissionSnapshot {
  enabled: boolean;
  trustedPeerIds: string[];
  verifiedPeerIds: string[];
  quarantinedPeerIds: string[];
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
  private readonly selfPeerId?: string;
  private readonly trustedPeerIds = new Set<string>();
  private readonly verifiedPeerIds = new Set<string>();
  private readonly quarantinedPeerIds = new Set<string>();

  constructor(options: NetworkAdmissionOptions = {}) {
    this.networkId = options.networkId;
    this.selfPeerId = options.selfPeerId;
    for (const peerId of options.trustedPeerIds ?? []) {
      this.trustPeer(peerId);
    }
  }

  get enabled(): boolean {
    return Boolean(this.networkId);
  }

  trustPeer(peerId: string): void {
    const normalized = normalizePeerId(peerId);
    if (!normalized) return;
    this.trustedPeerIds.add(normalized);
  }

  markVerifiedSameNetwork(peerId: string): void {
    const normalized = normalizePeerId(peerId);
    if (!normalized) return;
    this.verifiedPeerIds.add(normalized);
    this.quarantinedPeerIds.delete(normalized);
  }

  quarantinePeer(peerId: string): void {
    const normalized = normalizePeerId(peerId);
    if (!normalized) return;
    this.quarantinedPeerIds.add(normalized);
    this.verifiedPeerIds.delete(normalized);
  }

  isPeerAccepted(
    peerId: string,
    _protocolOrTopic: string,
    _direction: NetworkAdmissionDirection,
  ): boolean {
    if (!this.enabled) return true;
    const normalized = normalizePeerId(peerId);
    if (!normalized) return false;
    if (normalized === this.selfPeerId) return true;
    if (this.quarantinedPeerIds.has(normalized)) return false;
    return this.verifiedPeerIds.has(normalized);
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
      trustedPeerIds: [...this.trustedPeerIds].sort(),
      verifiedPeerIds: [...this.verifiedPeerIds].sort(),
      quarantinedPeerIds: [...this.quarantinedPeerIds].sort(),
    };
  }
}

function normalizePeerId(peerId: string): string | null {
  const normalized = peerId.trim();
  return normalized.length > 0 ? normalized : null;
}
