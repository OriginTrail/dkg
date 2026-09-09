import { PeerEventLifetime } from '../p2p/peer-event-lifetime.js';
import type { SyncReconcilerBackoff } from '../dkg-agent-types.js';
import type { Rfc64AuthorizedSwmRecoveryPlanV1 } from '../rfc64/swm-recovery-plan-v1.js';
import {
  SyncOnConnectPeerScheduler,
  type SyncOnConnectPeerJobRunner,
  type SyncOnConnectSchedulerInternalStage,
} from './on-connect/peer-scheduler.js';
import type { SyncingPeerRegistry, SyncOnConnectPeerOutcome } from './on-connect/sync-on-connect.js';

type RecoveryPlan = Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>;

export interface PeerSyncSessionCallbacks {
  /** The constructed session is supplied explicitly when the lazy job is created. */
  readonly createJob: (
    remotePeer: string,
    session: PeerSyncSession,
  ) => SyncOnConnectPeerJobRunner<RecoveryPlan>;
  readonly onInternalError: (
    remotePeer: string,
    error: unknown,
    stage: SyncOnConnectSchedulerInternalStage,
    session: PeerSyncSession,
  ) => void | Promise<void>;
}

/** One node start owns all transient peer-sync scheduling and accounting. */
export class PeerSyncSession extends PeerEventLifetime {
  private readonly syncingPeers = new Set<string>();
  private readonly catchupOnConnectAt = new Map<string, number>();
  private readonly rfc64ExactCatchupOnConnectAt = new Map<string, number>();
  private readonly skippedNoSyncPeers = new Set<string>();
  private readonly lastSuccessfulSyncAt = new Map<string, number>();
  private readonly lastSyncProgressAt = new Map<string, number>();
  private readonly syncReconcilerBackoff = new Map<string, SyncReconcilerBackoff>();
  private scheduler: SyncOnConnectPeerScheduler<RecoveryPlan> | null = null;

  constructor(
    private readonly schedulerCallbacks: PeerSyncSessionCallbacks,
  ) { super(); }

  static stopped(): PeerSyncSession {
    const session = new PeerSyncSession({
      createJob: () => { throw new Error('Stopped PeerSyncSession cannot create jobs'); },
      onInternalError: () => undefined,
    });
    session.close();
    return session;
  }

  getScheduler(): SyncOnConnectPeerScheduler<RecoveryPlan> {
    if (this.scheduler === null) {
      this.scheduler = new SyncOnConnectPeerScheduler({
        createJob: (remotePeer) => this.schedulerCallbacks.createJob(remotePeer, this),
        onInternalError: (remotePeer, error, stage) => (
          this.schedulerCallbacks.onInternalError(remotePeer, error, stage, this)
        ),
      });
      if (!this.checkpoint()) this.scheduler.close();
    }
    return this.scheduler;
  }

  clearQueuedPeer(peerId: string): void { this.scheduler?.clear(peerId); }

  syncingPeerRegistry(): SyncingPeerRegistry {
    return {
      has: (peerId) => this.syncingPeers.has(peerId),
      add: (peerId) => this.syncingPeers.add(peerId),
      delete: (peerId) => this.syncingPeers.delete(peerId),
    };
  }

  isSyncing(peerId: string): boolean { return this.syncingPeers.has(peerId); }

  clearExactCatchupCooldown(peerId: string): void {
    this.rfc64ExactCatchupOnConnectAt.delete(peerId);
  }

  markSkippedNoSync(peerId: string): void { this.skippedNoSyncPeers.add(peerId); }
  forgetSkippedNoSync(peerId: string): void { this.skippedNoSyncPeers.delete(peerId); }
  isSkippedNoSync(peerId: string): boolean { return this.skippedNoSyncPeers.has(peerId); }
  consumeSkippedNoSync(peerId: string): boolean {
    if (!this.skippedNoSyncPeers.has(peerId)) return false;
    this.skippedNoSyncPeers.delete(peerId);
    return true;
  }

