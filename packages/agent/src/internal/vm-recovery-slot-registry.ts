// SPDX-License-Identifier: Apache-2.0

import type { OrdinalRecoveryTarget } from '../chain-reconciler.js';
import {
  captureRotation,
  creditRotationCleanAbsence,
  createRotationRecord,
  hasUnconfirmedAbsence,
  isRotationExpired,
  membershipMatches,
  recordRotationPeerVisit,
  reviseRotationRoster,
  rotationSnapshot,
  settleRotationUnavailablePeers,
  vmRecoverySlotKey,
  vmRecoveryTargetFingerprint,
  type VmRecoveryAdmissionParams,
  type VmRecoveryRotationPolicy,
  type VmRecoveryRotationRecord,
  type VmRecoveryRotationSnapshot,
  type VmRecoverySlotCapture,
  type VmRecoverySlotHandle,
  type VmRecoverySlotLocator,
  type VmRecoveryTarget,
} from './vm-recovery-rotation-evidence.js';
import {
  VmRecoverySlotCapacity,
  type VmRecoveryPendingAdmission,
} from './vm-recovery-slot-capacity.js';
import { VmRecoverySlotGeneration, VmRecoverySlotLease } from './vm-recovery-slot-lifetimes.js';

export type {
  VmRecoveryAdmissionParams,
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

interface VmRecoveryBatchOptions {
  readonly targets: readonly OrdinalRecoveryTarget[];
  readonly admissionCursor: number;
  readonly observedCandidatePeerIds: readonly string[];
  readonly now: number;
  readonly collectionDeadlineAt: number;
}

interface VmRecoveryBatchCommitOptions {
  readonly candidatePeerIds: readonly string[];
  readonly curatorRosterConfirmed: boolean;
  readonly now: number;
  readonly collectionDeadlineAt: number;
  readonly isCurrent: () => boolean;
}

export interface VmRecoveryPreparedEntry {
  readonly index: number;
  readonly target: OrdinalRecoveryTarget;
  readonly prepared: VmRecoveryEligiblePreparation;
}

export interface VmRecoveryBatchTransaction {
  readonly signal: AbortSignal;
  reserveBatch(options: VmRecoveryBatchOptions): {
    readonly initiallyEligibleTargets: readonly OrdinalRecoveryTarget[];
    readonly suppressedRecords: readonly VmRecoveryRotationSnapshot[];
  };
  commit(options: VmRecoveryBatchCommitOptions): {
    readonly eligible: readonly VmRecoveryPreparedEntry[];
    readonly nextAdmissionCursor?: number;
  };
  release(): void;
}

type VmRecoveryBatchAdmission =
  | { readonly kind: 'owned'; readonly slot: VmRecoverySlotCapture }
  | { readonly kind: 'backoff'; readonly slot: VmRecoverySlotCapture }
  | { readonly kind: 'reserved'; readonly reservation: VmRecoverySlotAdmissionReservation }
  | { readonly kind: 'deferred' }
  | { readonly kind: 'invalidated' };

interface VmRecoveryBatchEntry {
  readonly index: number;
  readonly target: OrdinalRecoveryTarget;
  readonly admission: VmRecoveryBatchAdmission;
}

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
    return this.capacity.size;
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
    if (slot.record) {
      this.capacity.retire(key, slot.record.handle);
      slot.record = undefined;
    }
    this.prune(key, slot);
  }

  touch(target: Target, handle: VmRecoverySlotHandle): void {
    if (!this.isCurrent(target, handle)) return;
    const key = vmRecoverySlotKey(target);
    const slot = this.slots.get(key)!;
    this.capacity.touch(key, handle);
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

  private isExpiredCapacityOwner(key: string, ownerToken: symbol, now: number): boolean {
    const record = this.slots.get(key)?.record;
    return record?.handle === ownerToken && isRotationExpired(record, now);
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
    const pending = this.capacity.reserve(
      key,
      target.localCgId,
      (ownerKey, ownerToken) => this.isExpiredCapacityOwner(ownerKey, ownerToken, now),
    );
    if (!pending) {
      this.prune(key, slot);
      return { kind: 'deferred' };
    }
    const claimed = { ...target };
    return {
      kind: 'reserved',
      reservation: {
        commit: params => this.commitAdmission(claimed, pending, params, exempt),
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
    exempt?: VmRecoverySlotLease,
  ): VmRecoverySlotAdmission {
    const { key, donor: donation } = pending;
    const slot = this.slots.get(key);
    const donor = donation && this.slots.get(donation.key);
    let installed = false;
    try {
      if (params.candidatePeerIds.length === 0 || !this.capacity.isActive(pending) || !slot || slot.record
        || (donation && donor?.record?.handle !== donation.ownerToken)) return { kind: 'deferred' };
      const record = createRotationRecord(target, slot.fingerprint, params);
      if (!this.capacity.commit(pending, { localCgId: target.localCgId, ownerToken: record.handle })) {
        return { kind: 'deferred' };
      }
      if (donor) donor.record = undefined;
      slot.record = record;
      this.slots.delete(key);
      this.slots.set(key, slot);
      installed = true;
      return { kind: 'admitted', slot: captureRotation(record) };
    } finally {
      this.releaseAdmission(pending);
      // The requester is installed and capacity accounting is settled before
      // donor abort listeners run. Only the requesting lease is detached
      // without cancellation; external invalidations exempt no one.
      if (installed && donor && donation) this.invalidateSlot(donation.key, donor, exempt);
    }
  }

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

  recordPeerVisit(
    target: Target,
    peerId: string,
    expectedCandidatePeerIds: readonly string[],
    handle: VmRecoverySlotHandle,
    policy: VmRecoveryRotationPolicy,
    unavailablePeerIds: ReadonlySet<string> = new Set(),
  ): void {
    const record = this.currentState(target, handle);
    if (!record) return;
    if (recordRotationPeerVisit(
      target, record, peerId, expectedCandidatePeerIds, policy, unavailablePeerIds,
    )) {
      this.touch(target, record.handle);
    }
  }

  settleUnavailablePeers(
    target: Target,
    expectedCandidatePeerIds: readonly string[],
    handle: VmRecoverySlotHandle,
    policy: VmRecoveryRotationPolicy,
    unavailablePeerIds: ReadonlySet<string>,
  ): void {
    const record = this.currentState(target, handle);
    if (!record) return;
    if (settleRotationUnavailablePeers(
      target, record, expectedCandidatePeerIds, policy, unavailablePeerIds,
    )) this.touch(target, record.handle);
  }

  creditCleanAbsence(
    target: Target,
    peerId: string,
    expectedCandidatePeerIds: readonly string[],
    handle: VmRecoverySlotHandle,
    policy: VmRecoveryRotationPolicy,
    unavailablePeerIds: ReadonlySet<string> = new Set(),
  ): void {
    const record = this.currentState(target, handle);
    if (!record) return;
    if (creditRotationCleanAbsence(
      target, record, peerId, expectedCandidatePeerIds, policy, unavailablePeerIds,
    )) this.touch(target, record.handle);
  }

  /**
   * Post-fetch transition for one captured attempt. An unchanged observed
   * roster credits the attempt to the target the chain re-read confirmed. Any
   * growth or shrink instead revalidates the slot against the new roster and
   * leaves the attempt uncredited: a proof roster is a set, and a different
   * set starts a different cycle.
   */
  revalidateAfterFetch(
    target: Target,
    handle: VmRecoverySlotHandle,
    revalidated: Target,
    observed: VmRecoveryAdmissionParams,
    cleanAbsence: {
      readonly peerId: string;
      readonly expectedCandidatePeerIds: readonly string[];
      readonly unavailablePeerIds?: ReadonlySet<string>;
    } | undefined,
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
    if (cleanAbsence) this.creditCleanAbsence(
      target,
      cleanAbsence.peerId,
      cleanAbsence.expectedCandidatePeerIds,
      handle,
      policy,
      cleanAbsence.unavailablePeerIds,
    );
    return 'settled';
  }

  /** The batch transaction plans on top of the same scope primitive as `begin`. */
  beginBatch(): VmRecoveryBatchTransaction {
    const scope = this.openScope();
    let state: { readonly kind: 'new' | 'committed' | 'released' }
      | { readonly kind: 'reserved'; readonly entries: readonly VmRecoveryBatchEntry[]; readonly targetCount: number }
      = { kind: 'new' };

    const reserveTarget = (
      target: OrdinalRecoveryTarget,
      original: VmRecoverySlotCapture | undefined,
      options: VmRecoveryBatchOptions,
    ): VmRecoveryBatchAdmission => {
      if (original) {
        // A donor remains untouched until its requester's admission commits.
        if (this.isReservedDonor(target, original.handle)) return { kind: 'owned', slot: original };
        const prepared = this.prepare(target, {
          candidatePeerIds: options.observedCandidatePeerIds,
          curatorRosterConfirmed: original.snapshot.curatorRosterConfirmed,
          collectionDeadlineAt: options.collectionDeadlineAt,
        }, options.now);
        // Preparation retired this owner's partial evidence and verified that
        // no abort callback installed a replacement. Reserve a fresh generation
        // now instead of carrying a retired handle through discovery.
        if (prepared.kind !== 'evidence-free') return prepared;
      }
      const admission = scope.reserveAdmission(target, options.now);
      switch (admission.kind) {
        case 'reserved': return admission;
        case 'existing': return { kind: 'owned', slot: admission.slot };
        case 'deferred': return { kind: 'deferred' };
      }
    };

    const release = (): void => {
      state = { kind: 'released' };
      scope.release();
    };

    const reserveBatch: VmRecoveryBatchTransaction['reserveBatch'] = options => {
      if (state.kind !== 'new') throw new Error('VM recovery batch has already been reserved or released');
      try {
        const cursor = options.targets.length === 0 ? 0 : options.admissionCursor % options.targets.length;
        // Capture ownership as a value on each planning entry. Sorting never
        // depends on the identity of a mutable target object.
        const entries = options.targets.map((target, index) => ({
          target,
          index,
          distance: (index - cursor + options.targets.length) % options.targets.length,
          original: this.observeForAdmission(target),
        })).sort((left, right) => Number(left.original !== undefined) - Number(right.original !== undefined)
          || left.distance - right.distance)
          .map(({ target, index, original }): VmRecoveryBatchEntry => ({
            index,
            target,
            admission: reserveTarget(target, original, options),
          }));
        state = { kind: 'reserved', entries, targetCount: options.targets.length };
        const initiallyEligibleTargets = entries
          .filter(({ admission }) => admission.kind === 'owned' || admission.kind === 'reserved')
          .sort((left, right) => left.index - right.index)
          .map(({ target }) => target);
        const suppressedRecords = entries.flatMap(({ admission }) => admission.kind === 'backoff'
          ? [admission.slot.snapshot] : []);
        scope.track(initiallyEligibleTargets);
        return { initiallyEligibleTargets, suppressedRecords };
      } catch (error) {
        release();
        throw error;
      }
    };
    const commit: VmRecoveryBatchTransaction['commit'] = options => {
      if (state.kind !== 'reserved') throw new Error('VM recovery batch must be reserved before commit');
      const { entries, targetCount } = state;
      state = { kind: 'committed' };
      try {
        const params = {
          candidatePeerIds: options.candidatePeerIds,
          curatorRosterConfirmed: options.curatorRosterConfirmed,
          collectionDeadlineAt: options.collectionDeadlineAt,
        };
        const prepared = entries.map(({ target, index, admission }) => {
          const stale = scope.signal.aborted || !options.isCurrent();
          let result: VmRecoveryPreparation;
          switch (admission.kind) {
            case 'invalidated': result = admission; break;
            case 'reserved':
              if (stale) { admission.reservation.release(); result = { kind: 'invalidated' }; }
              else result = this.prepare(target, params, options.now, admission.reservation);
              break;
            case 'owned':
            case 'backoff':
              result = stale || !this.isCurrent(target, admission.slot.handle)
                ? { kind: 'invalidated' }
                : this.prepare(target, params, options.now);
              break;
            case 'deferred':
              result = stale ? { kind: 'invalidated' } : this.prepare(target, params, options.now);
              break;
          }
          return { index, target, prepared: result };
        });
        let lastAdmitted: VmRecoveryBatchEntry | undefined;
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index]!;
          const wasOwner = entry.admission.kind === 'owned' || entry.admission.kind === 'backoff';
          if (!wasOwner && prepared[index]?.prepared.kind === 'owned') lastAdmitted = entry;
        }
        const eligible = prepared.flatMap(({ index, target, prepared: preparation }): VmRecoveryPreparedEntry[] => {
          switch (preparation.kind) {
            case 'owned':
              return this.isCurrent(target, preparation.slot.handle) ? [{ index, target, prepared: preparation }] : [];
            case 'evidence-free': return [{ index, target, prepared: preparation }];
            case 'backoff':
            case 'deferred':
            case 'invalidated': return [];
          }
        }).sort((left, right) => Number(right.prepared.kind === 'owned') - Number(left.prepared.kind === 'owned')
          || left.index - right.index);
        scope.track(eligible.map(({ target }) => target));
        return {
          eligible,
          ...(lastAdmitted && targetCount > 0
            ? { nextAdmissionCursor: (lastAdmitted.index + 1) % targetCount }
            : {}),
        };
      } catch (error) {
        release();
        throw error;
      }
    };
    const transaction: VmRecoveryBatchTransaction = {
      signal: scope.signal,
      reserveBatch,
      commit,
      release,
    };
    return transaction;
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

  /**
   * Open a scope over retained slots. Focused suites drive the shared
   * primitive through this entry point; `beginBatch` composes the same one.
   */
  begin(): VmRecoverySlotScope {
    return this.openScope();
  }

  /**
   * The one lease/reservation lifetime: tracking attaches generations and
   * cancels on a vanished slot, admission is guarded by cancellation and
   * release, and release returns every reservation and retires idle
   * generations.
   */
  private openScope(): VmRecoverySlotScope {
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
    if (slot.record) {
      this.capacity.retire(key, slot.record.handle);
      slot.record = undefined;
    }
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
