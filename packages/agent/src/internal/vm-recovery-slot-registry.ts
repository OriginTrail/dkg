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

export function vmRecoverySlotKey(target: Pick<Target, 'localCgId' | 'onChainCgId' | 'ordinal'>): string {
  return `${target.localCgId}\0${target.onChainCgId}\0${target.ordinal}`;
}

export function vmRecoveryTargetFingerprint(target: Pick<Target, 'ual' | 'merkleRoot'>): string {
  return `${target.ual}\0${target.merkleRoot.toLowerCase()}`;
}

interface SlotGeneration {
  readonly localCgId: string;
  readonly fingerprint: string;
  readonly controller: AbortController;
  users: number;
}

export interface VmRecoverySlotScope {
  readonly signal: AbortSignal;
  /** Attach selected targets before discovery and after preparation, including unowned fallback targets. */
  track(targets: readonly Target[]): void;
  reserveAdmission(target: Target, now: number, maxEntries: number): VmRecoverySlotReservation;
  release(): void;
}

export type VmRecoverySlotAdmission =
  | { readonly kind: 'existing'; readonly record: VmReconcileRotationRecord }
  | { readonly kind: 'admitted'; readonly record: VmReconcileRotationRecord }
  | { readonly kind: 'deferred' };

export interface VmRecoverySlotAdmissionReservation {
  commit(params: {
    readonly candidatePeerIds: readonly string[];
    readonly curatorRosterConfirmed: boolean;
    readonly collectionDeadlineAt: number;
  }): VmRecoverySlotAdmission;
  release(): void;
}

export type VmRecoverySlotReservation =
  | { readonly kind: 'existing'; readonly record: VmReconcileRotationRecord }
  | { readonly kind: 'reserved'; readonly reservation: VmRecoverySlotAdmissionReservation }
  | { readonly kind: 'deferred' };

type InternalVmRecoverySlotReservation = VmRecoverySlotReservation & {
  /** Registry-only ownership detail used to avoid observing our own donor. */
  readonly donorKey?: string;
};

/** Owns retained proof records and active generations, including record-less recovery. */
export class VmRecoverySlotRegistry {
  private readonly slots = new Map<string, SlotGeneration>();
  private readonly retained = new Map<string, VmReconcileRotationRecord>();
  private readonly reservedDonorKeys = new Set<string>();
  private openCapacityReservations = 0;

  get recordCount(): number { return this.retained.size; }

  /** Detached state for diagnostics and tests; callers cannot mutate ownership. */
  snapshot(): ReadonlyMap<string, VmReconcileRotationRecord> {
    return new Map(this.retained);
  }

  /** Pure lookup: target observation/invalidation is an explicit command. */
  peekRecord(target: Target): VmReconcileRotationRecord | undefined {
    const record = this.retained.get(vmRecoverySlotKey(target));
    return record?.fingerprint === vmRecoveryTargetFingerprint(target) ? record : undefined;
  }

  isCurrent(target: Target, record: VmReconcileRotationRecord): boolean {
    return this.peekRecord(target) === record;
  }

  /** Successful ordinal completion retires evidence without aborting its shared batch. */
  complete(target: SlotLocator): void { this.retained.delete(vmRecoverySlotKey(target)); }

  touch(target: Target, record: VmReconcileRotationRecord): void {
    const key = vmRecoverySlotKey(target);
    if (record.fingerprint !== vmRecoveryTargetFingerprint(target)) return;
    if (this.retained.get(key) !== record) return;
    this.retained.delete(key);
    this.retained.set(key, record);
  }

  private findReplacementEntry(
    requestingCgId: string | undefined,
    now: number,
    maxEntries: number,
  ): [string, VmReconcileRotationRecord] | undefined {
    if (this.retained.size < maxEntries) return undefined;
    for (const entry of this.retained) {
      if (this.reservedDonorKeys.has(entry[0])) continue;
      const [, record] = entry;
      if ((record.phase === 'backoff' && now < record.nextRetryAt)
        || (record.phase === 'collecting' && now < record.collectionDeadlineAt)) continue;
      return entry;
    }
    if (!requestingCgId) return undefined;
    const countsByCg = new Map<string, number>();
    for (const record of this.retained.values()) {
      countsByCg.set(record.localCgId, (countsByCg.get(record.localCgId) ?? 0) + 1);
    }
    if ((countsByCg.get(requestingCgId) ?? 0) !== 0) return undefined;
    for (const entry of this.retained) {
      if (this.reservedDonorKeys.has(entry[0])) continue;
      if ((countsByCg.get(entry[1].localCgId) ?? 0) > 1) return entry;
    }
    return undefined;
  }

