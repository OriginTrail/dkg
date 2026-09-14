// SPDX-License-Identifier: Apache-2.0

/** The facet of a slot that capacity accounting reads. */
export interface VmRecoveryCapacitySlot {
  readonly localCgId: string;
  readonly ownerToken?: symbol;
  readonly expired: boolean;
}

/** One requester waiting for capacity, optionally backed by the donor it will replace. */
export interface VmRecoveryPendingAdmission {
  readonly key: string;
  readonly donor?: { readonly key: string; readonly ownerToken: symbol };
}

/**
 * Bounded capacity and fair donor reservations. A reservation counts toward
 * capacity across asynchronous discovery, so concurrent batches cannot
 * over-admit; a reserved donor keeps its evidence until the requester commits.
 * The store sees only immutable ownership projections and never reads evidence
 * or cancels anything.
 */
export class VmRecoverySlotCapacity {
  private readonly live = new Set<VmRecoveryPendingAdmission>();
  private readonly pending = new Map<string, {
    readonly role: 'requester' | 'donor';
    readonly admission: VmRecoveryPendingAdmission;
  }>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('VM recovery slot capacity must be a positive safe integer');
    }
  }

  pendingAt(key: string): VmRecoveryPendingAdmission | undefined {
    return this.pending.get(key)?.admission;
  }

  isActive(admission: VmRecoveryPendingAdmission): boolean {
    return this.live.has(admission);
  }

  /** Reserved donor evidence is immutable until its atomic donation commits or rolls back. */
  isReservedDonor(key: string): boolean {
    return this.pending.get(key)?.role === 'donor';
  }

  /** Count the requester that will own reserved capacity, not its departing donor. */
  private ownsCapacity(key: string, slot: VmRecoveryCapacitySlot): boolean {
    const role = this.pending.get(key)?.role;
    return role === 'requester' || (slot.ownerToken !== undefined && role !== 'donor');
  }

  /**
   * Reserve capacity for `key`. At the bound, expired evidence donates its
   * slot; failing that, a graph holding no live slot may take one from a graph
   * holding several. Returns undefined when nothing can be reserved.
   */
  reserve(
    key: string,
    requestingCgId: string,
    slots: ReadonlyMap<string, VmRecoveryCapacitySlot>,
  ): VmRecoveryPendingAdmission | undefined {
    if (this.pending.has(key)) return undefined;
    let occupied = 0;
    for (const [slotKey, slot] of slots) if (this.ownsCapacity(slotKey, slot)) occupied++;
    const donor = occupied < this.maxEntries ? undefined : this.findDonor(slots, requestingCgId);
    if (occupied >= this.maxEntries && !donor) return undefined;
    const admission: VmRecoveryPendingAdmission = { key, donor };
    this.live.add(admission);
    this.pending.set(key, { role: 'requester', admission });
    if (donor) this.pending.set(donor.key, { role: 'donor', admission });
    return admission;
  }

  private findDonor(
    slots: ReadonlyMap<string, VmRecoveryCapacitySlot>,
    requestingCgId: string,
  ): VmRecoveryPendingAdmission['donor'] {
    const countsByCg = new Map<string, number>();
    for (const [key, slot] of slots) {
      if (this.ownsCapacity(key, slot)) countsByCg.set(slot.localCgId, (countsByCg.get(slot.localCgId) ?? 0) + 1);
      if (!slot.ownerToken || this.pending.has(key) || !slot.expired) continue;
      return { key, ownerToken: slot.ownerToken };
    }
    if (!requestingCgId || (countsByCg.get(requestingCgId) ?? 0) !== 0) return undefined;
    for (const [key, slot] of slots) {
      if (slot.ownerToken && !this.pending.has(key) && (countsByCg.get(slot.localCgId) ?? 0) > 1) {
        return { key, ownerToken: slot.ownerToken };
      }
    }
    return undefined;
  }

  /** Release one admission; returns the keys it no longer reserves. */
  release(admission: VmRecoveryPendingAdmission): string[] {
    if (!this.live.delete(admission)) return [];
    const released: string[] = [];
    for (const key of [admission.key, admission.donor?.key]) {
      if (key === undefined || this.pending.get(key)?.admission !== admission) continue;
      this.pending.delete(key);
      released.push(key);
    }
    return released;
  }
}
