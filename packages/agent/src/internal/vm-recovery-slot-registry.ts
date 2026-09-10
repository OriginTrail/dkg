import { createHash } from 'node:crypto';
import { planVmRecoveryAdmission, type VmRecoveryBatchPlan, type VmRecoveryPreparedEntry } from './vm-recovery-batch-plan.js';
import type { OrdinalRecoveryTarget } from '../chain-reconciler.js';

type Target = Pick<OrdinalRecoveryTarget, 'localCgId' | 'onChainCgId' | 'ordinal' | 'ual' | 'merkleRoot'>;
type SlotLocator = Pick<Target, 'localCgId' | 'onChainCgId' | 'ordinal'>;

/** Process-local evidence owned by one chain-ordinal exact-recovery slot. */
export interface VmReconcileRotationRecord extends Readonly<SlotLocator> {
  readonly fingerprint: string;
  readonly phase: 'collecting' | 'backoff';
  readonly backoffKind?: 'clean-absence' | 'incomplete-cycle';
  readonly candidatePeerIds: ReadonlySet<string>;
  readonly attemptedPeerIds: ReadonlySet<string>;
  readonly cleanAbsentPeerIds: ReadonlySet<string>;
  readonly curatorRosterConfirmed: boolean;
  readonly collectionDeadlineAt: number;
  readonly lastAttemptedPeerId?: string;
  readonly failures: number;
  readonly nextRetryAt: number;
}


type MutableRotationRecord = {
  -readonly [K in keyof VmReconcileRotationRecord]: VmReconcileRotationRecord[K] extends ReadonlySet<infer V>
    ? Set<V> : VmReconcileRotationRecord[K];
};

export interface VmRecoveryRotationPolicy {
  readonly now: number;
  readonly getLocalPeerId: () => string;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

interface VmRecoveryBatchOptions {
  readonly targets: readonly OrdinalRecoveryTarget[];
  readonly admissionCursor: number;
  readonly observedCandidatePeerIds: readonly string[];
  readonly now: number;
  readonly collectionDeadlineAt: number;
  readonly scope: VmRecoverySlotScope;
}

function membershipMatches(left: ReadonlySet<string>, right: readonly string[]): boolean {
  return left.size === right.length && right.every(peer => left.has(peer));
}

export function vmRecoverySlotKey(target: SlotLocator): string {
  return `${target.localCgId}\0${target.onChainCgId}\0${target.ordinal}`;
}

export function vmRecoveryTargetFingerprint(target: Pick<Target, 'ual' | 'merkleRoot'>): string {
  return `${target.ual}\0${target.merkleRoot.toLowerCase()}`;
}

interface SlotGeneration {
  readonly controller: AbortController;
  users: number;
}

interface SlotState {
  readonly localCgId: string;
  readonly fingerprint: string;
  record?: MutableRotationRecord;
  generation?: SlotGeneration;
  reservation?: { readonly kind: 'requester' | 'donor'; readonly admission: SlotAdmission };
}

interface SlotAdmission {
  readonly key: string;
  readonly target: Target;
  readonly slot: SlotState;
  readonly donor?: { readonly key: string; readonly slot: SlotState; readonly record: MutableRotationRecord };
  readonly donationReason?: symbol;
  active: boolean;
}

interface AdmissionParams {
  readonly candidatePeerIds: readonly string[];
  readonly curatorRosterConfirmed: boolean;
  readonly collectionDeadlineAt: number;
}

export interface VmRecoverySlotScope {
  readonly signal: AbortSignal;
  /** Attach selected targets before discovery and after preparation, including unowned fallback targets. */
  track(targets: readonly Target[]): void;
  reserveAdmission(target: Target, now: number): VmRecoverySlotReservation;
  release(): void;
}

export type VmRecoverySlotAdmission =
  | { readonly kind: 'existing'; readonly record: VmReconcileRotationRecord }
  | { readonly kind: 'admitted'; readonly record: VmReconcileRotationRecord }
  | { readonly kind: 'deferred' };

export interface VmRecoverySlotAdmissionReservation {
  commit(params: AdmissionParams): VmRecoverySlotAdmission;
  release(): void;
}

export type VmRecoverySlotReservation =
  | { readonly kind: 'existing'; readonly record: VmReconcileRotationRecord }
  | { readonly kind: 'reserved'; readonly reservation: VmRecoverySlotAdmissionReservation }
  | { readonly kind: 'deferred' };

/** One aggregate owns each slot's retained proof, active generation, and reservation. */
export class VmRecoverySlotRegistry {
  private readonly slots = new Map<string, SlotState>();
  private readonly views = new WeakMap<MutableRotationRecord, VmReconcileRotationRecord>();
  private readonly stateByView = new WeakMap<VmReconcileRotationRecord, MutableRotationRecord>();

