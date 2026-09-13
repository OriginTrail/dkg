// SPDX-License-Identifier: Apache-2.0

import type { OrdinalRecoveryTarget } from '../chain-reconciler.js';
import { planVmRecoveryAdmission } from './vm-recovery-batch-plan.js';
import type {
  VmRecoveryEligiblePreparation,
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

/** What one target holds between reservation and commit. */
type Admission =
  /** An existing owner that is runnable before discovery. */
  | { readonly kind: 'owned'; readonly slot: VmRecoverySlotCapture }
  /** An existing owner in active backoff; the authoritative roster may release it. */
  | { readonly kind: 'backoff'; readonly slot: VmRecoverySlotCapture }
  /** Reserved capacity waiting for the authoritative roster. */
  | { readonly kind: 'reserved'; readonly reservation: VmRecoverySlotAdmissionReservation }
  /** No capacity before discovery; commit retries immediate admission. */
  | { readonly kind: 'deferred' }
  /** Superseded before discovery; commit never touches it. */
  | { readonly kind: 'invalidated' };

interface BatchEntry {
  readonly index: number;
  readonly target: OrdinalRecoveryTarget;
  readonly admission: Admission;
}

export interface VmRecoveryPreparedEntry {
  readonly index: number;
  readonly target: OrdinalRecoveryTarget;
  readonly prepared: VmRecoveryEligiblePreparation;
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
      const initiallyEligibleTargets = entries
        .filter(({ admission }) => admission.kind === 'owned' || admission.kind === 'reserved')
        .sort((left, right) => left.index - right.index).map(({ target }) => target);
      const suppressedRecords = entries.flatMap(({ admission }) => admission.kind === 'backoff'
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
      if (this.slots.isReservedDonor(target, original.handle)) return { kind: 'owned', slot: original };
      const prepared = this.slots.prepare(target, {
        candidatePeerIds: options.observedCandidatePeerIds,
        curatorRosterConfirmed: original.snapshot.curatorRosterConfirmed,
        collectionDeadlineAt: options.collectionDeadlineAt,
      }, options.now);
      // Preparation retired this owner's partial evidence and verified that no
      // abort callback installed a replacement. Reserve a fresh generation now;
      // carrying the retired handle through discovery would suppress this pass.
      if (prepared.kind !== 'evidence-free') return prepared;
    }
    const admission = this.scope.reserveAdmission(target, options.now);
    switch (admission.kind) {
      case 'reserved': return admission;
      case 'existing': return { kind: 'owned', slot: admission.slot };
      case 'deferred': return { kind: 'deferred' };
    }
  }

  commit(options: CommitOptions): {
    readonly eligible: readonly VmRecoveryPreparedEntry[];
    readonly nextAdmissionCursor?: number;
  } {
    if (this.state.kind !== 'reserved') throw new Error('VM recovery batch must be reserved before commit');
    const { entries, targetCount } = this.state;
    this.state = { kind: 'committed' };
    try {
      const prepared = entries.map(({ target, index, admission }) =>
        ({ index, target, prepared: this.commitEntry(target, admission, options) }));
      let lastAdmitted: BatchEntry | undefined;
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        const wasOwner = entry.admission.kind === 'owned' || entry.admission.kind === 'backoff';
        if (!wasOwner && prepared[index]?.prepared.kind === 'owned') lastAdmitted = entry;
      }
      const eligible = prepared.flatMap(({ index, target, prepared: preparation }): VmRecoveryPreparedEntry[] => {
        switch (preparation.kind) {
          case 'owned':
            return this.slots.isCurrent(target, preparation.slot.handle) ? [{ index, target, prepared: preparation }] : [];
          case 'evidence-free':
            return [{ index, target, prepared: preparation }];
          case 'backoff':
          case 'deferred':
          case 'invalidated':
            return [];
        }
      }).sort((left, right) => Number(right.prepared.kind === 'owned') - Number(left.prepared.kind === 'owned')
        || left.index - right.index);
      this.scope.track(eligible.map(({ target }) => target));
      return { eligible, ...(lastAdmitted ? { nextAdmissionCursor: (lastAdmitted.index + 1) % targetCount } : {}) };
    } catch (error) {
      this.release();
      throw error;
    }
  }

  /** Apply the authoritative roster to one admission; a stale batch invalidates every remaining claim. */
  private commitEntry(target: OrdinalRecoveryTarget, admission: Admission, options: CommitOptions): VmRecoveryPreparation {
    const stale = this.signal.aborted || !options.isCurrent();
    const params = {
      candidatePeerIds: options.candidatePeerIds,
      curatorRosterConfirmed: options.curatorRosterConfirmed,
      collectionDeadlineAt: options.collectionDeadlineAt,
    };
    switch (admission.kind) {
      case 'invalidated':
        return admission;
      case 'reserved':
        if (stale) { admission.reservation.release(); return { kind: 'invalidated' }; }
        return this.slots.prepare(target, params, options.now, admission.reservation);
      case 'owned':
      case 'backoff':
        if (stale || !this.slots.isCurrent(target, admission.slot.handle)) return { kind: 'invalidated' };
        return this.slots.prepare(target, params, options.now);
      case 'deferred':
        if (stale) return { kind: 'invalidated' };
        return this.slots.prepare(target, params, options.now);
    }
  }

  release(): void {
    this.state = { kind: 'released' };
    this.scope.release();
  }
}
