// SPDX-License-Identifier: Apache-2.0

/**
 * Cancellation lifetimes for active VM recovery slots.
 *
 * A generation is one active slot lifecycle. A lease is one batch's
 * subscription to every generation it tracks; ending a generation cancels its
 * leases. A donation names the requesting lease explicitly, so that lease is
 * detached without cancellation. The abort reason stays a plain cancellation
 * cause and never carries control information. Neither type knows about
 * retained evidence or capacity.
 */
export class VmRecoverySlotGeneration {
  private readonly leases = new Set<VmRecoverySlotLease>();

  constructor(readonly key: string) {}

  get idle(): boolean {
    return this.leases.size === 0;
  }

  /** Membership is owned by the lease; see VmRecoverySlotLease.attach. */
  subscribe(lease: VmRecoverySlotLease): void {
    this.leases.add(lease);
  }

  /** Membership is owned by the lease; see VmRecoverySlotLease.detach. */
  unsubscribe(lease: VmRecoverySlotLease): void {
    this.leases.delete(lease);
  }

  /**
   * End this generation. Every lease is detached, and every lease except the
   * donation's requesting lease is canceled. Abort listeners may start
   * replacement lifecycles synchronously; they never rejoin this generation.
   */
  end(exempt?: VmRecoverySlotLease): void {
    // Detaching mutates the subscription set, so cancel from a stable copy.
    const leases = [...this.leases];
    for (const lease of leases) {
      lease.detach(this);
      if (lease !== exempt) lease.cancel();
    }
  }
}

export class VmRecoverySlotLease {
  private readonly controller = new AbortController();
  private readonly generations = new Map<string, VmRecoverySlotGeneration>();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Subscribe to one generation; attaching the same slot twice is a no-op. */
  attach(generation: VmRecoverySlotGeneration): void {
    if (this.generations.has(generation.key)) return;
    this.generations.set(generation.key, generation);
    generation.subscribe(this);
  }

  detach(generation: VmRecoverySlotGeneration): void {
    if (this.generations.get(generation.key) !== generation) return;
    this.generations.delete(generation.key);
    generation.unsubscribe(this);
  }

  /** Leave every generation without cancellation; returns them so idle ones can be retired. */
  detachAll(): VmRecoverySlotGeneration[] {
    const detached = [...this.generations.values()];
    for (const generation of detached) this.detach(generation);
    return detached;
  }

  cancel(): void {
    this.controller.abort();
  }
}