  private view(state: MutableRotationRecord): VmReconcileRotationRecord {
    const existing = this.views.get(state);
    if (existing) return existing;
    const view: VmReconcileRotationRecord = Object.freeze({
      get localCgId() { return state.localCgId; },
      get onChainCgId() { return state.onChainCgId; },
      get ordinal() { return state.ordinal; },
      get fingerprint() { return state.fingerprint; },
      get phase() { return state.phase; },
      get backoffKind() { return state.backoffKind; },
      get candidatePeerIds() { return new Set(state.candidatePeerIds); },
      get attemptedPeerIds() { return new Set(state.attemptedPeerIds); },
      get cleanAbsentPeerIds() { return new Set(state.cleanAbsentPeerIds); },
      get curatorRosterConfirmed() { return state.curatorRosterConfirmed; },
      get collectionDeadlineAt() { return state.collectionDeadlineAt; },
      get lastAttemptedPeerId() { return state.lastAttemptedPeerId; },
      get failures() { return state.failures; },
      get nextRetryAt() { return state.nextRetryAt; },
    });
    this.views.set(state, view);
    this.stateByView.set(view, state);
    return view;
  }

  private peekState(target: Target): MutableRotationRecord | undefined {
    const slot = this.slots.get(vmRecoverySlotKey(target));
    return slot?.fingerprint === vmRecoveryTargetFingerprint(target) ? slot.record : undefined;
  }


  constructor(private readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('VM recovery slot capacity must be a positive safe integer');
    }
  }

