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
