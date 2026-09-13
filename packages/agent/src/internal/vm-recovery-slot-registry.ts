// SPDX-License-Identifier: Apache-2.0

import { VmRecoveryBatchTransaction } from './vm-recovery-batch-transaction.js';
import {
  captureRotation,
  createRotationRecord,
  hasUnconfirmedAbsence,
  membershipMatches,
  reviseRotationRoster,
  rotationSnapshot,
  settleRotationAttempt,
  vmRecoverySlotKey,
  vmRecoveryTargetFingerprint,
  type VmRecoveryAdmissionParams,
  type VmRecoveryAttemptDisposition,
  type VmRecoveryRotationPolicy,
  type VmRecoveryRotationRecord,
  type VmRecoveryRotationSnapshot,
  type VmRecoverySlotCapture,
  type VmRecoverySlotHandle,
  type VmRecoverySlotLocator,
  type VmRecoveryTarget,
} from './vm-recovery-rotation-evidence.js';
import { VmRecoverySlotCapacity, type VmRecoveryPendingAdmission } from './vm-recovery-slot-capacity.js';
import { VmRecoverySlotGeneration, VmRecoverySlotLease } from './vm-recovery-slot-lifetimes.js';

export type {
  VmRecoveryAdmissionParams,
  VmRecoveryAttemptDisposition,
  VmRecoveryRotationPolicy,
  VmRecoveryRotationSnapshot,
  VmRecoverySlotCapture,
  VmRecoverySlotHandle,
} from './vm-recovery-rotation-evidence.js';
export { vmRecoverySlotKey, vmRecoveryTargetFingerprint } from './vm-recovery-rotation-evidence.js';

type Target = VmRecoveryTarget;
type SlotLocator = VmRecoverySlotLocator;

/** Explicit outcome of one preparation; a slot travels only with the states that retain one. */
export type VmRecoveryPreparation =
  /** Retained evidence is current and runnable under this handle. */
  | { readonly kind: 'owned'; readonly slot: VmRecoverySlotCapture }
  /** Retained evidence suppresses transport until its retry deadline. */
  | { readonly kind: 'backoff'; readonly slot: VmRecoverySlotCapture }
  /** Bounded capacity is exhausted: process-local scheduling, never absence evidence. */
  | { readonly kind: 'deferred' }
  /** Another lifecycle now owns this slot, so this preparation must not touch it. */
  | { readonly kind: 'invalidated' }
  /** Nothing is retained: an empty roster, or fail-open retirement of partial evidence. */
  | { readonly kind: 'evidence-free' };

/** Preparations that expose a target for transport. */
export type VmRecoveryEligiblePreparation = Extract<VmRecoveryPreparation, { kind: 'owned' | 'evidence-free' }>;

/** One completed physical attempt awaiting credit against the roster it was captured under. */
export interface VmRecoveryAttemptSettlement {
  readonly peerId: string | undefined;
  readonly disposition: VmRecoveryAttemptDisposition;
  readonly expectedCandidatePeerIds: readonly string[];
  readonly unavailablePeerIds?: ReadonlySet<string>;
}

/** Outcome of the post-fetch transition. */
export type VmRecoveryPostFetchTransition = 'settled' | 'revalidated' | 'stale';

/** One keyed aggregate: retained evidence plus the active cancellation generation. */
interface SlotState {
  readonly localCgId: string;
  readonly fingerprint: string;
  record?: VmRecoveryRotationRecord;
  generation?: VmRecoverySlotGeneration;
}

export interface VmRecoverySlotScope {
  readonly signal: AbortSignal;
  /** Attach selected targets before discovery and after preparation, including unowned fallback targets. */
  track(targets: readonly Target[]): void;
  reserveAdmission(target: Target, now: number): VmRecoverySlotReservation;
  release(): void;
}

export type VmRecoverySlotAdmission =
  | { readonly kind: 'existing'; readonly slot: VmRecoverySlotCapture }
  | { readonly kind: 'admitted'; readonly slot: VmRecoverySlotCapture }
  | { readonly kind: 'deferred' };

