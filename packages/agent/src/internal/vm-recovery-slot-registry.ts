import type { OrdinalRecoveryTarget } from '../chain-reconciler.js';

type Target = Pick<OrdinalRecoveryTarget, 'localCgId' | 'onChainCgId' | 'ordinal' | 'ual' | 'merkleRoot'>;
type SlotLocator = Pick<Target, 'localCgId' | 'onChainCgId' | 'ordinal'>;

/** Process-local evidence owned by one chain-ordinal exact-recovery slot. */
export interface VmReconcileRotationRecord extends SlotLocator {
  fingerprint: string;
  phase: 'collecting' | 'backoff';
  backoffKind?: 'clean-absence' | 'incomplete-cycle';
  candidatePeerIds: Set<string>;
  attemptedPeerIds: Set<string>;
  cleanAbsentPeerIds: Set<string>;
  curatorRosterConfirmed: boolean;
  collectionDeadlineAt: number;
  lastAttemptedPeerId?: string;
  failures: number;
  nextRetryAt: number;
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
  record?: VmReconcileRotationRecord;
  generation?: SlotGeneration;
  reservation?: { readonly kind: 'requester' | 'donor'; readonly admission: SlotAdmission };
}

interface SlotAdmission {
  readonly key: string;
  readonly target: Target;
  readonly slot: SlotState;
  readonly donor?: { readonly key: string; readonly slot: SlotState; readonly record: VmReconcileRotationRecord };
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
    for (const [key, slot] of this.slots) if (slot.record) records.set(key, slot.record);
    return records;
  }

  /** Pure lookup: target observation/invalidation is an explicit command. */
  peekRecord(target: Target): VmReconcileRotationRecord | undefined {
    const slot = this.slots.get(vmRecoverySlotKey(target));
    return slot?.fingerprint === vmRecoveryTargetFingerprint(target) ? slot.record : undefined;
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
    if (slot.record) return { kind: 'existing', record: slot.record };
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
    let record: VmReconcileRotationRecord | undefined;
    let installed = false;
    let donorDetached = false;
    try {
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
      this.retainRecord(key, record);
      installed = this.slots.get(key) === slot && slot.record === record;
      return installed ? { kind: 'admitted', record } : { kind: 'deferred' };
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
    if (!slot || slot.record || slot.fingerprint !== record.fingerprint) {
      throw new Error('VM recovery slot changed before retention');
    }
    slot.record = record;
    this.slots.delete(key);
    this.slots.set(key, slot);
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
