// SPDX-License-Identifier: Apache-2.0

import { isRotationExpired, type VmRecoveryRotationRecord } from './vm-recovery-rotation-evidence.js';
import type { VmRecoverySlotLease } from './vm-recovery-slot-lifetimes.js';

/** The facet of a slot that capacity accounting reads. */
export interface VmRecoveryCapacitySlot {
  readonly localCgId: string;
  readonly record?: VmRecoveryRotationRecord;
}

/** One requester waiting for capacity, optionally backed by the donor it will replace. */
export interface VmRecoveryPendingAdmission {
  readonly key: string;
  readonly donor?: { readonly key: string; readonly record: VmRecoveryRotationRecord };
  /** The requesting lease: its own successful donation detaches it instead of canceling it. */
  readonly exempt?: VmRecoverySlotLease;
}

/**
 * Bounded capacity and fair donor reservations. A reservation counts toward
 * capacity across asynchronous discovery, so concurrent batches cannot
 * over-admit; a reserved donor keeps its evidence until the requester commits.
 * The store reads evidence only for expiry and never cancels anything.
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
    return role === 'requester' || (slot.record !== undefined && role !== 'donor');
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
    now: number,
    exempt?: VmRecoverySlotLease,
  ): VmRecoveryPendingAdmission | undefined {
    if (this.pending.has(key)) return undefined;
    let occupied = 0;
    for (const [slotKey, slot] of slots) if (this.ownsCapacity(slotKey, slot)) occupied++;
    const donor = occupied < this.maxEntries ? undefined : this.findDonor(slots, requestingCgId, now);
    if (occupied >= this.maxEntries && !donor) return undefined;
    const admission: VmRecoveryPendingAdmission = { key, donor, exempt };
    this.live.add(admission);
    this.pending.set(key, { role: 'requester', admission });
    if (donor) this.pending.set(donor.key, { role: 'donor', admission });
    return admission;
  }

  private findDonor(
    slots: ReadonlyMap<string, VmRecoveryCapacitySlot>,
    requestingCgId: string,
    now: number,
  ): VmRecoveryPendingAdmission['donor'] {
    const countsByCg = new Map<string, number>();
    for (const [key, slot] of slots) {
      if (this.ownsCapacity(key, slot)) countsByCg.set(slot.localCgId, (countsByCg.get(slot.localCgId) ?? 0) + 1);
      const record = slot.record;
      if (!record || this.pending.has(key) || !isRotationExpired(record, now)) continue;
      return { key, record };
    }
    if (!requestingCgId || (countsByCg.get(requestingCgId) ?? 0) !== 0) return undefined;
    for (const [key, slot] of slots) {
      if (slot.record && !this.pending.has(key) && (countsByCg.get(slot.localCgId) ?? 0) > 1) {
        return { key, record: slot.record };
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
