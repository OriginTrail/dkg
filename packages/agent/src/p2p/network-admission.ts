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

export class NetworkAdmissionInvalidPeerIdError extends Error {
  readonly code = 'INVALID_PEER_ID';

  constructor(peerId: string, reason: string) {
    super(`Invalid peer id ${peerId}: ${reason}`);
    this.name = 'NetworkAdmissionInvalidPeerIdError';
  }
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
    this.selfPeerId = options.networkId && options.selfPeerId ? this.canonicalPeerId(options.selfPeerId) : undefined;
  }

  get enabled(): boolean {
    return Boolean(this.networkId);
  }

  canonicalPeerId(peerId: string): CanonicalPeerId {
    try {
      return canonicalPeerIdString(peerId);
    } catch (err) {
      throw new NetworkAdmissionInvalidPeerIdError(peerId, err instanceof Error ? err.message : String(err));
    }
  }

  tryCanonicalPeerId(peerId: string): CanonicalPeerId | undefined {
    return tryCanonicalPeerIdString(peerId) ?? undefined;
  }

  markVerifiedSameNetwork(peerId: string): void {
    const canonicalPeerId = this.canonicalPeerId(peerId);
    this.verifiedPeerIds.add(canonicalPeerId);
    this.quarantinedPeerIds.delete(canonicalPeerId);
  }

  quarantinePeer(peerId: string): void {
    const canonicalPeerId = this.canonicalPeerId(peerId);
    this.quarantinedPeerIds.add(canonicalPeerId);
    this.verifiedPeerIds.delete(canonicalPeerId);
  }

  isAcceptedPeer(peerId: string): boolean {
    if (!this.enabled) return true;
    const canonicalPeerId = this.tryCanonicalPeerId(peerId);
    if (!canonicalPeerId) return false;
    if (canonicalPeerId === this.selfPeerId) return true;
    if (this.quarantinedPeerIds.has(canonicalPeerId)) return false;
    return this.verifiedPeerIds.has(canonicalPeerId);
  }

  isRejectedPeer(peerId: string): boolean {
    if (!this.enabled) return false;
    const canonicalPeerId = this.tryCanonicalPeerId(peerId);
    return canonicalPeerId ? this.quarantinedPeerIds.has(canonicalPeerId) : true;
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