  /** Donation cancels the donor only after the requester owns its retained slot. */
  private install(record: VmReconcileRotationRecord, now: number, maxEntries: number): boolean {
    const key = vmRecoverySlotKey(record);
    if (this.retained.has(key)) return false;
    const replacement = this.findReplacementEntry(record.localCgId, now, maxEntries);
    if (!replacement) {
      if (this.retained.size >= maxEntries) return false;
      this.retainRecord(key, record);
      return this.retained.get(key) === record;
    }
    const [donorKey, donor] = replacement;
    let installed = false;
    this.retained.delete(donorKey);
    try {
      this.retainRecord(key, record);
      installed = this.retained.get(key) === record;
      return installed;
    } finally {
      if (installed) this.invalidateKey(donorKey);
      else if (!this.retained.has(donorKey)) this.retainRecord(donorKey, donor);
    }
  }

  private createRecord(target: Target, params: {
    readonly candidatePeerIds: readonly string[];
    readonly curatorRosterConfirmed: boolean;
    readonly collectionDeadlineAt: number;
  }): VmReconcileRotationRecord {
    return {
      localCgId: target.localCgId,
      onChainCgId: target.onChainCgId,
      ordinal: target.ordinal,
      fingerprint: vmRecoveryTargetFingerprint(target),
      phase: 'collecting',
      candidatePeerIds: new Set(params.candidatePeerIds),
      attemptedPeerIds: new Set(),
      cleanAbsentPeerIds: new Set(),
      curatorRosterConfirmed: params.curatorRosterConfirmed,
      collectionDeadlineAt: params.collectionDeadlineAt,
      failures: 0,
      nextRetryAt: 0,
    };
  }

  /**
   * Observe a target and atomically admit its proof record, including any
   * fair donor replacement. The host never sees capacity or donor internals.
   */
  admit(target: Target, params: {
    readonly candidatePeerIds: readonly string[];
    readonly curatorRosterConfirmed: boolean;
    readonly collectionDeadlineAt: number;
  }, now: number, maxEntries: number): VmRecoverySlotAdmission {
    this.observeTarget(target);
    const existing = this.peekRecord(target);
    if (existing) return { kind: 'existing', record: existing };
    const record = this.createRecord(target, params);
    return this.install(record, now, maxEntries)
      ? { kind: 'admitted', record }
      : { kind: 'deferred' };
  }

