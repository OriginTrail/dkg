// SPDX-License-Identifier: Apache-2.0

import type { SyncReconcilerAttemptOutcome } from './attempt-accounting.js';

export type SyncOnConnectErrorHandler = (
  remotePeer: string,
  error: unknown,
) => void | Promise<void>;
export type SyncOnConnectSchedulerInternalStage =
  | 'lane-error-handler'
  | 'runner-finalizer'
  | 'scheduler-drain';

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
  /** Execute the explicit automatic-selected-then-ordinary phase plan. */
  readonly runAutomaticSelectedThenOrdinary: () => Promise<SyncReconcilerAttemptOutcome>;
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
  /** Observe contained scheduler/consumer failures without breaking cleanup. */
  readonly onInternalError: (
    remotePeer: string,
    error: unknown,
    stage: SyncOnConnectSchedulerInternalStage,
  ) => void | Promise<void>;
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
      // Lane and finalizer failures are routed inside drain. Keep an observable
      // terminal boundary for genuinely unexpected scheduler defects.
      void this.drain(remotePeer, job).catch((error: unknown) => {
        void this.reportInternalError(remotePeer, error, 'scheduler-drain');
      });
    }, delayMs);
  }

  private async drain(remotePeer: string, job: PeerJob<SelectedPlan>): Promise<void> {
    let runner: SyncOnConnectPeerJobRunner<SelectedPlan> | null = null;
    try {
      let lane = this.claimNext(job);
      if (lane === null) return;
      try {
        runner = job.runner ??= this.callbacks.createJob(remotePeer);
      } catch (error: unknown) {
        // Construction owns the whole accepted peer job, not just the lane
        // claimed first. Snapshot and fail every accepted lane before
        // releasing the peer so no successful enqueue disappears silently.
        const failedLanes: PendingLane<SelectedPlan>[] = [lane];
        let pendingLane = this.claimNext(job);
        while (pendingLane !== null) {
          failedLanes.push(pendingLane);
          pendingLane = this.claimNext(job);
        }
        // Release before invoking consumers: an error handler may immediately
        // enqueue a replacement job, which the outer finalizer must not erase.
        if (this.jobs.get(remotePeer) === job) this.jobs.delete(remotePeer);
        for (const failedLane of failedLanes) {
          try {
            await failedLane.handleSyncError(remotePeer, error);
          } catch (consumerError: unknown) {
            // Consumer failures are terminally contained by scheduler ownership;
            // continue notifying the remaining accepted lanes.
            await this.reportInternalError(
              remotePeer,
              consumerError,
              'lane-error-handler',
            );
          }
        }
        return;
      }
      while (this.jobs.get(remotePeer) === job) {
        try {
          if (lane.kind === 'selected') {
            await runner.runSelected(lane.recoveryPlan);
          } else {
            await runner.runAutomaticSelectedThenOrdinary();
          }
        } catch (error: unknown) {
          // Error ownership belongs to the lane that actually failed. A later
          // enqueue may replace a pending selected lane, but it must never
          // redirect an already-running lane's rejection to the newer caller.
          try {
            await lane.handleSyncError(remotePeer, error);
          } catch (consumerError: unknown) {
            await this.reportInternalError(
              remotePeer,
              consumerError,
              'lane-error-handler',
            );
          }
        } finally {
          if (this.jobs.get(remotePeer) === job) job.currentLane = null;
        }
        lane = this.claimNext(job);
        if (lane === null) return;
      }
    } finally {
      // No lane remains claimable by this drain. Detach before finalization so
      // a reentrant enqueue creates a replacement job instead of adding work
      // to this terminal job. finish() is intentionally synchronous: its only
      // production implementation commits in-memory reconciler accounting.
      if (this.jobs.get(remotePeer) === job) this.jobs.delete(remotePeer);
      if (runner !== null) {
        try {
          runner.finish();
        } catch (error: unknown) {
          await this.reportInternalError(remotePeer, error, 'runner-finalizer');
        }
      }
    }
  }

  private async reportInternalError(
    remotePeer: string,
    error: unknown,
    stage: SyncOnConnectSchedulerInternalStage,
  ): Promise<void> {
    try {
      await this.callbacks.onInternalError(remotePeer, error, stage);
    } catch {
      // The diagnostic sink is advisory and must not break scheduler cleanup.
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
