import { canonicalPeerIdString, tryCanonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';

export interface NetworkAdmissionOptions {
  networkId?: string;
  selfPeerId?: string;
  now?: () => number;
}

export interface NetworkAdmissionSnapshot {
  enabled: boolean;
  verifiedPeerIds: string[];
  quarantinedPeerIds: string[];
}

/**
 * Process-local admission registry for active-network peers.
 *
 * The core overlay isolation keeps accidental cross-network peers out of the
 * normal DHT/GossipSub path. This registry is the application boundary: it
 * admits only peers promoted by the signed same-network verifier and self when
 * an active network is configured. Configured relays/bootstrap peers are
 * retained as transport/probe seeds, but do not become app/ACK eligible until
 * verification succeeds. Legacy/in-process tests without network identity keep
 * the previous allow-all behavior.
 */
export class NetworkAdmissionService {
  private readonly networkId?: string;
  private readonly selfPeerId?: CanonicalPeerId;
  private readonly now: () => number;
  private readonly verifiedPeerIds = new Set<CanonicalPeerId>();
  // peerId -> quarantine expiry (ms). A quarantine is a bounded cooldown so a
  // peer can recover after correcting its signed network identity.
  private readonly quarantinedPeers = new Map<CanonicalPeerId, number>();

  constructor(options: NetworkAdmissionOptions = {}) {
    this.networkId = options.networkId;
    this.selfPeerId = options.networkId && options.selfPeerId
      ? canonicalAdmissionServicePeerId(options.selfPeerId)
      : undefined;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return Boolean(this.networkId);
  }

  markVerifiedSameNetwork(peerId: string): void {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    this.verifiedPeerIds.add(canonicalPeerId);
    this.quarantinedPeers.delete(canonicalPeerId);
  }

  /** Quarantine a peer until `untilMs`; omitted deadlines currently use the PR's one-minute default. */
  quarantinePeer(peerId: string, untilMs?: number): void {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    this.quarantinedPeers.set(canonicalPeerId, untilMs ?? this.now() + 60_000);
    this.verifiedPeerIds.delete(canonicalPeerId);
  }

  isAcceptedPeer(peerId: string): boolean {
    if (!this.enabled) return true;
    const canonicalPeerId = tryCanonicalPeerIdString(peerId);
    if (!canonicalPeerId) return false;
    if (canonicalPeerId === this.selfPeerId) return true;
    if (this.isQuarantined(canonicalPeerId)) return false;
    return this.verifiedPeerIds.has(canonicalPeerId);
  }

  isRejectedPeer(peerId: string): boolean {
    if (!this.enabled) return false;
    const canonicalPeerId = tryCanonicalPeerIdString(peerId);
    return canonicalPeerId ? this.isQuarantined(canonicalPeerId) : true;
  }

  verifiedSameNetworkPeerIds(): ReadonlySet<string> {
    if (!this.enabled) return new Set();
    return new Set(
      [...this.verifiedPeerIds]
        .filter((peerId) => !this.isQuarantined(peerId)),
    );
  }

  snapshot(): NetworkAdmissionSnapshot {
    return {
      enabled: this.enabled,
      verifiedPeerIds: [...this.verifiedPeerIds].sort(),
      quarantinedPeerIds: [...this.quarantinedPeers.keys()]
        .filter((peerId) => this.isQuarantined(peerId))
        .sort(),
    };
  }

  private isQuarantined(peerId: CanonicalPeerId): boolean {
    const untilMs = this.quarantinedPeers.get(peerId);
    if (untilMs === undefined) return false;
    if (untilMs <= this.now()) {
      this.quarantinedPeers.delete(peerId);
      return false;
    }
    return true;
  }
}

function canonicalAdmissionServicePeerId(peerId: string): CanonicalPeerId {
  try {
    return canonicalPeerIdString(peerId);
  } catch (err) {
    throw new Error(`Invalid peer id ${peerId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
