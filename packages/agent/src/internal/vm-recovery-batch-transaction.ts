// SPDX-License-Identifier: Apache-2.0

import type { OrdinalRecoveryTarget } from '../chain-reconciler.js';
import { planVmRecoveryAdmission } from './vm-recovery-batch-plan.js';
import type {
  VmRecoveryPreparation,
  VmRecoverySlotAdmissionReservation,
  VmRecoverySlotCapture,
  VmRecoverySlotRegistry,
  VmRecoverySlotScope,
} from './vm-recovery-slot-registry.js';

interface BatchOptions {
  readonly targets: readonly OrdinalRecoveryTarget[];
  readonly admissionCursor: number;
  readonly observedCandidatePeerIds: readonly string[];
  readonly now: number;
  readonly collectionDeadlineAt: number;
}

type Admission =
  | { readonly kind: 'owner'; readonly slot: VmRecoverySlotCapture; readonly suppressed: boolean }
  | { readonly kind: 'reserved'; readonly reservation: VmRecoverySlotAdmissionReservation }
  | { readonly kind: 'unreserved'; readonly suppressed: boolean }
  | { readonly kind: 'invalidated' };

interface BatchEntry {
  readonly index: number;
  readonly target: OrdinalRecoveryTarget;
  readonly admission: Admission;
}

export interface VmRecoveryPreparedEntry {
  readonly index: number;
  readonly target: OrdinalRecoveryTarget;
  readonly prepared: VmRecoveryPreparation;
}

interface CommitOptions {
  readonly candidatePeerIds: readonly string[];
  readonly curatorRosterConfirmed: boolean;
  readonly now: number;
  readonly collectionDeadlineAt: number;
  readonly isCurrent: () => boolean;
}

/** Owns one explicit reserve/commit/release lifecycle, including cancellation attachments. */
export class VmRecoveryBatchTransaction {
  private readonly scope: VmRecoverySlotScope;
  private state: { readonly kind: 'new' | 'committed' | 'released' }
    | { readonly kind: 'reserved'; readonly entries: readonly BatchEntry[]; readonly targetCount: number }
    = { kind: 'new' };

  constructor(private readonly slots: VmRecoverySlotRegistry) {
    this.scope = slots.begin();
  }

  get signal(): AbortSignal { return this.scope.signal; }

  reserveBatch(options: BatchOptions) {
    if (this.state.kind !== 'new') throw new Error('VM recovery batch has already been reserved or released');
    try {
      const originals = new Map<OrdinalRecoveryTarget, VmRecoverySlotCapture>();
      for (const target of options.targets) {
        const slot = this.slots.observeForAdmission(target);
        if (slot) originals.set(target, slot);
      }
      const entries = planVmRecoveryAdmission(options.targets, options.admissionCursor, new Set(originals.keys()))
        .map(({ target, index }): BatchEntry => ({
          index, target, admission: this.reserveTarget(target, originals.get(target), options),
        }));
      this.state = { kind: 'reserved', entries, targetCount: options.targets.length };
      const initiallyEligibleTargets = entries.filter(({ admission }) => admission.kind === 'reserved'
        || (admission.kind !== 'invalidated' && !admission.suppressed))
        .sort((left, right) => left.index - right.index).map(({ target }) => target);
      const suppressedRecords = entries.flatMap(({ admission }) => admission.kind === 'owner'
        ? [admission.slot.snapshot] : []);
      this.scope.track(initiallyEligibleTargets);
      return { initiallyEligibleTargets, suppressedRecords };
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private reserveTarget(target: OrdinalRecoveryTarget, original: VmRecoverySlotCapture | undefined,
    options: BatchOptions): Admission {
    if (original) {
      // A donor remains untouched until its requester's admission commits.
      if (this.slots.isReservedDonor(target, original.handle)) {
        return { kind: 'owner', slot: original, suppressed: false };
      }
      const prepared = this.slots.prepare(target, {
        candidatePeerIds: options.observedCandidatePeerIds,
        curatorRosterConfirmed: original.snapshot.curatorRosterConfirmed,
        collectionDeadlineAt: options.collectionDeadlineAt,
      }, options.now);
      if (prepared.slot) return { kind: 'owner', slot: prepared.slot, suppressed: prepared.suppressed };
      if (prepared.suppressed) return { kind: 'invalidated' };
      // Preparation retired this owner's partial evidence and verified that no
      // abort callback installed a replacement. Reserve a fresh generation now;
      // carrying the retired handle through discovery would suppress this pass.
    }
    const admission = this.scope.reserveAdmission(target, options.now);
    if (admission.kind === 'reserved') return admission;
    if (admission.kind === 'existing') return { kind: 'owner', slot: admission.slot, suppressed: false };
    return { kind: 'unreserved', suppressed: true };
  }

  commit(options: CommitOptions): {
    readonly eligible: readonly VmRecoveryPreparedEntry[];
    readonly nextAdmissionCursor?: number;
  } {
    if (this.state.kind !== 'reserved') throw new Error('VM recovery batch must be reserved before commit');
    const { entries, targetCount } = this.state;
    this.state = { kind: 'committed' };
    try {
      const prepared = entries.map(({ target, index, admission }): VmRecoveryPreparedEntry => {
        if (this.signal.aborted || !options.isCurrent() || admission.kind === 'invalidated'
          || (admission.kind === 'owner' && !this.slots.isCurrent(target, admission.slot.handle))) {
          if (admission.kind === 'reserved') admission.reservation.release();
          return { index, target, prepared: { suppressed: true } };
        }
        return { index, target, prepared: this.slots.prepare(target, {
          candidatePeerIds: options.candidatePeerIds,
          curatorRosterConfirmed: options.curatorRosterConfirmed,
          collectionDeadlineAt: options.collectionDeadlineAt,
        }, options.now, admission.kind === 'reserved' ? admission.reservation : undefined) };
      });
      let lastAdmitted: BatchEntry | undefined;
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        if (entry.admission.kind !== 'owner' && prepared[index]?.prepared.slot) lastAdmitted = entry;
      }
      const eligible = prepared.filter(entry => !entry.prepared.suppressed
        && (!entry.prepared.slot || this.slots.isCurrent(entry.target, entry.prepared.slot.handle)))
        .sort((left, right) => Number(Boolean(right.prepared.slot)) - Number(Boolean(left.prepared.slot))
          || left.index - right.index);
      this.scope.track(eligible.map(({ target }) => target));
      return { eligible, ...(lastAdmitted ? { nextAdmissionCursor: (lastAdmitted.index + 1) % targetCount } : {}) };
    } catch (error) {
      this.release();
      throw error;
    }
  }

  release(): void {
    this.state = { kind: 'released' };
    this.scope.release();
  }
}
