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
  release(): void;
}

export interface VmRecoverySlotPreparation {
  readonly record?: VmReconcileRotationRecord;
  readonly suppressed: boolean;
}

/** Owns retained proof records and active generations, including record-less recovery. */
export class VmRecoverySlotRegistry {
  private readonly slots = new Map<string, SlotGeneration>();
  private readonly retained = new Map<string, VmReconcileRotationRecord>();

  get recordCount(): number { return this.retained.size; }

  /** Detached state for diagnostics and tests; callers cannot mutate ownership. */
  snapshot(): ReadonlyMap<string, VmReconcileRotationRecord> {
    return new Map(this.retained);
  }

  /** @deprecated Use target-based APIs; this is a detached diagnostic snapshot. */
  get records(): ReadonlyMap<string, VmReconcileRotationRecord> { return this.snapshot(); }

  currentRecord(target: Target): VmReconcileRotationRecord | undefined {
    this.observe(target);
    const record = this.retained.get(vmRecoverySlotKey(target));
    return record?.fingerprint === vmRecoveryTargetFingerprint(target) ? record : undefined;
  }

  isCurrent(target: Target, record: VmReconcileRotationRecord): boolean {
    return this.currentRecord(target) === record;
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
      if ((countsByCg.get(entry[1].localCgId) ?? 0) > 1) return entry;
    }
    return undefined;
  }

  findReplacement(
    requestingCgId: string | undefined,
    now: number,
    maxEntries: number,
  ): VmReconcileRotationRecord | undefined {
    return this.findReplacementEntry(requestingCgId, now, maxEntries)?.[1];
  }

  /** Donation cancels the donor only after the requester owns its retained slot. */
  install(record: VmReconcileRotationRecord, now: number, maxEntries: number): boolean {
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

  createRecord(target: Target, params: {
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

  protected retainRecord(key: string, record: VmReconcileRotationRecord): void {
    this.retained.set(key, record);
  }

  begin(): VmRecoverySlotScope {
    const controller = new AbortController();
    const held = new Map<string, { generation: SlotGeneration; onAbort: () => void }>();
    let released = false;
    return {
      signal: controller.signal,
      track: targets => {
        if (released || controller.signal.aborted) return;
        for (const target of targets) {
          this.observe(target);
          if (controller.signal.aborted) break;
          const key = vmRecoverySlotKey(target);
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
      release: () => {
        if (released) return;
        released = true;
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
  private observe(target: Target): void {
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
