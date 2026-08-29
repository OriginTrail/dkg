// SPDX-License-Identifier: Apache-2.0

export type SyncOnConnectErrorHandler = (remotePeer: string, error: unknown) => void;

export type OrdinarySyncOnConnectMode = 'ordinary' | 'ordinary-after-selected';

interface OrdinaryLane {
  readonly kind: 'ordinary';
  readonly handleSyncError: SyncOnConnectErrorHandler;
  readonly mode: OrdinarySyncOnConnectMode;
}

interface SelectedLane<SelectedPlan> {
  readonly kind: 'selected';
  readonly handleSyncError: SyncOnConnectErrorHandler;
  readonly recoveryPlan?: SelectedPlan;
}

type PendingScheduledLanes<SelectedPlan> =
  | {
    selected: SelectedLane<SelectedPlan>;
    ordinary: OrdinaryLane | null;
  }
  | {
    selected: null;
    ordinary: OrdinaryLane;
  };

type OrdinaryDisposition =
  | { kind: 'available'; pending: OrdinaryLane | null }
  | { kind: 'already-run' };

type PeerJobState<SelectedPlan> =
  | {
    kind: 'scheduled';
    pending: PendingScheduledLanes<SelectedPlan>;
  }
  | {
    kind: 'running-selected';
    pendingSelected: SelectedLane<SelectedPlan> | null;
    ordinary: OrdinaryDisposition;
  }
  | {
    kind: 'running-ordinary';
    pendingSelected: SelectedLane<SelectedPlan> | null;
  };

interface PeerJob<SelectedPlan> {
  state: PeerJobState<SelectedPlan>;
  timer: ReturnType<typeof setTimeout> | null;
  handleUnexpectedError: SyncOnConnectErrorHandler;
}

type ClaimedLane<SelectedPlan> = OrdinaryLane | SelectedLane<SelectedPlan>;

export interface SyncOnConnectPeerSchedulerSnapshot {
  readonly state: PeerJobState<unknown>['kind'];
  readonly hasPendingSelected: boolean;
  readonly pendingOrdinaryMode: OrdinarySyncOnConnectMode | null;
}

export interface SyncOnConnectPeerSchedulerCallbacks<SelectedPlan> {
  readonly runOrdinary: (
    remotePeer: string,
    handleSyncError: SyncOnConnectErrorHandler,
    mode: OrdinarySyncOnConnectMode,
  ) => Promise<void>;
  readonly runSelected: (
    remotePeer: string,
    handleSyncError: SyncOnConnectErrorHandler,
    recoveryPlan?: SelectedPlan,
  ) => Promise<void>;
}

