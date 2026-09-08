import { PeerEventLifetime } from '../p2p/peer-event-lifetime.js';
import type { SyncReconcilerBackoff } from '../dkg-agent-types.js';
import type { Rfc64AuthorizedSwmRecoveryPlanV1 } from '../rfc64/swm-recovery-plan-v1.js';
import { SyncOnConnectPeerScheduler, type SyncOnConnectPeerSchedulerCallbacks } from './on-connect/peer-scheduler.js';

type RecoveryPlan = Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>;

/** One node start owns all transient peer-sync scheduling and accounting. */
export class PeerSyncSession extends PeerEventLifetime {
  readonly syncingPeers = new Set<string>();
  readonly catchupOnConnectAt = new Map<string, number>();
  readonly rfc64ExactCatchupOnConnectAt = new Map<string, number>();
  readonly skippedNoSyncPeers = new Set<string>();
  readonly lastSuccessfulSyncAt = new Map<string, number>();
  readonly lastSyncProgressAt = new Map<string, number>();
  readonly syncReconcilerBackoff = new Map<string, SyncReconcilerBackoff>();
  private scheduler: SyncOnConnectPeerScheduler<RecoveryPlan> | null = null;

  static stopped(): PeerSyncSession {
    const session = new PeerSyncSession();
    session.close();
    return session;
  }

  getScheduler(callbacks: SyncOnConnectPeerSchedulerCallbacks<RecoveryPlan>): SyncOnConnectPeerScheduler<RecoveryPlan> {
    if (this.scheduler === null) {
      this.scheduler = new SyncOnConnectPeerScheduler(callbacks);
      if (!this.checkpoint()) this.scheduler.close();
    }
    return this.scheduler;
  }

  clearQueuedPeer(peerId: string): void { this.scheduler?.clear(peerId); }

  override close(): void {
    super.close();
    this.scheduler?.close();
    this.syncingPeers.clear();
    this.catchupOnConnectAt.clear();
    this.rfc64ExactCatchupOnConnectAt.clear();
    this.skippedNoSyncPeers.clear();
    this.lastSuccessfulSyncAt.clear();
    this.lastSyncProgressAt.clear();
    this.syncReconcilerBackoff.clear();
  }
}
