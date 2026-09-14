// SPDX-License-Identifier: Apache-2.0

/** One occupied slot owned by the capacity component. */
interface VmRecoveryCapacityOwner {
  readonly localCgId: string;
  readonly ownerToken: symbol;
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
 * This component owns the incremental occupied-slot index. It asks the evidence
 * owner only whether a particular immutable owner token is expired, and never
 * reads evidence or cancels work itself.
 */
export class VmRecoverySlotCapacity {
  private readonly occupied = new Map<string, VmRecoveryCapacityOwner>();
  private readonly pending = new Map<string,
    | { readonly role: 'requester'; readonly admission: VmRecoveryPendingAdmission; readonly localCgId: string }
    | { readonly role: 'donor'; readonly admission: VmRecoveryPendingAdmission }>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('VM recovery slot capacity must be a positive safe integer');
    }
  }

  pendingAt(key: string): VmRecoveryPendingAdmission | undefined {
    return this.pending.get(key)?.admission;
  }

  get size(): number { return this.occupied.size; }

  /** Register a newly retained evidence owner. */
  acquire(key: string, localCgId: string, ownerToken: symbol): void {
    this.occupied.set(key, { localCgId, ownerToken });
  }

  /** Retire only the owner generation named by the caller. */
  retire(key: string, ownerToken: symbol): boolean {
    if (this.occupied.get(key)?.ownerToken !== ownerToken) return false;
    return this.occupied.delete(key);
  }

  /** Preserve the registry's least-recently-touched donor ordering. */
  touch(key: string, ownerToken: symbol): void {
    const owner = this.occupied.get(key);
    if (owner?.ownerToken !== ownerToken) return;
    this.occupied.delete(key);
    this.occupied.set(key, owner);
  }

  isActive(admission: VmRecoveryPendingAdmission): boolean {
    const requester = this.pending.get(admission.key);
    return requester?.role === 'requester' && requester.admission === admission;
  }

  /** Reserved donor evidence is immutable until its atomic donation commits or rolls back. */
  isReservedDonor(key: string): boolean {
    return this.pending.get(key)?.role === 'donor';
  }

  /** Count each reserved requester and exclude the donor it will replace. */
  private reservedOccupancy(): number {
    let count = 0;
    for (const key of this.occupied.keys()) if (this.pending.get(key)?.role !== 'donor') count++;
    for (const [key, pending] of this.pending) {
      if (pending.role === 'requester' && !this.occupied.has(key)) count++;
    }
    return count;
  }

  /**
   * Reserve capacity for `key`. At the bound, expired evidence donates its
   * slot; failing that, a graph holding no live slot may take one from a graph
   * holding several. Returns undefined when nothing can be reserved.
   */
  reserve(
    key: string,
    requestingCgId: string,
    isExpired: (key: string, ownerToken: symbol) => boolean,
  ): VmRecoveryPendingAdmission | undefined {
    if (this.pending.has(key)) return undefined;
    const occupied = this.reservedOccupancy();
    const donor = occupied < this.maxEntries ? undefined : this.findDonor(requestingCgId, isExpired);
    if (occupied >= this.maxEntries && !donor) return undefined;
    const admission: VmRecoveryPendingAdmission = { key, donor };
    this.pending.set(key, { role: 'requester', admission, localCgId: requestingCgId });
    if (donor) this.pending.set(donor.key, { role: 'donor', admission });
    return admission;
  }

  private findDonor(
    requestingCgId: string,
    isExpired: (key: string, ownerToken: symbol) => boolean,
  ): VmRecoveryPendingAdmission['donor'] {
    const countsByCg = new Map<string, number>();
    for (const [key, owner] of this.occupied) {
      if (this.pending.get(key)?.role !== 'donor') {
        countsByCg.set(owner.localCgId, (countsByCg.get(owner.localCgId) ?? 0) + 1);
      }
      if (this.pending.has(key) || !isExpired(key, owner.ownerToken)) continue;
      return { key, ownerToken: owner.ownerToken };
    }
    for (const [key, pending] of this.pending) {
      if (pending.role === 'requester' && !this.occupied.has(key)) {
        countsByCg.set(pending.localCgId, (countsByCg.get(pending.localCgId) ?? 0) + 1);
      }
    }
    if (!requestingCgId || (countsByCg.get(requestingCgId) ?? 0) !== 0) return undefined;
    for (const [key, owner] of this.occupied) {
      if (!this.pending.has(key) && (countsByCg.get(owner.localCgId) ?? 0) > 1) {
        return { key, ownerToken: owner.ownerToken };
      }
    }
    return undefined;
  }

  /** Atomically transfer a reservation's capacity ownership to its requester. */
  commit(
    admission: VmRecoveryPendingAdmission,
    owner: VmRecoveryCapacityOwner,
  ): boolean {
    if (!this.isActive(admission) || this.occupied.has(admission.key)) return false;
    if (admission.donor
      && this.occupied.get(admission.donor.key)?.ownerToken !== admission.donor.ownerToken) return false;
    if (admission.donor) this.occupied.delete(admission.donor.key);
    this.acquire(admission.key, owner.localCgId, owner.ownerToken);
    return true;
  }

  /** Release one admission; returns the keys it no longer reserves. */
  release(admission: VmRecoveryPendingAdmission): string[] {
    if (!this.isActive(admission)) return [];
    this.pending.delete(admission.key);
    const released = [admission.key];
    if (admission.donor) {
      const donor = this.pending.get(admission.donor.key);
      if (donor?.role === 'donor' && donor.admission === admission) {
        this.pending.delete(admission.donor.key);
        released.push(admission.donor.key);
      }
    }
    return released;
  }
}
