// SPDX-License-Identifier: Apache-2.0

import type { OrdinalRecoveryTarget } from '../chain-reconciler.js';
import type {
  VmRecoveryAdmissionParams,
  VmRecoveryPreparation,
  VmRecoveryRotationSnapshot,
  VmRecoverySlotAdmissionReservation,
  VmRecoverySlotCapture,
  VmRecoverySlotHandle,
  VmRecoverySlotScope,
} from './vm-recovery-slot-registry.js';

/** Atomic state commands available to batch orchestration; no mutable slot internals. */
export interface VmRecoveryBatchSlotPort {
  observeForAdmission(target: OrdinalRecoveryTarget): VmRecoverySlotCapture | undefined;
  isReservedDonor(target: OrdinalRecoveryTarget, handle: VmRecoverySlotHandle): boolean;
  isCurrent(target: OrdinalRecoveryTarget, handle: VmRecoverySlotHandle): boolean;
  prepare(
    target: OrdinalRecoveryTarget,
    params: VmRecoveryAdmissionParams,
    now: number,
    reservation?: VmRecoverySlotAdmissionReservation,
  ): VmRecoveryPreparation;
}

interface VmRecoveryBatchPlanOptions {
  readonly targets: readonly OrdinalRecoveryTarget[];
  readonly admissionCursor: number;
  readonly observedCandidatePeerIds: readonly string[];
  readonly now: number;
  readonly collectionDeadlineAt: number;
  readonly scope: VmRecoverySlotScope;
}

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

/** Owns fair preparation/commit ordering and attaches each eligible target before returning it. */
export class VmRecoveryBatchPlan {
  readonly initiallyEligibleTargets: readonly OrdinalRecoveryTarget[];
  readonly suppressedRecords: readonly VmRecoveryRotationSnapshot[];
  private readonly originals = new Map<OrdinalRecoveryTarget, VmRecoverySlotCapture>();
  private readonly reservations = new Map<OrdinalRecoveryTarget, VmRecoverySlotAdmissionReservation>();
  private readonly order: ReturnType<typeof planVmRecoveryAdmission>;

  constructor(private readonly slots: VmRecoveryBatchSlotPort, private readonly options: VmRecoveryBatchPlanOptions) {
    for (const target of options.targets) {
      const slot = slots.observeForAdmission(target);
      if (slot) this.originals.set(target, slot);
    }
    this.order = planVmRecoveryAdmission(options.targets, options.admissionCursor, new Set(this.originals.keys()));
    const initial = this.order.map(({ target, index }): VmRecoveryPreparedEntry => {
      const original = this.originals.get(target);
      if (original) {
        // Reserving a donor cannot refresh or discard its evidence before the
        // requester's roster commits. Rollback retains the exact old owner.
        if (slots.isReservedDonor(target, original.handle)) {
          return { index, target, prepared: { slot: original, suppressed: false } };
        }
        return { index, target, prepared: slots.prepare(target, {
          candidatePeerIds: options.observedCandidatePeerIds,
          curatorRosterConfirmed: original.snapshot.curatorRosterConfirmed,
          collectionDeadlineAt: options.collectionDeadlineAt,
        }, options.now) };
      }
      const admission = options.scope.reserveAdmission(target, options.now);
      if (admission.kind === 'reserved') {
        this.reservations.set(target, admission.reservation);
        return { index, target, prepared: { suppressed: false } };
      }
      if (admission.kind === 'existing') {
        this.originals.set(target, admission.slot);
        return { index, target, prepared: slots.prepare(target, {
          candidatePeerIds: options.observedCandidatePeerIds,
          curatorRosterConfirmed: admission.slot.snapshot.curatorRosterConfirmed,
          collectionDeadlineAt: options.collectionDeadlineAt,
        }, options.now) };
      }
      return { index, target, prepared: { suppressed: true } };
    }).sort((left, right) => left.index - right.index);
    this.initiallyEligibleTargets = initial.filter(entry => !entry.prepared.suppressed).map(entry => entry.target);
    this.suppressedRecords = initial.flatMap(entry => entry.prepared.slot ? [entry.prepared.slot.snapshot] : []);
    // Discovery may start as soon as the caller receives these targets.
    options.scope.track(this.initiallyEligibleTargets);
  }

  commit(options: VmRecoveryBatchPlanCommitOptions): {
    readonly eligible: readonly VmRecoveryPreparedEntry[];
    readonly nextAdmissionCursor?: number;
  } {
    const prepared = this.order.map(({ target, index }): VmRecoveryPreparedEntry => {
      const original = this.originals.get(target);
      if (this.options.scope.signal.aborted || !options.isCurrent()
        || (original && !this.slots.isCurrent(target, original.handle))) {
        this.reservations.get(target)?.release();
        return { index, target, prepared: { suppressed: true } };
      }
      return { index, target, prepared: this.slots.prepare(target, {
        candidatePeerIds: options.candidatePeerIds,
        curatorRosterConfirmed: options.curatorRosterConfirmed,
        collectionDeadlineAt: options.collectionDeadlineAt,
      }, options.now, this.reservations.get(target)) };
    });
    const newlyAdmitted = prepared.filter(entry => entry.prepared.slot && !this.originals.has(entry.target));
    const lastAdmitted = [...this.order].reverse().find(entry => newlyAdmitted.some(candidate => candidate.index === entry.index));
    const eligible = prepared.filter(entry => !entry.prepared.suppressed
      && (!entry.prepared.slot || this.slots.isCurrent(entry.target, entry.prepared.slot.handle)))
      .sort((left, right) => Number(Boolean(right.prepared.slot)) - Number(Boolean(left.prepared.slot))
        || left.index - right.index);
    // An authoritative roster can make a previously suppressed owner eligible.
    // Attach it here before the caller can begin transport.
    this.options.scope.track(eligible.map(({ target }) => target));
    return {
      eligible,
      ...(lastAdmitted ? { nextAdmissionCursor: (lastAdmitted.index + 1) % this.options.targets.length } : {}),
    };
  }
}

/** Pure fair ordering; state transitions are explicit planner port operations. */
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