/**
 * One timer and one explicit transition model per remote peer. Selected work
 * preempts ordinary work that has not started; an exact upgrade arriving
 * during either running lane is retained and drained by the same owner.
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
    this.jobs.delete(remotePeer);
  }

  snapshot(remotePeer: string): SyncOnConnectPeerSchedulerSnapshot | null {
    const state = this.jobs.get(remotePeer)?.state;
    if (state === undefined) return null;
    if (state.kind === 'scheduled') {
      return {
        state: state.kind,
        hasPendingSelected: state.pending.selected !== null,
        pendingOrdinaryMode: state.pending.ordinary?.mode ?? null,
      };
    }
    if (state.kind === 'running-selected') {
      return {
        state: state.kind,
        hasPendingSelected: state.pendingSelected !== null,
        pendingOrdinaryMode:
          state.ordinary.kind === 'available' ? state.ordinary.pending?.mode ?? null : null,
      };
    }
    return {
      state: state.kind,
      hasPendingSelected: state.pendingSelected !== null,
      pendingOrdinaryMode: null,
    };
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
        mode: 'ordinary',
      }, delayMs);
      return true;
    }
    existing.handleUnexpectedError = handleSyncError;
    const state = existing.state;
    if (state.kind === 'scheduled') {
      if (state.pending.ordinary !== null) return false;
      state.pending.ordinary = {
        kind: 'ordinary',
        handleSyncError,
        mode: 'ordinary-after-selected',
      };
      return true;
    }
    if (state.kind === 'running-selected' && state.ordinary.kind === 'available') {
      if (state.ordinary.pending !== null) return false;
      state.ordinary.pending = {
        kind: 'ordinary',
        handleSyncError,
        mode: 'ordinary-after-selected',
      };
      return true;
    }
    return false;
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
    existing.handleUnexpectedError = handleSyncError;
    const state = existing.state;
    if (state.kind === 'scheduled') {
      state.pending.selected = lane;
      if (state.pending.ordinary !== null) {
        state.pending.ordinary = {
          ...state.pending.ordinary,
          mode: 'ordinary-after-selected',
        };
      }
      return true;
    }
    state.pendingSelected = lane;
    if (
      state.kind === 'running-selected'
      && state.ordinary.kind === 'available'
      && state.ordinary.pending !== null
    ) {
      state.ordinary.pending = {
        ...state.ordinary.pending,
        mode: 'ordinary-after-selected',
      };
    }
    return true;
  }

  private schedule(
    remotePeer: string,
    lane: ClaimedLane<SelectedPlan>,
    delayMs: number,
  ): void {
    const pending: PendingScheduledLanes<SelectedPlan> = lane.kind === 'selected'
      ? { selected: lane, ordinary: null }
      : { selected: null, ordinary: lane };
    const job: PeerJob<SelectedPlan> = {
      state: { kind: 'scheduled', pending },
      timer: null,
      handleUnexpectedError: lane.handleSyncError,
    };
    this.jobs.set(remotePeer, job);
    job.timer = setTimeout(() => {
      job.timer = null;
      this.drain(remotePeer, job).catch((error: unknown) => {
        job.handleUnexpectedError(remotePeer, error);
      }).finally(() => {
        if (this.jobs.get(remotePeer) === job) this.jobs.delete(remotePeer);
      });
    }, delayMs);
  }

  private async drain(remotePeer: string, job: PeerJob<SelectedPlan>): Promise<void> {
    while (this.jobs.get(remotePeer) === job) {
      const lane = this.claimNext(job);
      if (lane === null) return;
      if (lane.kind === 'selected') {
        await this.callbacks.runSelected(
          remotePeer,
          lane.handleSyncError,
          lane.recoveryPlan,
        );
      } else {
        await this.callbacks.runOrdinary(
          remotePeer,
          lane.handleSyncError,
          lane.mode,
        );
      }
    }
  }

  private claimNext(job: PeerJob<SelectedPlan>): ClaimedLane<SelectedPlan> | null {
    const state = job.state;
    if (state.kind === 'scheduled') {
      if (state.pending.selected !== null) {
        const selected = state.pending.selected;
        job.state = {
          kind: 'running-selected',
          pendingSelected: null,
          ordinary: { kind: 'available', pending: state.pending.ordinary },
        };
        return selected;
      }
      const ordinary = state.pending.ordinary;
      job.state = { kind: 'running-ordinary', pendingSelected: null };
      return ordinary;
    }
    if (state.kind === 'running-selected') {
      if (state.pendingSelected !== null) {
        const selected = state.pendingSelected;
        state.pendingSelected = null;
        return selected;
      }
      if (state.ordinary.kind === 'available' && state.ordinary.pending !== null) {
        const ordinary = state.ordinary.pending;
        job.state = { kind: 'running-ordinary', pendingSelected: null };
        return ordinary;
      }
      return null;
    }
    if (state.pendingSelected !== null) {
      const selected = state.pendingSelected;
      job.state = {
        kind: 'running-selected',
        pendingSelected: null,
        ordinary: { kind: 'already-run' },
      };
      return selected;
    }
    return null;
  }
}