export interface VmRecoverySlotAdmissionReservation {
  commit(params: VmRecoveryAdmissionParams): VmRecoverySlotAdmission;
  release(): void;
}

export type VmRecoverySlotReservation =
  | { readonly kind: 'existing'; readonly slot: VmRecoverySlotCapture }
  | { readonly kind: 'reserved'; readonly reservation: VmRecoverySlotAdmissionReservation }
  | { readonly kind: 'deferred' };

/**
 * Coordinates one slot aggregate per target. Evidence transitions live in the
 * rotation-evidence reducer, bounded capacity and donor reservations in the
 * capacity store, and cancellation in the lifetimes module; this class owns
 * the storage and the order in which those pieces observe each transition.
 */
export class VmRecoverySlotRegistry {
  private readonly slots = new Map<string, SlotState>();
  private readonly capacity: VmRecoverySlotCapacity;

  constructor(maxEntries: number) {
    this.capacity = new VmRecoverySlotCapacity(maxEntries);
  }

  get recordCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) if (slot.record) count++;
    return count;
  }

  /** Detached point-in-time values for diagnostics; snapshots carry no command authority. */
  snapshot(): ReadonlyMap<string, VmRecoveryRotationSnapshot> {
    const records = new Map<string, VmRecoveryRotationSnapshot>();
    for (const [key, slot] of this.slots) if (slot.record) records.set(key, rotationSnapshot(slot.record));
    return records;
  }

  /** Capture a stable read model and the current generation's command token. */
  capture(target: Target): VmRecoverySlotCapture | undefined {
    const state = this.peekState(target);
    return state ? captureRotation(state) : undefined;
  }

  peekSnapshot(target: Target): VmRecoveryRotationSnapshot | undefined {
    const state = this.peekState(target);
    return state ? rotationSnapshot(state) : undefined;
  }

  read(target: Target, handle: VmRecoverySlotHandle): VmRecoveryRotationSnapshot | undefined {
    const state = this.currentState(target, handle);
    return state ? rotationSnapshot(state) : undefined;
  }

  isCurrent(target: Target, handle: VmRecoverySlotHandle): boolean {
    return this.currentState(target, handle) !== undefined;
  }

  private peekState(target: Target): VmRecoveryRotationRecord | undefined {
    const slot = this.slots.get(vmRecoverySlotKey(target));
    return slot?.fingerprint === vmRecoveryTargetFingerprint(target) ? slot.record : undefined;
  }

  private currentState(target: Target, handle: VmRecoverySlotHandle): VmRecoveryRotationRecord | undefined {
    const state = this.peekState(target);
    return state && state.handle === handle ? state : undefined;
  }

  private prune(key: string, slot: SlotState): void {
    if (!slot.record && !slot.generation && !this.capacity.pendingAt(key) && this.slots.get(key) === slot) {
      this.slots.delete(key);
    }
  }

  /** Successful ordinal completion retires evidence without aborting its shared batch. */
  complete(target: SlotLocator): void {
    const key = vmRecoverySlotKey(target);
    const slot = this.slots.get(key);
    if (!slot) return;
    const pending = this.capacity.pendingAt(key);
    if (pending) this.releaseAdmission(pending);
    slot.record = undefined;
    this.prune(key, slot);
  }

  touch(target: Target, handle: VmRecoverySlotHandle): void {
    if (!this.isCurrent(target, handle)) return;
    const key = vmRecoverySlotKey(target);
    const slot = this.slots.get(key)!;
    this.slots.delete(key);
    this.slots.set(key, slot);
  }

  private observedSlot(target: Target): SlotState | undefined {
    this.observeTarget(target);
    const key = vmRecoverySlotKey(target);
    const fingerprint = vmRecoveryTargetFingerprint(target);
    let slot = this.slots.get(key);
    // An abort listener may synchronously install a replacement. Do not take
    // ownership of that different lifecycle while completing the old command.
    if (slot && slot.fingerprint !== fingerprint) return undefined;
    if (!slot) {
      slot = { localCgId: target.localCgId, fingerprint };
      this.slots.set(key, slot);
    }
    return slot;
  }

  /** Immediate and delayed admission use the same reserved-capacity transition. */
  admit(target: Target, params: VmRecoveryAdmissionParams, now: number): VmRecoverySlotAdmission {
    if (params.candidatePeerIds.length === 0) return { kind: 'deferred' };
    const admission = this.reserveAdmission(target, now);
    return admission.kind === 'reserved' ? admission.reservation.commit(params) : admission;
  }

  private reserveAdmission(target: Target, now: number, exempt?: VmRecoverySlotLease): VmRecoverySlotReservation {
    const key = vmRecoverySlotKey(target);
    const slot = this.observedSlot(target);
    if (!slot) return { kind: 'deferred' };
    if (slot.record) return { kind: 'existing', slot: captureRotation(slot.record) };
    const pending = this.capacity.reserve(key, target.localCgId, this.slots, now, exempt);
    if (!pending) {
      this.prune(key, slot);
      return { kind: 'deferred' };
    }
    const claimed = { ...target };
    return {
      kind: 'reserved',
      reservation: {
        commit: params => this.commitAdmission(claimed, pending, params),
        release: () => this.releaseAdmission(pending),
      },
    };
  }

  private releaseAdmission(pending: VmRecoveryPendingAdmission): void {
    for (const key of this.capacity.release(pending)) {
      const slot = this.slots.get(key);
      if (slot) this.prune(key, slot);
    }
  }

  private commitAdmission(
    target: Target,
    pending: VmRecoveryPendingAdmission,
    params: VmRecoveryAdmissionParams,
  ): VmRecoverySlotAdmission {
    const { key, donor: donation } = pending;
    const slot = this.slots.get(key);
    const donor = donation && this.slots.get(donation.key);
    let record: VmRecoveryRotationRecord | undefined;
    let installed = false;
    let donorDetached = false;
    try {
      if (params.candidatePeerIds.length === 0 || !this.capacity.isActive(pending) || !slot || slot.record
        || (donation && donor?.record !== donation.record)) return { kind: 'deferred' };
      record = createRotationRecord(target, slot.fingerprint, params);
      if (donor) {
        donor.record = undefined;
        donorDetached = true;
      }
      this.onRetention('before', key);
      slot.record = record;
      this.slots.delete(key);
      this.slots.set(key, slot);
      this.onRetention('after', key);
      installed = this.slots.get(key) === slot && slot.record === record;
      return installed ? { kind: 'admitted', slot: captureRotation(record) } : { kind: 'deferred' };
    } finally {
      if (!installed) {
        if (slot && record && slot.record === record) slot.record = undefined;
        if (donorDetached && donor && donation && this.slots.get(donation.key) === donor && !donor.record) {
          donor.record = donation.record;
        }
      }
      this.releaseAdmission(pending);
      // The requester is installed and capacity accounting is settled before
      // donor abort listeners run. Only the requesting lease is detached
      // without cancellation; external invalidations exempt no one.
      if (installed && donor && donation) this.invalidateSlot(donation.key, donor, pending.exempt);
    }
  }

  /** Fault-injection seam around the atomic retention write; state stays private. */
  protected onRetention(_stage: 'before' | 'after', _key: string): void {}

  /** One roster transition for immediate callers, existing owners and delayed reservations. */
  prepare(
    target: Target,
    params: VmRecoveryAdmissionParams,
    now: number,
    reservation?: VmRecoverySlotAdmissionReservation,
  ): VmRecoveryPreparation {
    this.observeTarget(target);
    const key = vmRecoverySlotKey(target);
    const observed = this.slots.get(key);
    if (observed && observed.fingerprint !== vmRecoveryTargetFingerprint(target)) {
      // Invalidation listeners may install a replacement synchronously. This
      // command cannot observe the old target again and retire that new owner.
      reservation?.release();
      return { kind: 'invalidated' };
    }
    let record = this.peekState(target);
    if (record && hasUnconfirmedAbsence(record, params.curatorRosterConfirmed)) {
      // Absence gathered while curator discovery was unavailable must not
      // suppress the next lookup: that lookup may reveal the only holder.
      this.invalidate(target);
      if (this.slots.has(key)) {
        // Abort callbacks may already have installed a new owner, including
        // one with the same fingerprint. Do not re-observe or adopt it here.
        reservation?.release();
        return { kind: 'invalidated' };
      }
      record = undefined;
    }
    if (!record) {
      if (params.candidatePeerIds.length === 0) {
        reservation?.release();
        return { kind: 'evidence-free' };
      }
      const admission = reservation ? reservation.commit(params) : this.admit(target, params, now);
      // Preserve the pressure bound at cap: an unowned target cannot retain
      // exponential retry state, so running elevated exact transport here
      // would replay it every sweep. Defer until an expired/resolved slot is
      // available; this is process-local scheduling, never absence evidence.
      return admission.kind === 'deferred' ? { kind: 'deferred' } : { kind: 'owned', slot: admission.slot };
    }
    switch (reviseRotationRoster(record, params, now)) {
      case 'backoff':
        this.touch(target, record.handle);
        return { kind: 'backoff', slot: captureRotation(record) };
      case 'expired':
        return this.retireForPreparation(target);
      case 'collecting':
        this.touch(target, record.handle);
        return { kind: 'owned', slot: captureRotation(record) };
    }
  }

  /** Retire only this preparation's owner; never adopt a replacement created by an abort callback. */
  private retireForPreparation(target: Target): VmRecoveryPreparation {
    this.invalidate(target);
    return { kind: this.slots.has(vmRecoverySlotKey(target)) ? 'invalidated' : 'evidence-free' };
  }

  settleAttempt(
    target: Target,
    peerId: string | undefined,
    disposition: VmRecoveryAttemptDisposition,
    expectedCandidatePeerIds: readonly string[],
    handle: VmRecoverySlotHandle,
    policy: VmRecoveryRotationPolicy,
    unavailablePeerIds: ReadonlySet<string> = new Set(),
  ): void {
    const record = this.currentState(target, handle);
    if (!record) return;
    if (settleRotationAttempt(target, record, peerId, disposition, expectedCandidatePeerIds, policy, unavailablePeerIds)) {
      this.touch(target, record.handle);
    }
  }

  /**
   * Post-fetch transition for one captured attempt. An unchanged observed
   * roster credits the attempt to the target the chain re-read confirmed. Any
   * growth or shrink instead revalidates the slot against the new roster and
   * leaves the attempt uncredited: a proof roster is a set, and a different
   * set starts a different cycle.
   */
  settleAttemptAfterFetch(
    target: Target,
    handle: VmRecoverySlotHandle,
    revalidated: Target,
    observed: VmRecoveryAdmissionParams,
    attempt: VmRecoveryAttemptSettlement,
    policy: VmRecoveryRotationPolicy,
  ): VmRecoveryPostFetchTransition {
    const record = this.currentState(target, handle);
    if (!record) return 'stale';
    if (!membershipMatches(record.candidatePeerIds, observed.candidatePeerIds)) {
      this.prepare(revalidated, observed, policy.now);
      return 'revalidated';
    }
    // The chain re-read must still describe the captured target: a replaced
    // UAL or Merkle root earns the superseded generation no credit.
    if (vmRecoverySlotKey(revalidated) !== vmRecoverySlotKey(target)
      || vmRecoveryTargetFingerprint(revalidated) !== vmRecoveryTargetFingerprint(target)) return 'stale';
    this.settleAttempt(target, attempt.peerId, attempt.disposition, attempt.expectedCandidatePeerIds, handle, policy,
      attempt.unavailablePeerIds);
    return 'settled';
  }

  beginBatch(): VmRecoveryBatchTransaction {
    return new VmRecoveryBatchTransaction(this);
  }

  /** Observe a selected target once before a transaction captures its admission owner. */
  observeForAdmission(target: Target): VmRecoverySlotCapture | undefined {
    this.observeTarget(target);
    return this.capture(target);
  }

  /** Reserved donor evidence is immutable until its atomic donation commits or rolls back. */
  isReservedDonor(target: Target, handle: VmRecoverySlotHandle): boolean {
    const key = vmRecoverySlotKey(target);
    return this.slots.get(key)?.record?.handle === handle && this.capacity.isReservedDonor(key);
  }

  begin(): VmRecoverySlotScope {
    const lease = new VmRecoverySlotLease();
    const reservations = new Set<VmRecoverySlotAdmissionReservation>();
    let released = false;
    return {
      signal: lease.signal,
      track: targets => {
        if (released || lease.signal.aborted) return;
        for (const target of targets) {
          const key = vmRecoverySlotKey(target);
          const slot = this.observedSlot(target);
          if (lease.signal.aborted) {
            if (slot) this.prune(key, slot);
            break;
          }
          if (!slot) { lease.cancel(); break; }
          lease.attach(slot.generation ??= new VmRecoverySlotGeneration(key));
        }
      },
      reserveAdmission: (target, now) => {
        if (released || lease.signal.aborted) return { kind: 'deferred' };
        const result = this.reserveAdmission(target, now, lease);
        if (lease.signal.aborted) {
          if (result.kind === 'reserved') result.reservation.release();
          return { kind: 'deferred' };
        }
        if (result.kind !== 'reserved') return result;
        const inner = result.reservation;
        const reservation: VmRecoverySlotAdmissionReservation = {
          commit: params => {
            if (released || lease.signal.aborted) { inner.release(); return { kind: 'deferred' }; }
            try { return inner.commit(params); } finally { reservations.delete(reservation); }
          },
          release: () => { inner.release(); reservations.delete(reservation); },
        };
        reservations.add(reservation);
        return { kind: 'reserved', reservation };
      },
      release: () => {
        if (released) return;
        released = true;
        for (const reservation of reservations) reservation.release();
        for (const generation of lease.detachAll()) this.retireIdleGeneration(generation);
      },
    };
  }

  /** A generation nobody tracks any more no longer keeps its slot alive. */
  private retireIdleGeneration(generation: VmRecoverySlotGeneration): void {
    if (!generation.idle) return;
    const slot = this.slots.get(generation.key);
    if (slot?.generation !== generation) return;
    slot.generation = undefined;
    this.prune(generation.key, slot);
  }

  /** Observing a replacement fingerprint invalidates only the superseded aggregate. */
  observeTarget(target: Target): void {
    const key = vmRecoverySlotKey(target);
    const slot = this.slots.get(key);
    if (slot && slot.fingerprint !== vmRecoveryTargetFingerprint(target)) this.invalidateSlot(key, slot);
  }

  invalidate(target: SlotLocator): void {
    const key = vmRecoverySlotKey(target);
    const slot = this.slots.get(key);
    if (slot) this.invalidateSlot(key, slot);
  }

  private invalidateSlot(key: string, slot: SlotState, exempt?: VmRecoverySlotLease): void {
    if (this.slots.get(key) !== slot) return;
    this.slots.delete(key);
    const pending = this.capacity.pendingAt(key);
    if (pending) this.releaseAdmission(pending);
    slot.record = undefined;
    slot.generation?.end(exempt);
  }

  invalidateContextGraph(localCgId: string): void {
    // Abort listeners may acquire replacement aggregates; invalidate only the
    // identities captured at the start of this command.
    const slots = [...this.slots];
    for (const [key, slot] of slots) {
      if (slot.localCgId === localCgId) this.invalidateSlot(key, slot);
    }
  }

  close(): void {
    const slots = [...this.slots];
    for (const [key, slot] of slots) this.invalidateSlot(key, slot);
  }
}