  private reserveAdmission(
    target: Target,
    now: number,
    maxEntries: number,
  ): InternalVmRecoverySlotReservation {
    this.observeTarget(target);
    const existing = this.peekRecord(target);
    if (existing) return { kind: 'existing', record: existing };

    const targetKey = vmRecoverySlotKey(target);
    const targetFingerprint = vmRecoveryTargetFingerprint(target);
    const hasOpenCapacity = this.retained.size + this.openCapacityReservations < maxEntries;
    const donorEntry = hasOpenCapacity
      ? undefined
      : this.findReplacementEntry(target.localCgId, now, maxEntries);
    if (!hasOpenCapacity && !donorEntry) return { kind: 'deferred' };
    if (donorEntry) this.reservedDonorKeys.add(donorEntry[0]);
    else this.openCapacityReservations += 1;

    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      if (donorEntry) this.reservedDonorKeys.delete(donorEntry[0]);
      else this.openCapacityReservations -= 1;
    };
    const reservation: VmRecoverySlotAdmissionReservation = {
      release,
      commit: (params) => {
        if (!active) return { kind: 'deferred' };
        const concurrentlyInstalled = this.peekRecord(target);
        if (concurrentlyInstalled) {
          release();
          return { kind: 'existing', record: concurrentlyInstalled };
        }
        // A replacement fingerprint observed while discovery was pending owns
        // a different lifecycle; this reservation cannot install into it.
        if (vmRecoveryTargetFingerprint(target) !== targetFingerprint) {
          release();
          return { kind: 'deferred' };
        }
        const record = this.createRecord(target, params);
        if (!donorEntry) {
          if (this.retained.size >= maxEntries || this.retained.has(targetKey)) {
            release();
            return { kind: 'deferred' };
          }
          try {
            this.retainRecord(targetKey, record);
            release();
            return { kind: 'admitted', record };
          } catch (error) {
            release();
            throw error;
          }
        }

        const [donorKey, donor] = donorEntry;
        if (this.retained.get(donorKey) !== donor || this.retained.has(targetKey)) {
          release();
          return { kind: 'deferred' };
        }
        let installed = false;
        this.retained.delete(donorKey);
        try {
          this.retainRecord(targetKey, record);
          installed = this.retained.get(targetKey) === record;
          if (!installed) return { kind: 'deferred' };
          return { kind: 'admitted', record };
        } finally {
          release();
          if (installed) this.invalidateKey(donorKey);
          else if (!this.retained.has(donorKey)) this.retainRecord(donorKey, donor);
        }
      },
    };
    return { kind: 'reserved', reservation, donorKey: donorEntry?.[0] };
  }

  protected retainRecord(key: string, record: VmReconcileRotationRecord): void {
    this.retained.set(key, record);
  }

  begin(): VmRecoverySlotScope {
    const controller = new AbortController();
    const held = new Map<string, { generation: SlotGeneration; onAbort: () => void }>();
    const reservations = new Set<VmRecoverySlotAdmissionReservation>();
    const pendingDonorKeys = new Set<string>();
    let released = false;
    return {
      signal: controller.signal,
      track: targets => {
        if (released || controller.signal.aborted) return;
        for (const target of targets) {
          this.observeTarget(target);
          if (controller.signal.aborted) break;
          const key = vmRecoverySlotKey(target);
          // A donor reserved by this scope remains valid while discovery is in
          // flight, but its eventual replacement is an intentional local
          // transition rather than a reason to cancel the admitting batch.
          if (pendingDonorKeys.has(key)) continue;
          if (held.has(key)) continue;
          let generation = this.slots.get(key);
          if (!generation) {
            generation = {
              localCgId: target.localCgId,
              fingerprint: vmRecoveryTargetFingerprint(target),
              controller: new AbortController(), users: 0,
            };
            this.slots.set(key, generation);
          }
          const retained = generation;
          const onAbort = () => controller.abort(retained.controller.signal.reason);
          held.set(key, { generation, onAbort });
          generation.users++;
          generation.controller.signal.addEventListener('abort', onAbort, { once: true });
        }
      },
      reserveAdmission: (target, now, maxEntries) => {
        if (released || controller.signal.aborted) return { kind: 'deferred' };
        const result = this.reserveAdmission(target, now, maxEntries);
        if (result.kind !== 'reserved') return result;
        const donorKey = result.donorKey;
        if (donorKey) pendingDonorKeys.add(donorKey);
        const inner = result.reservation;
        const reservation: VmRecoverySlotAdmissionReservation = {
          commit: params => {
            try {
              return inner.commit(params);
            } finally {
              if (donorKey) pendingDonorKeys.delete(donorKey);
            }
          },
          release: () => {
            try {
              inner.release();
            } finally {
              if (donorKey) pendingDonorKeys.delete(donorKey);
            }
          },
        };
        reservations.add(reservation);
        return { kind: 'reserved', reservation };
      },
      release: () => {
        if (released) return;
        released = true;
        for (const reservation of reservations) reservation.release();
        reservations.clear();
        pendingDonorKeys.clear();
        for (const [key, { generation, onAbort }] of held) {
          generation.controller.signal.removeEventListener('abort', onAbort);
          generation.users--;
          if (generation.users === 0 && this.slots.get(key) === generation) this.slots.delete(key);
        }
        held.clear();
      },
    };
  }

  /** Observing a replacement fingerprint invalidates only the superseded generation. */
  observeTarget(target: Target): void {
    const key = vmRecoverySlotKey(target);
    const generation = this.slots.get(key);
    const record = this.retained.get(key);
    const fingerprint = vmRecoveryTargetFingerprint(target);
    if ((generation && generation.fingerprint !== fingerprint)
      || (record && record.fingerprint !== fingerprint)) this.invalidateKey(key);
  }

  invalidate(target: SlotLocator): void {
    this.invalidateKey(vmRecoverySlotKey(target));
  }

  private invalidateKey(key: string): void {
    this.retained.delete(key);
    const generation = this.slots.get(key);
    if (!generation) return;
    this.slots.delete(key);
    generation.controller.abort();
  }

  invalidateContextGraph(localCgId: string): void {
    for (const [key, record] of this.retained) {
      if (record.localCgId === localCgId) this.retained.delete(key);
    }
    // Abort listeners run synchronously and can acquire a new generation.
    const generations = [...this.slots];
    for (const [key, generation] of generations) {
      if (generation.localCgId === localCgId) this.invalidateKey(key);
    }
  }

  close(): void {
    this.retained.clear();
    const keys = [...this.slots.keys()];
    for (const key of keys) this.invalidateKey(key);
  }
}
