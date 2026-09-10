// SPDX-License-Identifier: Apache-2.0

import type { OrdinalRecoveryTarget } from '../chain-reconciler.js';
import {
  type VmReconcileRotationRecord,
  type VmRecoverySlotAdmissionReservation,
  type VmRecoverySlotRegistry,
  type VmRecoverySlotScope,
} from './vm-recovery-slot-registry.js';

export interface VmRecoveryPreparedEntry {
  readonly index: number;
  readonly target: OrdinalRecoveryTarget;
  readonly prepared: {
    readonly record?: VmReconcileRotationRecord;
    readonly suppressed: boolean;
  };
}

interface VmRecoveryBatchPlanOptions {
  readonly targets: readonly OrdinalRecoveryTarget[];
  readonly admissionCursor: number;
  readonly observedCandidatePeerIds: readonly string[];
  readonly now: number;
  readonly registry: VmRecoverySlotRegistry;
  readonly scope: VmRecoverySlotScope;
  readonly prepare: (
    target: OrdinalRecoveryTarget,
    candidatePeerIds: readonly string[],
    now: number,
    curatorRosterConfirmed: boolean,
  ) => VmRecoveryPreparedEntry['prepared'];
}

interface VmRecoveryBatchPlanCommitOptions {
  readonly candidatePeerIds: readonly string[];
  readonly curatorRosterConfirmed: boolean;
  readonly now: number;
  readonly collectionDeadlineAt: number;
  readonly isCurrent: () => boolean;
}

export interface VmRecoveryBatchPlanCommit {
  readonly eligible: readonly VmRecoveryPreparedEntry[];
  readonly nextAdmissionCursor?: number;
}

/**
 * Owns the two-phase slot transaction for one exact-recovery batch.
 *
 * Construction classifies existing owners and reserves bounded capacity before
 * discovery. `commit` applies the authoritative roster to those reservations,
 * rejects invalidated generations, and returns only targets that still own the
 * retry state needed for transport.
 */
export class VmRecoveryBatchPlan {
  readonly #options: VmRecoveryBatchPlanOptions;
  readonly #initiallyOwnedRecords = new Map<OrdinalRecoveryTarget, VmReconcileRotationRecord>();
  readonly #admissionReservations = new Map<
    OrdinalRecoveryTarget,
    VmRecoverySlotAdmissionReservation
  >();
  readonly #initialPreparations: readonly VmRecoveryPreparedEntry[];

  constructor(options: VmRecoveryBatchPlanOptions) {
    this.#options = options;
    const { targets, registry } = options;
    for (const target of targets) {
      registry.observeTarget(target);
      const record = registry.peekRecord(target);
      if (record) this.#initiallyOwnedRecords.set(target, record);
    }
    this.#initialPreparations = this.#inAdmissionOrder()
      .map(({ index, target }) => this.#prepareInitial(index, target))
      .sort((left, right) => left.index - right.index);
  }

  get initiallyEligibleTargets(): readonly OrdinalRecoveryTarget[] {
    return this.#initialPreparations
      .filter(({ prepared }) => !prepared.suppressed)
      .map(({ target }) => target);
  }

  get suppressedRecords(): readonly VmReconcileRotationRecord[] {
    return this.#initialPreparations
      .map(({ prepared }) => prepared.record)
      .filter((record): record is VmReconcileRotationRecord => record !== undefined);
  }

  commit(options: VmRecoveryBatchPlanCommitOptions): VmRecoveryBatchPlanCommit {
    const { registry } = this.#options;
    const preparedEntries = this.#inAdmissionOrder()
      .map(({ index, target }): VmRecoveryPreparedEntry => {
        const original = this.#initiallyOwnedRecords.get(target);
        if (!options.isCurrent() || (original && !registry.isCurrent(target, original))) {
          return { index, target, prepared: { suppressed: true } };
        }
        const reservation = this.#admissionReservations.get(target);
        if (reservation) {
          const admission = reservation.commit({
            candidatePeerIds: options.candidatePeerIds,
            curatorRosterConfirmed: options.curatorRosterConfirmed,
            collectionDeadlineAt: options.collectionDeadlineAt,
          });
          return {
            index,
            target,
            prepared: admission.kind === 'deferred'
              ? { suppressed: true }
              : { record: admission.record, suppressed: false },
          };
        }
        return {
          index,
          target,
          prepared: this.#options.prepare(
            target,
            options.candidatePeerIds,
            options.now,
            options.curatorRosterConfirmed,
          ),
        };
      })
      .sort((left, right) => left.index - right.index);

    const newlyAdmitted = preparedEntries
      .filter(({ target, prepared }) => prepared.record
        && !this.#initiallyOwnedRecords.has(target));
    const lastAdmitted = newlyAdmitted.reduce<VmRecoveryPreparedEntry | undefined>(
      (latest, entry) => !latest
        || this.#admissionDistance(entry.index) > this.#admissionDistance(latest.index)
        ? entry
        : latest,
      undefined,
    );
    const eligible = preparedEntries
      .map((entry): VmRecoveryPreparedEntry => {
        const { record } = entry.prepared;
        if (record && !registry.isCurrent(entry.target, record)) {
          return { ...entry, prepared: { suppressed: true } };
        }
        return entry;
      })
      .filter((entry) => !entry.prepared.suppressed)
      .sort((left, right) => {
        const leftInstalled = left.prepared.record
          && registry.isCurrent(left.target, left.prepared.record) ? 1 : 0;
        const rightInstalled = right.prepared.record
          && registry.isCurrent(right.target, right.prepared.record) ? 1 : 0;
        return rightInstalled - leftInstalled || left.index - right.index;
      });

    return {
      eligible,
      ...(lastAdmitted
        ? { nextAdmissionCursor: (lastAdmitted.index + 1) % this.#options.targets.length }
        : {}),
    };
  }

  #prepareInitial(index: number, target: OrdinalRecoveryTarget): VmRecoveryPreparedEntry {
    const existing = this.#initiallyOwnedRecords.get(target);
    if (existing) {
      return {
        index,
        target,
        prepared: this.#options.prepare(
          target,
          this.#options.observedCandidatePeerIds,
          this.#options.now,
          existing.curatorRosterConfirmed,
        ),
      };
    }
    const admission = this.#options.scope.reserveAdmission(target, this.#options.now);
    if (admission.kind === 'existing') {
      return {
        index,
        target,
        prepared: this.#options.prepare(
          target,
          this.#options.observedCandidatePeerIds,
          this.#options.now,
          admission.record.curatorRosterConfirmed,
        ),
      };
    }
    if (admission.kind === 'reserved') {
      this.#admissionReservations.set(target, admission.reservation);
      return { index, target, prepared: { suppressed: false } };
    }
    return { index, target, prepared: { suppressed: true } };
  }

  #inAdmissionOrder(): Array<{
    readonly index: number;
    readonly target: OrdinalRecoveryTarget;
  }> {
    return this.#options.targets
      .map((target, index) => ({ index, target }))
      .sort((left, right) => (
        Number(this.#initiallyOwnedRecords.has(left.target))
          - Number(this.#initiallyOwnedRecords.has(right.target))
        || this.#admissionDistance(left.index) - this.#admissionDistance(right.index)
      ));
  }

  #admissionDistance(index: number): number {
    const length = this.#options.targets.length;
    const cursor = this.#options.admissionCursor % length;
    return (index - cursor + length) % length;
  }
}
