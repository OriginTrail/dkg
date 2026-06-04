/**
 * OT-RFC-43 Option-1 (variant 1a) — test-side KA-number allocator.
 *
 * The real EVM adapter now REQUIRES a packed
 *   reservedKaId = (uint160(author) << 96) | number
 * for every V10 mint. `DKGPublisher` only allocates one when a `kaAllocator`
 * is configured (DKGPublisherConfig.kaAllocator); otherwise it passes
 * `reservedKaId: undefined` and the real adapter throws "reservedKaId is
 * required". Real-chain publisher tests therefore must wire an allocator.
 *
 * This is a dependency-light, in-memory implementation of the structural
 * `KaIdAllocator` interface that `DKGPublisher` consumes (it lives in
 * dkg-publisher; the concrete `KaNumberAllocator` lives in dkg-agent, which
 * publisher does NOT depend on — so we reimplement the tiny contract here).
 *
 * The publisher itself calls `reconcile(author, chainMax)` then
 * `markReconciled()` then `allocate(author)` on first use per author per
 * process (see DKGPublisher.ensureReservedKaId), so the allocator only needs
 * to honor the monotonic-per-author + floor-raise contract. A FRESH allocator
 * per publisher keeps state from leaking across snapshot/revert boundaries.
 */

const NUMBER_BITS = 96n;

import { ethers } from 'ethers';

export interface KaIdAllocator {
  allocate(author: string): { kaId: bigint; number: bigint };
  reconcile(author: string, observedNumber: bigint): void;
  markReconciled(): void;
}

/**
 * In-memory KA-number allocator satisfying the `KaIdAllocator` structural
 * contract: per-author numbers are strictly monotonic from 0 and never
 * reclaimed; `reconcile` raises the floor but never lowers it; the packed
 * `kaId = (uint160(author) << 96) | number` is computed entirely in bigint.
 */
export class InMemoryKaIdAllocator implements KaIdAllocator {
  private readonly next = new Map<string, bigint>();
  private reconciled = false;

  allocate(author: string): { kaId: bigint; number: bigint } {
    if (!this.reconciled) {
      throw new Error('InMemoryKaIdAllocator: allocate() before markReconciled()');
    }
    const key = author.toLowerCase();
    const number = this.next.get(key) ?? 0n;
    this.next.set(key, number + 1n);
    const authorBits = BigInt(ethers.getAddress(author));
    const kaId = (authorBits << NUMBER_BITS) | number;
    return { kaId, number };
  }

  reconcile(author: string, observedNumber: bigint): void {
    const key = author.toLowerCase();
    const current = this.next.get(key) ?? 0n;
    // observedNumber is the highest already-minted number; the floor is +1.
    // bigint end-to-end (PR #976 F6) — no `Math.max` (mixes bigint/number).
    const floor = observedNumber + 1n;
    this.next.set(key, current > floor ? current : floor);
  }

  markReconciled(): void {
    this.reconciled = true;
  }
}

/** Convenience factory used by the real-chain publisher test constructions. */
export function makeTestKaAllocator(): KaIdAllocator {
  return new InMemoryKaIdAllocator();
}
