// SPDX-License-Identifier: Apache-2.0

import type { OrdinalRecoveryTarget } from '../chain-reconciler.js';
import type { VmRecoveryRotationSnapshot, VmRecoveryPreparation } from './vm-recovery-slot-registry.js';

export interface VmRecoveryPreparedEntry {
  readonly index: number;
  readonly target: OrdinalRecoveryTarget;
  readonly prepared: VmRecoveryPreparation;
}

export interface VmRecoveryBatchPlanCommitOptions {
  readonly candidatePeerIds: readonly string[];
  readonly curatorRosterConfirmed: boolean;
  readonly now: number;
  readonly collectionDeadlineAt: number;
  readonly isCurrent: () => boolean;
}

export interface VmRecoveryBatchPlan {
  readonly initiallyEligibleTargets: readonly OrdinalRecoveryTarget[];
  readonly suppressedRecords: readonly VmRecoveryRotationSnapshot[];
  commit(options: VmRecoveryBatchPlanCommitOptions): {
    readonly eligible: readonly VmRecoveryPreparedEntry[];
    readonly nextAdmissionCursor?: number;
  };
}

/** Pure fair ordering; observing targets and reserving capacity belong to the registry. */
export function planVmRecoveryAdmission(
  targets: readonly OrdinalRecoveryTarget[],
  admissionCursor: number,
  owned: ReadonlySet<OrdinalRecoveryTarget>,
): Array<{ readonly index: number; readonly target: OrdinalRecoveryTarget; readonly distance: number }> {
  const cursor = targets.length === 0 ? 0 : admissionCursor % targets.length;
  return targets.map((target, index) => ({ target, index, distance: (index - cursor + targets.length) % targets.length }))
    .sort((left, right) => Number(owned.has(left.target)) - Number(owned.has(right.target))
      || left.distance - right.distance);
}
