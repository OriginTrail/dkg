import type { CanonicalPeerId } from './peer-id.js';

const DEFAULT_MAX_ENTRIES = 10_000;

export interface NetworkAdmissionProbeBackoffOptions {
  transientBaseMs: number;
  transientMaxMs: number;
  unreadableResponseMs: number;
  /** Short ACK-preflight retry lease, independent of automatic backoff. */
  preflightRetryMs: number;
}

export type NetworkAdmissionProbeBackoffKind = 'transient' | 'unreadable-response';

export interface NetworkAdmissionProbeBackoff {
  failures: number;
  kind: NetworkAdmissionProbeBackoffKind;
  reason: string;
  retryAfterMs: number;
}

interface PeerProbeRetryState {
  history: {
    consecutiveFailures: number;
  };
  suppression?: {
    kind: NetworkAdmissionProbeBackoffKind;
    reason: string;
    untilMs: number;
    /** Do not let concurrent ACK rounds repeat the same bypass probe. */
    preflightRetryAfterMs?: number;
  };
}

interface NetworkAdmissionProbeRetryStateOptions {
  now: () => number;
  backoff?: Partial<NetworkAdmissionProbeBackoffOptions>;
  maxEntries?: number;
}

/**
 * Bounded retry history and active suppression for canonical peer IDs.
 *
 * Suppression expiry does not reset failure history: a peer that repeatedly
 * fails after each retry window continues through the exponential schedule.
 * Capacity pressure may discard inactive history before evicting active state.
 */
export class NetworkAdmissionProbeRetryState {
  private readonly now: () => number;
  private readonly backoff: NetworkAdmissionProbeBackoffOptions;
  private readonly maxEntries: number;
  // Map insertion order is the least-recently-updated eviction order.
  private readonly peers = new Map<CanonicalPeerId, PeerProbeRetryState>();

  constructor(options: NetworkAdmissionProbeRetryStateOptions) {
    this.now = options.now;
    this.backoff = {
      transientBaseMs: options.backoff?.transientBaseMs ?? 15_000,
      transientMaxMs: options.backoff?.transientMaxMs ?? 120_000,
      unreadableResponseMs: options.backoff?.unreadableResponseMs ?? 60_000,
      preflightRetryMs: options.backoff?.preflightRetryMs ?? 3_000,
    };
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error('maxProbeBackoffEntries must be a positive integer');
    }
  }

  /** Return active suppression, consuming only its expired window while retaining history. */
  getActiveSuppression(peerId: CanonicalPeerId): NetworkAdmissionProbeBackoff | undefined {
    const entry = this.peers.get(peerId);
    const suppression = entry?.suppression;
    if (!entry || !suppression) return undefined;

    const now = this.now();
    if (suppression.untilMs <= now) {
      delete entry.suppression;
      return undefined;
    }
    return {
      failures: entry.history.consecutiveFailures,
      kind: suppression.kind,
      reason: suppression.reason,
      retryAfterMs: Math.max(0, suppression.untilMs - now),
    };
  }

  recordFailure(
    peerId: CanonicalPeerId,
    reason: string,
    kind: NetworkAdmissionProbeBackoffKind,
  ): void {
    const previous = this.peers.get(peerId);
    const consecutiveFailures = (previous?.history.consecutiveFailures ?? 0) + 1;
    const delayMs = this.backoffDelayMs(consecutiveFailures, kind);

    if (previous) {
      this.peers.delete(peerId);
    } else {
      this.makeRoom();
    }
    this.peers.set(peerId, {
      history: { consecutiveFailures },
      suppression: {
        kind,
        reason,
        untilMs: this.now() + delayMs,
      },
    });
  }

  /**
   * Claim a short ACK-preflight retry lease within the active automatic
   * suppression window. This prevents concurrent probe storms without making
   * ACK recovery wait for the much longer 15-120s automatic backoff.
   */
  claimPreflightProbe(peerId: CanonicalPeerId): boolean {
    const entry = this.peers.get(peerId);
    if (!entry?.suppression || !this.getActiveSuppression(peerId)) return true;
    const now = this.now();
    if ((entry.suppression.preflightRetryAfterMs ?? 0) > now) return false;
    entry.suppression.preflightRetryAfterMs = now + this.backoff.preflightRetryMs;
    return true;
  }

  /** Start the short retry lease on a failure window created by ACK preflight. */
  markPreflightProbeAttempted(peerId: CanonicalPeerId): void {
    const entry = this.peers.get(peerId);
    if (!entry?.suppression || !this.getActiveSuppression(peerId)) return;
    entry.suppression.preflightRetryAfterMs = this.now() + this.backoff.preflightRetryMs;
  }

  clear(peerId: CanonicalPeerId): void {
    this.peers.delete(peerId);
  }

  private makeRoom(): void {
    if (this.peers.size < this.maxEntries) return;

    const now = this.now();
    for (const [peerId, entry] of this.peers) {
      if (!entry.suppression || entry.suppression.untilMs <= now) {
        this.peers.delete(peerId);
      }
    }
    if (this.peers.size < this.maxEntries) return;

    const oldest = this.peers.keys().next();
    if (!oldest.done) this.peers.delete(oldest.value);
  }

  private backoffDelayMs(failures: number, kind: NetworkAdmissionProbeBackoffKind): number {
    if (kind === 'unreadable-response') return this.backoff.unreadableResponseMs;

    const exponent = Math.min(Math.max(failures - 1, 0), 8);
    return Math.min(
      this.backoff.transientMaxMs,
      this.backoff.transientBaseMs * (2 ** exponent),
    );
  }
}