  admissionState(peerId: string): Readonly<{
    lastExactQueued: number;
    lastQueued: number;
    lastSuccessfulSync?: number;
    backoff?: SyncReconcilerBackoff;
  }> {
    return {
      lastExactQueued: this.rfc64ExactCatchupOnConnectAt.get(peerId) ?? 0,
      lastQueued: this.catchupOnConnectAt.get(peerId) ?? 0,
      lastSuccessfulSync: this.lastSuccessfulSyncAt.get(peerId),
      backoff: this.syncReconcilerBackoff.get(peerId),
    };
  }

  recordQueued(peerId: string, now: number, exact: boolean): void {
    this.catchupOnConnectAt.set(peerId, now);
    if (exact) this.rfc64ExactCatchupOnConnectAt.set(peerId, now);
  }

  recordExactQueued(peerId: string, now: number): void {
    this.rfc64ExactCatchupOnConnectAt.set(peerId, now);
  }

  backoffFor(peerId: string): SyncReconcilerBackoff | undefined {
    return this.syncReconcilerBackoff.get(peerId);
  }

  clearBackoff(peerId: string): void { this.syncReconcilerBackoff.delete(peerId); }

  recordBackoff(peerId: string, backoff: SyncReconcilerBackoff): void {
    this.syncReconcilerBackoff.set(peerId, backoff);
  }

  peerFreshness(peerId: string): Readonly<{
    lastSuccessfulSync?: number;
    lastSyncProgress?: number;
  }> {
    return {
      lastSuccessfulSync: this.lastSuccessfulSyncAt.get(peerId),
      lastSyncProgress: this.lastSyncProgressAt.get(peerId),
    };
  }

  diagnosticsState(): Readonly<{
    lastSuccessfulSyncAt: ReadonlyMap<string, number>;
    syncReconcilerBackoff: ReadonlyMap<string, SyncReconcilerBackoff>;
  }> {
    return {
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      syncReconcilerBackoff: this.syncReconcilerBackoff,
    };
  }

  applyAccounting(peerId: string, outcome: SyncOnConnectPeerOutcome): boolean {
    const progressAt = Math.max(Date.now(), (this.lastSyncProgressAt.get(peerId) ?? 0) + 1);
    if (outcome.progress) this.lastSyncProgressAt.set(peerId, progressAt);
    if (outcome.fresh) this.lastSuccessfulSyncAt.set(peerId, progressAt);
    this.skippedNoSyncPeers.delete(peerId);
    if (outcome.reconcilerDisposition === 'clear') this.syncReconcilerBackoff.delete(peerId);
    return outcome.reconcilerDisposition === 'retry';
  }

  clearPeer(peerId: string): void {
    this.skippedNoSyncPeers.delete(peerId);
    this.catchupOnConnectAt.delete(peerId);
    this.rfc64ExactCatchupOnConnectAt.delete(peerId);
    this.lastSuccessfulSyncAt.delete(peerId);
    this.lastSyncProgressAt.delete(peerId);
    this.syncReconcilerBackoff.delete(peerId);
    this.clearQueuedPeer(peerId);
  }

  pruneDisconnected(connected: ReadonlySet<string>, now: number, stalenessThresholdMs: number): void {
    const pruneTimestamp = (entries: Map<string, number>) => {
      for (const [peerId, timestamp] of entries) {
        if (!connected.has(peerId) && now - timestamp >= stalenessThresholdMs) entries.delete(peerId);
      }
    };
    pruneTimestamp(this.catchupOnConnectAt);
    pruneTimestamp(this.rfc64ExactCatchupOnConnectAt);
    pruneTimestamp(this.lastSuccessfulSyncAt);
    pruneTimestamp(this.lastSyncProgressAt);
    for (const [peerId, backoff] of this.syncReconcilerBackoff) {
      if (!connected.has(peerId) && now >= backoff.nextRetryAt + stalenessThresholdMs) {
        this.syncReconcilerBackoff.delete(peerId);
      }
    }
  }

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
