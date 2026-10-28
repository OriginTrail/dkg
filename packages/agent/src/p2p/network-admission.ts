import { canonicalPeerIdString, tryCanonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';
import {
  NetworkAdmissionProbeRetryState,
  type NetworkAdmissionProbeBackoff,
  type NetworkAdmissionProbeBackoffKind,
  type NetworkAdmissionProbeBackoffOptions,
} from './network-admission-probe-retry.js';

export type {
  NetworkAdmissionProbeBackoff,
  NetworkAdmissionProbeBackoffKind,
  NetworkAdmissionProbeBackoffOptions,
};

export type NetworkAdmissionVerdict = 'same-network' | 'cache-only' | 'rejected';

type VerifiedAdmission = { kind: 'same-network' } | { kind: 'cache-only'; untilMs: number };

type NetworkAdmissionQuarantineEntry =
  | { kind: 'indefinite' }
  | { kind: 'cooldown'; untilMs: number };

export interface NetworkAdmissionOptions {
  networkId?: string;
  selfPeerId?: string;
  now?: () => number;
  probeBackoff?: Partial<NetworkAdmissionProbeBackoffOptions>;
  maxProbeBackoffEntries?: number;
  quarantineCooldownMs?: number;
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
 * owns the complete admission state (verified, quarantined, and retry-later)
 * behind one canonical peer-id and clock boundary. Unknown peers fail closed
 * when a network identity is active; disabled legacy/in-process use stays
 * allow-all.
 */
export class NetworkAdmissionService {
  private readonly networkId?: string;
  private readonly selfPeerId?: CanonicalPeerId;
  private readonly now: () => number;
  private readonly probeRetry: NetworkAdmissionProbeRetryState;
  private readonly quarantineCooldownMs: number;
  private readonly verifiedPeers = new Map<CanonicalPeerId, VerifiedAdmission>();
  private readonly quarantinedPeers = new Map<CanonicalPeerId, NetworkAdmissionQuarantineEntry>();

  constructor(options: NetworkAdmissionOptions = {}) {
    this.networkId = options.networkId;
    this.selfPeerId = options.networkId && options.selfPeerId
      ? canonicalAdmissionServicePeerId(options.selfPeerId)
      : undefined;
    this.now = options.now ?? Date.now;
    this.probeRetry = new NetworkAdmissionProbeRetryState({
      now: this.now,
      ...(options.probeBackoff !== undefined ? { backoff: options.probeBackoff } : {}),
      ...(options.maxProbeBackoffEntries !== undefined
        ? { maxEntries: options.maxProbeBackoffEntries }
        : {}),
    });
    this.quarantineCooldownMs = options.quarantineCooldownMs ?? 300_000;
  }

  get enabled(): boolean {
    return Boolean(this.networkId);
  }

  markVerifiedSameNetwork(peerId: string): void {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    this.verifiedPeers.set(canonicalPeerId, { kind: 'same-network' });
    this.quarantinedPeers.delete(canonicalPeerId);
    this.probeRetry.clear(canonicalPeerId);
  }

  /** Preserve the existing public operation as an explicit indefinite quarantine. */
  quarantinePeer(peerId: string): void {
    this.setQuarantine(peerId, { kind: 'indefinite' });
  }

  /**
   * Apply the coordinator's bounded recovery cooldown using this service's
   * clock. Returns the cooldown applied (ms), so transport-level refusal of the
   * peer can mirror it exactly instead of keeping its own copy of the value.
   */
  quarantinePeerForCooldown(peerId: string): number {
    this.setQuarantine(peerId, {
      kind: 'cooldown',
      untilMs: this.now() + this.quarantineCooldownMs,
    });
    return this.quarantineCooldownMs;
  }

  getRetryableProbeBackoff(peerId: string): NetworkAdmissionProbeBackoff | undefined {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    return this.probeRetry.getActiveSuppression(canonicalPeerId);
  }

  rememberRetryableProbeFailure(
    peerId: string,
    reason: string,
    kind: NetworkAdmissionProbeBackoffKind,
    maxDelayMs?: number,
  ): void {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    this.probeRetry.recordFailure(canonicalPeerId, reason, kind, maxDelayMs);
  }

  /** Claim the short ACK-preflight lease owned by the active retry window. */
  claimRetryablePreflightProbe(peerId: string): boolean {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    return this.probeRetry.claimPreflightProbe(canonicalPeerId);
  }

  /** Briefly suppress another ACK-preflight probe after a failed attempt. */
  markRetryablePreflightProbeAttempted(peerId: string): void {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    this.probeRetry.markPreflightProbeAttempted(canonicalPeerId);
  }

  markVerifiedCacheOnly(peerId: string): void {
    const canonical = canonicalAdmissionServicePeerId(peerId);
    const cached = [...this.verifiedPeers].filter(([, value]) => value.kind === 'cache-only');
    if (cached.length >= 256) this.verifiedPeers.delete(cached[0][0]);
    this.verifiedPeers.set(canonical, { kind: 'cache-only', untilMs: this.now() + 30_000 });
    this.quarantinedPeers.delete(canonical);
    this.probeRetry.clear(canonical);
  }

  /** One clock and canonical registry own every cached admission verdict. */
  cachedVerdict(peerId: string): NetworkAdmissionVerdict | undefined {
    if (!this.enabled) return 'same-network';
    const canonical = tryCanonicalPeerIdString(peerId);
    if (!canonical) return 'rejected';
    if (this.isQuarantined(canonical)) return 'rejected';
    if (canonical === this.selfPeerId) return 'same-network';
    const entry = this.verifiedPeers.get(canonical);
    if (entry?.kind === 'cache-only' && entry.untilMs <= this.now()) {
      this.verifiedPeers.delete(canonical);
      return undefined;
    }
    return entry?.kind;
  }

  isAcceptedPeer(peerId: string): boolean {
    return this.cachedVerdict(peerId) === 'same-network';
  }

  isRejectedPeer(peerId: string): boolean {
    if (!this.enabled) return false;
    const canonicalPeerId = tryCanonicalPeerIdString(peerId);
    return canonicalPeerId ? this.isQuarantined(canonicalPeerId) : true;
  }

  verifiedSameNetworkPeerIds(): ReadonlySet<string> {
    if (!this.enabled) return new Set();
    return new Set(
      [...this.verifiedPeers.keys()]
        .filter((peerId) => this.cachedVerdict(peerId) === 'same-network'),
    );
  }

  snapshot(): NetworkAdmissionSnapshot {
    return {
      enabled: this.enabled,
      verifiedPeerIds: [...this.verifiedSameNetworkPeerIds()].sort(),
      quarantinedPeerIds: [...this.quarantinedPeers.keys()]
        .filter((peerId) => this.isQuarantined(peerId))
        .sort(),
    };
  }

  private isQuarantined(peerId: CanonicalPeerId): boolean {
    const entry = this.quarantinedPeers.get(peerId);
    if (!entry) return false;
    if (entry.kind === 'indefinite') return true;
    if (entry.untilMs <= this.now()) {
      this.quarantinedPeers.delete(peerId);
      return false;
    }
    return true;
  }

  private setQuarantine(peerId: string, entry: NetworkAdmissionQuarantineEntry): void {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    this.quarantinedPeers.set(canonicalPeerId, entry);
    this.verifiedPeers.delete(canonicalPeerId);
    this.probeRetry.clear(canonicalPeerId);
  }
}

function canonicalAdmissionServicePeerId(peerId: string): CanonicalPeerId {
  try {
    return canonicalPeerIdString(peerId);
  } catch (err) {
    throw new Error(`Invalid peer id ${peerId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
