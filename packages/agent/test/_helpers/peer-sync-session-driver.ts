import type { SyncReconcilerBackoff } from '../../src/dkg-agent-types.js';
import type { PeerSyncSession } from '../../src/sync/peer-sync-session.js';

/**
 * Behavior-only test driver for PeerSyncSession. Tests seed and inspect the
 * stable session contract instead of reconstructing its private storage.
 */
export class PeerSyncSessionTestDriver {
  constructor(private readonly readSession: () => PeerSyncSession) {}

  isActive(): boolean {
    return this.readSession().checkpoint();
  }

  markSkipped(peerId: string): void {
    this.readSession().markSkippedNoSync(peerId);
  }

  forgetSkipped(peerId: string): void {
    this.readSession().forgetSkippedNoSync(peerId);
  }

  isSkipped(peerId: string): boolean {
    return this.readSession().isSkippedNoSync(peerId);
  }

  recordQueued(peerId: string, now: number, exact = false): void {
    this.readSession().recordQueued(peerId, now, exact);
  }

  recordExactQueued(peerId: string, now: number): void {
    this.readSession().recordExactQueued(peerId, now);
  }

  beginSync(peerId: string): void {
    this.readSession().syncingPeerRegistry().add(peerId);
  }

  endSync(peerId: string): void {
    this.readSession().syncingPeerRegistry().delete(peerId);
  }

  recordBackoff(peerId: string, backoff: SyncReconcilerBackoff): void {
    this.readSession().recordBackoff(peerId, backoff);
  }

  clearBackoff(peerId: string): void {
    this.readSession().clearBackoff(peerId);
  }

  expireBackoff(peerId: string, now = Date.now()): void {
    const backoff = this.readSession().backoffFor(peerId);
    if (backoff !== undefined) {
      this.readSession().recordBackoff(peerId, {
        ...backoff,
        nextRetryAt: now - 1,
      });
    }
  }

  clearPeer(peerId: string): void {
    this.readSession().clearPeer(peerId);
  }

  recordFreshness(peerId: string, input: Readonly<{
    successfulAt?: number;
    progressAt?: number;
  }>): void {
    if (input.successfulAt !== undefined) {
      this.readSession().applyAccounting(peerId, {
        reconcilerDisposition: 'clear',
        fresh: true,
        progress: true,
      }, input.successfulAt);
    }
    if (
      input.progressAt !== undefined
      && input.progressAt !== input.successfulAt
    ) {
      this.readSession().applyAccounting(peerId, {
        reconcilerDisposition: 'defer',
        fresh: false,
        progress: true,
      }, input.progressAt);
    }
  }

  snapshot(peerId: string): Readonly<{
    syncing: boolean;
    skippedNoSync: boolean;
    lastQueued: number;
    lastExactQueued: number;
    lastSuccessfulSync?: number;
    lastSyncProgress?: number;
    backoff?: SyncReconcilerBackoff;
  }> {
    const session = this.readSession();
    const admission = session.admissionState(peerId);
    const freshness = session.peerFreshness(peerId);
    return {
      syncing: session.isSyncing(peerId),
      skippedNoSync: session.isSkippedNoSync(peerId),
      lastQueued: admission.lastQueued,
      lastExactQueued: admission.lastExactQueued,
      lastSuccessfulSync: freshness.lastSuccessfulSync,
      lastSyncProgress: freshness.lastSyncProgress,
      backoff: admission.backoff,
    };
  }
}
