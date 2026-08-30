// SPDX-License-Identifier: Apache-2.0

import type { SyncReconcilerAttemptOutcome } from './attempt-accounting.js';

export type SyncOnConnectErrorHandler = (remotePeer: string, error: unknown) => void;

interface OrdinaryLane {
  readonly kind: 'ordinary';
  readonly handleSyncError: SyncOnConnectErrorHandler;
}

interface SelectedLane<SelectedPlan> {
  readonly kind: 'selected';
  readonly handleSyncError: SyncOnConnectErrorHandler;
  readonly recoveryPlan?: SelectedPlan;
}

type PendingLane<SelectedPlan> = OrdinaryLane | SelectedLane<SelectedPlan>;

interface PeerJob<SelectedPlan> {
  currentLane: PendingLane<SelectedPlan>['kind'] | null;
  pendingSelected: SelectedLane<SelectedPlan> | null;
  pendingOrdinary: OrdinaryLane | null;
  ordinaryStarted: boolean;
  runner: SyncOnConnectPeerJobRunner<SelectedPlan> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SyncOnConnectPeerJobRunner<SelectedPlan> {
  readonly runOrdinary: () => Promise<SyncReconcilerAttemptOutcome>;
  readonly runSelected: (
    recoveryPlan?: SelectedPlan,
  ) => Promise<SyncReconcilerAttemptOutcome>;
  /** Discard deferred accounting when the owning peer job is cancelled. */
  readonly cancel: () => void;
  /** Commit the job's combined reconciler accounting exactly once. */
  readonly finish: () => void;
}

export interface SyncOnConnectPeerSchedulerCallbacks<SelectedPlan> {
  /** One runner owns every phase and the combined outcome for one peer job. */
  readonly createJob: (
    remotePeer: string,
  ) => SyncOnConnectPeerJobRunner<SelectedPlan>;
}

/**
 * One timer and one normalized pair of pending slots per remote peer.
 * Selected work always drains first; ordinary work is admitted at most once.
 */
export class SyncOnConnectPeerScheduler<SelectedPlan> {
  private readonly jobs = new Map<string, PeerJob<SelectedPlan>>();

  constructor(
    private readonly callbacks: SyncOnConnectPeerSchedulerCallbacks<SelectedPlan>,
  ) {}

  get size(): number {
    return this.jobs.size;
  }

  has(remotePeer: string): boolean {
    return this.jobs.has(remotePeer);
  }

  clear(remotePeer: string): void {
    const job = this.jobs.get(remotePeer);
    if (job?.timer !== null && job?.timer !== undefined) clearTimeout(job.timer);
    job?.runner?.cancel();
    this.jobs.delete(remotePeer);
  }

  enqueueOrdinary(
    remotePeer: string,
    handleSyncError: SyncOnConnectErrorHandler,
    delayMs: number,
  ): boolean {
    const existing = this.jobs.get(remotePeer);
    if (existing === undefined) {
      this.schedule(remotePeer, {
        kind: 'ordinary',
        handleSyncError,
      }, delayMs);
      return true;
    }
    if (existing.ordinaryStarted || existing.pendingOrdinary !== null) return false;
    existing.pendingOrdinary = {
      kind: 'ordinary',
      handleSyncError,
    };
    return true;
  }

  enqueueSelected(
    remotePeer: string,
    handleSyncError: SyncOnConnectErrorHandler,
    delayMs: number,
    recoveryPlan?: SelectedPlan,
  ): boolean {
    const lane: SelectedLane<SelectedPlan> = {
      kind: 'selected',
      handleSyncError,
      ...(recoveryPlan === undefined ? {} : { recoveryPlan }),
    };
    const existing = this.jobs.get(remotePeer);
    if (existing === undefined) {
      this.schedule(remotePeer, lane, delayMs);
      return true;
    }
    existing.pendingSelected = lane;
    return true;
  }

  private schedule(
    remotePeer: string,
    lane: PendingLane<SelectedPlan>,
    delayMs: number,
  ): void {
    const job: PeerJob<SelectedPlan> = {
      currentLane: null,
      pendingSelected: lane.kind === 'selected' ? lane : null,
      pendingOrdinary: lane.kind === 'ordinary' ? lane : null,
      ordinaryStarted: false,
      runner: null,
      timer: null,
    };
    this.jobs.set(remotePeer, job);
    job.timer = setTimeout(() => {
      job.timer = null;
      void this.drain(remotePeer, job);
    }, delayMs);
  }

  private async drain(remotePeer: string, job: PeerJob<SelectedPlan>): Promise<void> {
    const runner = job.runner ??= this.callbacks.createJob(remotePeer);
    try {
      while (this.jobs.get(remotePeer) === job) {
        const lane = this.claimNext(job);
        if (lane === null) return;
        try {
          if (lane.kind === 'selected') {
            await runner.runSelected(lane.recoveryPlan);
          } else {
            await runner.runOrdinary();
          }
        } catch (error: unknown) {
          // Error ownership belongs to the lane that actually failed. A later
          // enqueue may replace a pending selected lane, but it must never
          // redirect an already-running lane's rejection to the newer caller.
          lane.handleSyncError(remotePeer, error);
        } finally {
          if (this.jobs.get(remotePeer) === job) job.currentLane = null;
        }
      }
    } finally {
      try {
        runner.finish();
      } finally {
        if (this.jobs.get(remotePeer) === job) this.jobs.delete(remotePeer);
      }
    }
  }

  private claimNext(job: PeerJob<SelectedPlan>): PendingLane<SelectedPlan> | null {
    if (job.pendingSelected !== null) {
      const selected = job.pendingSelected;
      job.pendingSelected = null;
      job.currentLane = 'selected';
      return selected;
    }
    if (job.pendingOrdinary !== null) {
      const ordinary = job.pendingOrdinary;
      job.pendingOrdinary = null;
      job.ordinaryStarted = true;
      job.currentLane = 'ordinary';
      return ordinary;
    }
    return null;
  }
}
