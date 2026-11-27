import type { ActiveLiftJobClaimSession } from './async-lift-publisher-types.js';
import type { JournalKind, LiftJob, LiftJobAccepted, LiftJobCompatibility } from './lift-job.js';

export interface ActiveLiftJobClaimTransitionBoundary {
  run<T>(transition: (current: LiftJob, scope: LiftJobTransitionScope) => Promise<T>): Promise<T>;
}

export interface LiftJobRecoveryTransitionScope {
  commitRecoveryReset(reset: LiftJobAccepted): Promise<LiftJobAccepted>;
  commitProofFailure(failed: LiftJob): Promise<LiftJob>;
  commitProofFinalization(
    finalize: () => Promise<LiftJob | null>,
  ): Promise<LiftJob | null>;
  commitReaccept(accepted: LiftJobAccepted): Promise<LiftJobAccepted>;
  commitRemoval(): Promise<void>;
}

export interface LiftJobTransitionScope extends LiftJobRecoveryTransitionScope {
  commit(next: LiftJob, kind: JournalKind): Promise<LiftJob>;
  commitProofInclusion(included: LiftJob): Promise<LiftJob>;
}

/** One atomic per-job read under the lock that owns its transition scope. */
export type LiftJobTransaction =
  | { readonly kind: 'missing' }
  | {
    readonly kind: 'present';
    readonly current: LiftJob;
    readonly scope: LiftJobTransitionScope;
  }
  | {
    readonly kind: 'compatibility';
    readonly current: LiftJobCompatibility;
    readonly scope: LiftJobRecoveryTransitionScope;
  };

/**
 * A worker checkpoint may observe proof advancing its exact claim before the callback runs.
 * Advanced records are deliberately read-only: only a still-owned record receives commit scope.
 */
export type ActiveLiftJobCheckpoint =
  | {
    readonly kind: 'advanced';
    readonly current: Extract<LiftJob, { readonly status: 'included' | 'finalized' }>;
  }
  | {
    readonly kind: 'owned';
    readonly current: LiftJob;
    readonly scope: LiftJobTransitionScope;
  };

/** Internal worker authority bound to one claim and its processing lifetime. */
export interface WorkerLiftJobClaimSession extends ActiveLiftJobClaimSession {
  transition<T>(run: (current: LiftJob, scope: LiftJobTransitionScope) => Promise<T>): Promise<T>;
  preSend<T>(run: (
    current: LiftJob, scope: LiftJobTransitionScope, restoreValidated: () => Promise<void>,
  ) => Promise<T>): Promise<T>;
  checkpoint<T>(run: (checkpoint: ActiveLiftJobCheckpoint) => Promise<T>): Promise<T>;
}
