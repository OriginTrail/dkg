import { canonicalPeerIdString, tryCanonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';

export interface NetworkAdmissionOptions {
  selfPeerId?: string;
}

export interface NetworkAdmissionSnapshot {
  verifiedPeerIds: string[];
  quarantinedPeerIds: string[];
}

/**
 * Process-local admission registry for active-network peers.
 *
 * The core overlay isolation keeps accidental cross-network peers out of the
 * normal DHT/GossipSub path. This registry is the application boundary: it
 * admits only canonical peers promoted by the signed same-network verifier and
 * self. Configured relays/bootstrap peers are retained as transport/probe
 * seeds, but do not become app/ACK eligible until verification succeeds.
 */
export class NetworkAdmissionService {
  private readonly selfPeerId?: CanonicalPeerId;
  private readonly verifiedPeerIds = new Set<CanonicalPeerId>();
  private readonly quarantinedPeerIds = new Set<CanonicalPeerId>();

  constructor(options: NetworkAdmissionOptions = {}) {
    this.selfPeerId = options.selfPeerId ? canonicalAdmissionServicePeerId(options.selfPeerId) : undefined;
  }

  markVerifiedSameNetwork(peerId: string): void {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    this.verifiedPeerIds.add(canonicalPeerId);
    this.quarantinedPeerIds.delete(canonicalPeerId);
  }

  quarantinePeer(peerId: string): void {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    this.quarantinedPeerIds.add(canonicalPeerId);
    this.verifiedPeerIds.delete(canonicalPeerId);
  }

  isAcceptedPeer(peerId: string): boolean {
    const canonicalPeerId = tryCanonicalPeerIdString(peerId);
    if (!canonicalPeerId) return false;
    if (canonicalPeerId === this.selfPeerId) return true;
    if (this.quarantinedPeerIds.has(canonicalPeerId)) return false;
    return this.verifiedPeerIds.has(canonicalPeerId);
  }

  isRejectedPeer(peerId: string): boolean {
    const canonicalPeerId = tryCanonicalPeerIdString(peerId);
    return canonicalPeerId ? this.quarantinedPeerIds.has(canonicalPeerId) : true;
  }

  verifiedSameNetworkPeerIds(): ReadonlySet<string> {
    return new Set(
      [...this.verifiedPeerIds]
        .filter((peerId) => !this.quarantinedPeerIds.has(peerId)),
    );
  }

  snapshot(): NetworkAdmissionSnapshot {
    return {
      verifiedPeerIds: [...this.verifiedPeerIds].sort(),
      quarantinedPeerIds: [...this.quarantinedPeerIds].sort(),
    };
  }
}

function canonicalAdmissionServicePeerId(peerId: string): CanonicalPeerId {
  try {
    return canonicalPeerIdString(peerId);
  } catch (err) {
    throw new Error(`Invalid peer id ${peerId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
