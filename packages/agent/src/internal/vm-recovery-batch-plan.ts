// SPDX-License-Identifier: Apache-2.0

import type { OrdinalRecoveryTarget } from '../chain-reconciler.js';

/** Pure fair ordering with no reservations or lifecycle effects. */
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
