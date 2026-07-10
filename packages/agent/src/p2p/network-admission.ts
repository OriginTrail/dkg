import { canonicalPeerIdString, tryCanonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';

const DEFAULT_MAX_PROBE_BACKOFF_ENTRIES = 10_000;

export interface NetworkAdmissionProbeBackoffOptions {
  transientBaseMs: number;
  transientMaxMs: number;
  unreadableResponseMs: number;
}

export type NetworkAdmissionProbeBackoffKind = 'transient' | 'unreadable-response';

export interface NetworkAdmissionProbeBackoff {
  failures: number;
  kind: NetworkAdmissionProbeBackoffKind;
  reason: string;
  retryAfterMs: number;
}

interface NetworkAdmissionProbeBackoffEntry {
  failures: number;
  kind: NetworkAdmissionProbeBackoffKind;
  reason: string;
  untilMs: number;
}

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
  private readonly probeBackoff: NetworkAdmissionProbeBackoffOptions;
  private readonly maxProbeBackoffEntries: number;
  private readonly quarantineCooldownMs: number;
  private readonly verifiedPeerIds = new Set<CanonicalPeerId>();
  // `null` preserves the pre-existing indefinite quarantine contract.
  private readonly quarantinedPeers = new Map<CanonicalPeerId, number | null>();
  // Map insertion order is the least-recently-updated eviction order.
  private readonly retryableProbeBackoff = new Map<CanonicalPeerId, NetworkAdmissionProbeBackoffEntry>();

  constructor(options: NetworkAdmissionOptions = {}) {
    this.networkId = options.networkId;
    this.selfPeerId = options.networkId && options.selfPeerId
      ? canonicalAdmissionServicePeerId(options.selfPeerId)
      : undefined;
    this.now = options.now ?? Date.now;
    this.probeBackoff = {
      transientBaseMs: options.probeBackoff?.transientBaseMs ?? 15_000,
      transientMaxMs: options.probeBackoff?.transientMaxMs ?? 120_000,
      unreadableResponseMs: options.probeBackoff?.unreadableResponseMs ?? 60_000,
    };
    this.maxProbeBackoffEntries = options.maxProbeBackoffEntries
      ?? DEFAULT_MAX_PROBE_BACKOFF_ENTRIES;
    if (!Number.isInteger(this.maxProbeBackoffEntries) || this.maxProbeBackoffEntries <= 0) {
      throw new Error('maxProbeBackoffEntries must be a positive integer');
    }
    this.quarantineCooldownMs = options.quarantineCooldownMs ?? 300_000;
  }

  get enabled(): boolean {
    return Boolean(this.networkId);
  }

  markVerifiedSameNetwork(peerId: string): void {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    this.verifiedPeerIds.add(canonicalPeerId);
    this.quarantinedPeers.delete(canonicalPeerId);
    this.retryableProbeBackoff.delete(canonicalPeerId);
  }

  /** Preserve the existing public operation as an explicit indefinite quarantine. */
  quarantinePeer(peerId: string): void {
    this.setQuarantine(peerId, null);
  }

  /** Apply the coordinator's bounded recovery cooldown using this service's clock. */
  quarantinePeerForCooldown(peerId: string): void {
    this.setQuarantine(peerId, this.now() + this.quarantineCooldownMs);
  }

  getRetryableProbeBackoff(peerId: string): NetworkAdmissionProbeBackoff | undefined {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    const entry = this.retryableProbeBackoff.get(canonicalPeerId);
    const now = this.now();
    if (!entry || entry.untilMs <= now) return undefined;
    return {
      failures: entry.failures,
      kind: entry.kind,
      reason: entry.reason,
      retryAfterMs: Math.max(0, entry.untilMs - now),
    };
  }

  rememberRetryableProbeFailure(
    peerId: string,
    reason: string,
    kind: NetworkAdmissionProbeBackoffKind,
  ): void {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    const previous = this.retryableProbeBackoff.get(canonicalPeerId);
    const failures = (previous?.failures ?? 0) + 1;
    const delayMs = this.probeBackoffDelayMs(failures, kind);

    if (previous) {
      // Refresh recency without changing the bounded size.
      this.retryableProbeBackoff.delete(canonicalPeerId);
    } else {
      this.makeRoomForProbeBackoff();
    }
    this.retryableProbeBackoff.set(canonicalPeerId, {
      failures,
      kind,
      reason,
      untilMs: this.now() + delayMs,
    });
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
    if (untilMs === null) return true;
    if (untilMs <= this.now()) {
      this.quarantinedPeers.delete(peerId);
      return false;
    }
    return true;
  }

  private makeRoomForProbeBackoff(): void {
    if (this.retryableProbeBackoff.size < this.maxProbeBackoffEntries) return;

    const now = this.now();
    for (const [peerId, entry] of this.retryableProbeBackoff) {
      if (entry.untilMs <= now) this.retryableProbeBackoff.delete(peerId);
    }
    if (this.retryableProbeBackoff.size < this.maxProbeBackoffEntries) return;

    const oldest = this.retryableProbeBackoff.keys().next();
    if (!oldest.done) this.retryableProbeBackoff.delete(oldest.value);
  }

  private probeBackoffDelayMs(failures: number, kind: NetworkAdmissionProbeBackoffKind): number {
    if (kind === 'unreadable-response') return this.probeBackoff.unreadableResponseMs;

    const exponent = Math.min(Math.max(failures - 1, 0), 8);
    return Math.min(
      this.probeBackoff.transientMaxMs,
      this.probeBackoff.transientBaseMs * (2 ** exponent),
    );
  }

  private setQuarantine(peerId: string, untilMs: number | null): void {
    const canonicalPeerId = canonicalAdmissionServicePeerId(peerId);
    this.quarantinedPeers.set(canonicalPeerId, untilMs);
    this.verifiedPeerIds.delete(canonicalPeerId);
    this.retryableProbeBackoff.delete(canonicalPeerId);
  }
}

function canonicalAdmissionServicePeerId(peerId: string): CanonicalPeerId {
  try {
    return canonicalPeerIdString(peerId);
  } catch (err) {
    throw new Error(`Invalid peer id ${peerId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