  get recordCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) if (slot.record) count++;
    return count;
  }

  /** Detached membership for diagnostics and tests; callers cannot mutate ownership. */
  snapshot(): ReadonlyMap<string, VmReconcileRotationRecord> {
    const records = new Map<string, VmReconcileRotationRecord>();
    for (const [key, slot] of this.slots) if (slot.record) records.set(key, this.view(slot.record));
    return records;
  }

  /** Pure lookup: target observation/invalidation is an explicit command. */
  peekRecord(target: Target): VmReconcileRotationRecord | undefined {
    const state = this.peekState(target);
    return state ? this.view(state) : undefined;
  }

  isCurrent(target: Target, record: VmReconcileRotationRecord): boolean {
    return this.peekRecord(target) === record;
  }

  private prune(key: string, slot: SlotState): void {
    if (!slot.record && !slot.generation && !slot.reservation && this.slots.get(key) === slot) {
      this.slots.delete(key);
    }
  }

  /** Successful ordinal completion retires evidence without aborting its shared batch. */
  complete(target: SlotLocator): void {
    const key = vmRecoverySlotKey(target);
    const slot = this.slots.get(key);
    if (!slot) return;
    if (slot.reservation) this.releaseAdmission(slot.reservation.admission);
    slot.record = undefined;
    this.prune(key, slot);
  }

  touch(target: Target, record: VmReconcileRotationRecord): void {
    if (!this.isCurrent(target, record)) return;
    const key = vmRecoverySlotKey(target);
    const slot = this.slots.get(key)!;
    this.slots.delete(key);
    this.slots.set(key, slot);
  }

  /** Count the requester that will own reserved capacity, not its departing donor. */
  private ownsCapacity(slot: SlotState): boolean {
    return slot.reservation?.kind === 'requester' || (slot.record !== undefined && slot.reservation?.kind !== 'donor');
  }

  private occupiedCapacity(): number {
    let count = 0;
    for (const slot of this.slots.values()) if (this.ownsCapacity(slot)) count++;
    return count;
  }

  private findDonor(requestingCgId: string, now: number): SlotAdmission['donor'] {
    const countsByCg = new Map<string, number>();
    for (const [key, slot] of this.slots) {
      if (this.ownsCapacity(slot)) countsByCg.set(slot.localCgId, (countsByCg.get(slot.localCgId) ?? 0) + 1);
      const record = slot.record;
      if (!record || slot.reservation) continue;
      if ((record.phase === 'backoff' && now < record.nextRetryAt)
        || (record.phase === 'collecting' && now < record.collectionDeadlineAt)) continue;
      return { key, slot, record };
    }
    if (!requestingCgId || (countsByCg.get(requestingCgId) ?? 0) !== 0) return undefined;
    for (const [key, slot] of this.slots) {
      if (slot.record && !slot.reservation && (countsByCg.get(slot.localCgId) ?? 0) > 1) {
        return { key, slot, record: slot.record };
      }
    }
    return undefined;
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
  admit(target: Target, params: AdmissionParams, now: number): VmRecoverySlotAdmission {
    if (params.candidatePeerIds.length === 0) return { kind: 'deferred' };
    const admission = this.reserveAdmission(target, now);
    return admission.kind === 'reserved' ? admission.reservation.commit(params) : admission;
  }

  private reserveAdmission(
    target: Target,
    now: number,
    donationReason?: symbol,
  ): VmRecoverySlotReservation {
    const key = vmRecoverySlotKey(target);
    const slot = this.observedSlot(target);
    if (!slot) return { kind: 'deferred' };
    if (slot.record) return { kind: 'existing', record: this.view(slot.record) };
    if (slot.reservation) return { kind: 'deferred' };
    const hasOpenCapacity = this.occupiedCapacity() < this.maxEntries;
    const donor = hasOpenCapacity ? undefined : this.findDonor(target.localCgId, now);
    if (!hasOpenCapacity && !donor) {
      this.prune(key, slot);
      return { kind: 'deferred' };
    }
    const admission: SlotAdmission = { key, target: { ...target }, slot, donor, donationReason, active: true };
    slot.reservation = { kind: 'requester', admission };
    if (donor) donor.slot.reservation = { kind: 'donor', admission };
    return {
      kind: 'reserved',
      reservation: {
        commit: params => this.commitAdmission(admission, params),
        release: () => this.releaseAdmission(admission),
      },
    };
  }

  private releaseAdmission(admission: SlotAdmission): void {
    if (!admission.active) return;
    admission.active = false;
    for (const entry of [admission, admission.donor]) {
      if (!entry) continue;
      if (entry.slot.reservation?.admission === admission) entry.slot.reservation = undefined;
      this.prune(entry.key, entry.slot);
    }
  }

  private commitAdmission(admission: SlotAdmission, params: AdmissionParams): VmRecoverySlotAdmission {
    const { key, slot, donor, target } = admission;
    let record: MutableRotationRecord | undefined;
    let installed = false;
    let donorDetached = false;
    try {
      if (params.candidatePeerIds.length === 0) return { kind: 'deferred' };
      if (!admission.active || this.slots.get(key) !== slot
        || slot.reservation?.admission !== admission) return { kind: 'deferred' };
      record = {
        localCgId: target.localCgId, onChainCgId: target.onChainCgId, ordinal: target.ordinal,
        fingerprint: slot.fingerprint, phase: 'collecting',
        candidatePeerIds: new Set(params.candidatePeerIds), attemptedPeerIds: new Set(),
        cleanAbsentPeerIds: new Set(), curatorRosterConfirmed: params.curatorRosterConfirmed,
        collectionDeadlineAt: params.collectionDeadlineAt, failures: 0, nextRetryAt: 0,
      };
      if (!admission.active || this.slots.get(key) !== slot || slot.record
        || (donor && (this.slots.get(donor.key) !== donor.slot || donor.slot.record !== donor.record))) {
        return { kind: 'deferred' };
      }
      if (donor) {
        donor.slot.record = undefined;
        donorDetached = true;
      }
      this.retainRecord(key, this.view(record));
      installed = this.slots.get(key) === slot && slot.record === record;
      return installed ? { kind: 'admitted', record: this.view(record) } : { kind: 'deferred' };
    } finally {
      if (!installed) {
        if (record && slot.record === record) slot.record = undefined;
        if (donorDetached && donor && this.slots.get(donor.key) === donor.slot && !donor.slot.record) {
          donor.slot.record = donor.record;
        }
      }
      this.releaseAdmission(admission);
      // The requester is installed and capacity accounting is settled before
      // donor abort listeners run. Only this reservation's owning scope may
      // ignore that exact donation; external invalidations never carry it.
      if (installed && donor) this.invalidateSlot(donor.key, donor.slot, admission.donationReason);
    }
  }

  protected retainRecord(key: string, record: VmReconcileRotationRecord): void {
    const slot = this.slots.get(key);
    const state = this.stateByView.get(record);
    if (!state || !slot || slot.record || slot.fingerprint !== record.fingerprint) {
      throw new Error('VM recovery slot changed before retention');
    }
    slot.record = state;
    this.slots.delete(key);
    this.slots.set(key, slot);
  }

  /** One roster transition for immediate callers, existing owners and delayed reservations. */
  prepare(
    target: Target,
    params: AdmissionParams,
    now: number,
    reservation?: VmRecoverySlotAdmissionReservation,
  ): { readonly record?: VmReconcileRotationRecord; readonly suppressed: boolean } {
    const { candidatePeerIds, curatorRosterConfirmed } = params;
    this.observeTarget(target);
    const observed = this.slots.get(vmRecoverySlotKey(target));
    if (observed && observed.fingerprint !== vmRecoveryTargetFingerprint(target)) {
      // Invalidation listeners may install a replacement synchronously. This
      // command cannot observe the old target again and retire that new owner.
      reservation?.release();
      return { suppressed: true };
    }
    let record = this.peekState(target);
    if (
      record?.phase === 'backoff'
      && record.backoffKind === 'clean-absence'
      && (!record.curatorRosterConfirmed || !curatorRosterConfirmed)
    ) {
      // Absence gathered while curator discovery was unavailable must not
      // suppress the next lookup: that lookup may reveal the only holder.
      this.invalidate(target);
      if (this.slots.has(vmRecoverySlotKey(target))) {
        // Abort callbacks may already have installed a new owner, including
        // one with the same fingerprint. Do not re-observe or adopt it here.
        reservation?.release();
        return { suppressed: true };
      }
      record = undefined;
    }
    if (candidatePeerIds.length === 0 && !record) {
      reservation?.release();
      return { suppressed: false };
    }
    if (candidatePeerIds.length === 0 && record) {
      // A transient empty socket view cannot invalidate a completed proof: doing
      // so would redial and refetch every sweep after ordinary disconnects.
      // Partial evidence is different and remains fail-open; drop it so the next
      // non-empty roster starts a genuinely fresh cycle.
      if (record?.phase === 'backoff' && now < record.nextRetryAt) {
        this.touch(target, this.view(record));
        return { record: this.view(record), suppressed: true };
      }
      this.invalidate(target);
      return { suppressed: false };
    }

    if (!record) {
      const admission = reservation
        ? reservation.commit(params)
        : this.admit(target, params, now);
      if (admission.kind === 'deferred') {
        // Preserve the pressure bound at cap: an unowned target cannot retain
        // exponential retry state, so running elevated exact transport here
        // would replay it every sweep. Defer until an expired/resolved slot is
        // available; this is process-local scheduling, never absence evidence.
        return { suppressed: true };
      }
      return {
        record: admission.record,
        suppressed: false,
      };
    }

    const membershipUnchanged = membershipMatches(
      record.candidatePeerIds,
      candidatePeerIds,
    );
    const rosterProofUpgraded = !record.curatorRosterConfirmed && curatorRosterConfirmed;
    if (!membershipUnchanged) {
      const priorCycleWasIncomplete = record.backoffKind === 'incomplete-cycle'
        || [...record.attemptedPeerIds]
          .some((peerId) => !record.cleanAbsentPeerIds.has(peerId));
      const previousCandidatePeerIds = record.candidatePeerIds;
      const nextCandidatePeerIds = new Set(candidatePeerIds);
      record.candidatePeerIds = new Set(candidatePeerIds);
      record.curatorRosterConfirmed = curatorRosterConfirmed;
      const removedPeer = [...previousCandidatePeerIds]
        .some((peerId) => !nextCandidatePeerIds.has(peerId));
      if (removedPeer) {
        // A proof roster is a set, not an accumulation of surviving credits.
        // Any removal/replacement invalidates the whole cycle so shrink can
        // never manufacture exhaustion or preserve an active suppression.
        record.phase = 'collecting';
        record.backoffKind = undefined;
        record.nextRetryAt = 0;
        record.attemptedPeerIds.clear();
        record.cleanAbsentPeerIds.clear();
        record.lastAttemptedPeerId = undefined;
        record.collectionDeadlineAt = params.collectionDeadlineAt;
      } else if (!rosterProofUpgraded) {
        // Pure growth preserves valid credits for retained identities, but the
        // newly observed peer is uncredited and immediately breaks backoff.
        // Do not let a publication-window incomplete response compound into
        // multi-minute suppression merely because startup discovers the same
        // recovery roster one peer at a time. Clean-absence history still
        // keeps its exponential damping; only transport/timing uncertainty
        // starts a fresh base-delay epoch when the evidence universe grows.
        record.phase = 'collecting';
        record.backoffKind = undefined;
        record.nextRetryAt = 0;
        if (priorCycleWasIncomplete) record.failures = 0;
        record.collectionDeadlineAt = params.collectionDeadlineAt;
      }
    } else {
      record.curatorRosterConfirmed = curatorRosterConfirmed;
    }
    if (rosterProofUpgraded) {
      // A peer response gathered while curator discovery was unconfirmed is
      // useful transport evidence, not authoritative absence proof. Reprobe
      // the complete now-authoritative roster even when that roster also grew.
      record.phase = 'collecting';
      record.backoffKind = undefined;
      record.nextRetryAt = 0;
      record.attemptedPeerIds.clear();
      record.cleanAbsentPeerIds.clear();
      record.lastAttemptedPeerId = undefined;
      record.collectionDeadlineAt = params.collectionDeadlineAt;
    }
    if (record.phase === 'backoff') {
      if (now < record.nextRetryAt) {
        this.touch(target, this.view(record));
        return { record: this.view(record), suppressed: true };
      }
      // A deadline only opens a new collection cycle. It never earns another
      // failure/backoff without fresh clean-absence evidence from every peer.
      record.phase = 'collecting';
      record.backoffKind = undefined;
      record.attemptedPeerIds.clear();
      record.cleanAbsentPeerIds.clear();
      record.collectionDeadlineAt = params.collectionDeadlineAt;
      record.nextRetryAt = 0;
    } else if (now >= record.collectionDeadlineAt) {
      // Expired partial evidence fails open and releases its cache slot. Return
      // evidence-free for this pass so a repeatedly ineligible roster cannot
      // refresh all collecting entries just before capacity admission runs.
      this.invalidate(target);
      return { suppressed: false };
    }

    this.touch(target, this.view(record));
    return { record: this.view(record), suppressed: false };
  }

  private enterBackoff(target: Target, record: MutableRotationRecord,
    kind: NonNullable<VmReconcileRotationRecord['backoffKind']>, policy: VmRecoveryRotationPolicy): void {
    record.failures += 1;
    const exponentialBackoff = Math.min(
      policy.maxBackoffMs,
      policy.baseBackoffMs
        * 2 ** Math.max(0, record.failures - 1),
    );
    const jitterSample = createHash('sha256')
      .update(`${policy.getLocalPeerId()}\0${target.localCgId}\0${target.onChainCgId}\0${target.ordinal}\0${record.fingerprint}\0${record.failures}`)
      .digest()
      .readUInt32BE(0) / 0x1_0000_0000;
    const backoff = Math.min(
      policy.maxBackoffMs,
      Math.max(1, Math.round(exponentialBackoff * (0.8 + jitterSample * 0.4))),
    );
    record.phase = 'backoff';
    record.backoffKind = kind;
    record.collectionDeadlineAt = 0;
    record.nextRetryAt = policy.now + backoff;
  }

  settleAttempt(
    target: Target,
    peerId: string | undefined,
    disposition: 'found' | 'clean-absent' | 'incomplete',
    expectedCandidatePeerIds: readonly string[],
    capturedRecord: VmReconcileRotationRecord,
    policy: VmRecoveryRotationPolicy,
    unavailablePeerIds: ReadonlySet<string> = new Set(),
  ): void {
    if (!this.isCurrent(target, capturedRecord)) return;
    const record = this.stateByView.get(capturedRecord)!;
    if (!membershipMatches(
      record.candidatePeerIds,
      expectedCandidatePeerIds,
    )) return;
    if (peerId !== undefined && !record.candidatePeerIds.has(peerId)) return;

    if (peerId !== undefined) {
      record.lastAttemptedPeerId = peerId;
      record.attemptedPeerIds.add(peerId);
      if (disposition === 'clean-absent') record.cleanAbsentPeerIds.add(peerId);
      // Preserve fairly accumulated proof progress while other targets share
      // the bounded peer budget. A cycle expires only after this slot itself
      // stops making physical progress for the effective maximum.
      record.collectionDeadlineAt = policy.now
        + policy.maxBackoffMs;
    }
    const scheduledEveryPeer = record.candidatePeerIds.size > 0 && [...record.candidatePeerIds]
      .every((candidatePeerId) => record.attemptedPeerIds.has(candidatePeerId)
        || unavailablePeerIds.has(candidatePeerId));
    const cleanAbsentFromEveryPeer = record.candidatePeerIds.size > 0 && [...record.candidatePeerIds]
      .every((candidatePeerId) => record.cleanAbsentPeerIds.has(candidatePeerId));
    const completedBackoffKind = cleanAbsentFromEveryPeer
      ? 'clean-absence'
      : scheduledEveryPeer
        ? 'incomplete-cycle'
        : undefined;
    if (completedBackoffKind && record.curatorRosterConfirmed) {
      if (record.phase === 'backoff') {
        // Post-fetch reconciliation may upgrade the physical attempt already
        // credited above. It is the same cycle, so retain one failure epoch.
        if (completedBackoffKind === 'clean-absence') {
          record.backoffKind = 'clean-absence';
        }
      } else {
        this.enterBackoff(target, record, completedBackoffKind, policy);
      }
    }
    this.touch(target, this.view(record));
  }

  prepareBatch(options: VmRecoveryBatchOptions): VmRecoveryBatchPlan {
    const originals = new Map<OrdinalRecoveryTarget, VmReconcileRotationRecord>();
    const reservations = new Map<OrdinalRecoveryTarget, VmRecoverySlotAdmissionReservation>();
    for (const target of options.targets) {
      this.observeTarget(target);
      const record = this.peekRecord(target);
      if (record) originals.set(target, record);
    }
    const order = planVmRecoveryAdmission(options.targets, options.admissionCursor, new Set(originals.keys()));
    const initial = order.map(({ target, index }): VmRecoveryPreparedEntry => {
      const original = originals.get(target);
      if (original) {
        // Reserving a donor cannot refresh or discard its evidence before the
        // requester's roster commits. Rollback must retain the exact old owner.
        if (this.slots.get(vmRecoverySlotKey(target))?.reservation?.kind === 'donor') {
          return { index, target, prepared: { record: original, suppressed: false } };
        }
        return { index, target, prepared: this.prepare(target, {
          candidatePeerIds: options.observedCandidatePeerIds,
          curatorRosterConfirmed: original.curatorRosterConfirmed,
          collectionDeadlineAt: options.collectionDeadlineAt,
        }, options.now) };
      }
      const admission = options.scope.reserveAdmission(target, options.now);
      if (admission.kind === 'reserved') {
        reservations.set(target, admission.reservation);
        return { index, target, prepared: { suppressed: false } };
      }
      if (admission.kind === 'existing') {
        originals.set(target, admission.record);
        return { index, target, prepared: this.prepare(target, {
          candidatePeerIds: options.observedCandidatePeerIds,
          curatorRosterConfirmed: admission.record.curatorRosterConfirmed,
          collectionDeadlineAt: options.collectionDeadlineAt,
        }, options.now) };
      }
      return { index, target, prepared: { suppressed: true } };
    }).sort((left, right) => left.index - right.index);
    return Object.freeze({
      initiallyEligibleTargets: initial.filter(entry => !entry.prepared.suppressed).map(entry => entry.target),
      suppressedRecords: initial.flatMap(entry => entry.prepared.record ? [entry.prepared.record] : []),
      commit: (commitOptions: Parameters<VmRecoveryBatchPlan['commit']>[0]) => {
        const prepared = order.map(({ target, index }): VmRecoveryPreparedEntry => {
          const original = originals.get(target);
          if (!commitOptions.isCurrent() || (original && !this.isCurrent(target, original))) {
            reservations.get(target)?.release();
            return { index, target, prepared: { suppressed: true } };
          }
          return { index, target, prepared: this.prepare(target, {
            candidatePeerIds: commitOptions.candidatePeerIds,
            curatorRosterConfirmed: commitOptions.curatorRosterConfirmed,
            collectionDeadlineAt: commitOptions.collectionDeadlineAt,
          }, commitOptions.now, reservations.get(target)) };
        });
        const newlyAdmitted = prepared.filter(entry => entry.prepared.record && !originals.has(entry.target));
        const lastAdmitted = [...order].reverse().find(entry => newlyAdmitted.some(candidate => candidate.index === entry.index));
        const eligible = prepared.filter(entry => !entry.prepared.suppressed
          && (!entry.prepared.record || this.isCurrent(entry.target, entry.prepared.record)))
          .sort((left, right) => Number(Boolean(right.prepared.record)) - Number(Boolean(left.prepared.record))
            || left.index - right.index);
        return {
          eligible,
          ...(lastAdmitted ? { nextAdmissionCursor: (lastAdmitted.index + 1) % options.targets.length } : {}),
        };
      },
    });
  }

  begin(): VmRecoverySlotScope {
    const controller = new AbortController();
    const donationReason = Symbol('own-vm-slot-donation');
    const held = new Map<string, { slot: SlotState; generation: SlotGeneration; onAbort: () => void }>();
    const reservations = new Set<VmRecoverySlotAdmissionReservation>();
    let released = false;
    const detach = (key: string) => {
      const entry = held.get(key);
      if (!entry) return;
      held.delete(key);
      const { slot, generation, onAbort } = entry;
      generation.controller.signal.removeEventListener('abort', onAbort);
      generation.users--;
      if (generation.users === 0 && slot.generation === generation) slot.generation = undefined;
      this.prune(key, slot);
    };
    return {
      signal: controller.signal,
      track: targets => {
        if (released || controller.signal.aborted) return;
        for (const target of targets) {
          const key = vmRecoverySlotKey(target);
          const slot = this.observedSlot(target);
          if (controller.signal.aborted) {
            if (slot) this.prune(key, slot);
            break;
          }
          if (!slot) { controller.abort(); break; }
          if (held.has(key)) continue;
          const generation = slot.generation ??= { controller: new AbortController(), users: 0 };
          const onAbort = () => {
            const reason = generation.controller.signal.reason;
            detach(key);
            if (reason !== donationReason) controller.abort(reason);
          };
          held.set(key, { slot, generation, onAbort });
          generation.users++;
          generation.controller.signal.addEventListener('abort', onAbort, { once: true });
        }
      },
      reserveAdmission: (target, now) => {
        if (released || controller.signal.aborted) return { kind: 'deferred' };
        const result = this.reserveAdmission(target, now, donationReason);
        if (controller.signal.aborted) {
          if (result.kind === 'reserved') result.reservation.release();
          return { kind: 'deferred' };
        }
        if (result.kind !== 'reserved') return result;
        const inner = result.reservation;
        const reservation: VmRecoverySlotAdmissionReservation = {
          commit: params => {
            if (released || controller.signal.aborted) { inner.release(); return { kind: 'deferred' }; }
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
        for (const key of held.keys()) detach(key);
      },
    };
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

  private invalidateSlot(key: string, slot: SlotState, reason?: symbol): void {
    if (this.slots.get(key) !== slot) return;
    this.slots.delete(key);
    if (slot.reservation) this.releaseAdmission(slot.reservation.admission);
    slot.record = undefined;
    slot.generation?.controller.abort(reason);
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
