import { ethers } from 'ethers';
import type { KaNumberStore } from '@origintrail-official/dkg-core';

/**
 * OT-RFC-43 Option-1 deterministic KA identity — B2 author-number
 * ALLOCATOR CORE (OFF-CHAIN only).
 *
 * Locked design decisions:
 *   - The allocation namespace is the **attested author** address.
 *   - A KA's full id is packed as
 *       `kaId = (uint160(author) << 96) | uint96(number)`.
 *   - The underlying `KaNumberStore` keys by author address and owns
 *     the strictly-monotonic, never-reclaimed `number` half.
 *
 * This class is the thin domain wrapper around that store: it packs the
 * 160-bit author into the high bits and the per-author number into the
 * low 96 bits, all in `bigint` (NEVER `Number`, which would lose
 * precision well below 2^96). It also carries the RFC §4.5 cold-start
 * refusal guard: a node that has not run startup reconciliation against
 * observed on-chain state MUST refuse to allocate, lest it re-issue a
 * number the chain already minted under that author. The reconciliation
 * *oracle* (the actual chain reads that compute the floor) is wired at
 * the deferred T0 integration; here we only expose the flag + guard and
 * the `reconcile()` floor-bump.
 */

/** Width of the `number` field in the packed kaId (low bits). */
const NUMBER_BITS = 96n;
/** Mask selecting the low `NUMBER_BITS` of a kaId. */
const NUMBER_MASK = (1n << NUMBER_BITS) - 1n;
/** Author hex length (20 bytes => 40 hex chars), for unpack padding. */
const ADDRESS_HEX_CHARS = 40;

export interface KaAllocation {
  /** Packed `(uint160(author) << 96) | uint96(number)`. Always non-zero. */
  kaId: bigint;
  /** The per-author number just consumed (first allocation is 0). */
  number: number;
}

export class KaNumberAllocator {
  private readonly store: KaNumberStore;
  /**
   * RFC §4.5 cold-start refusal flag. Allocation is refused until a
   * caller has run startup reconciliation and called `markReconciled()`.
   * Starts `false` so a cold/just-restarted node cannot hand out a
   * number before it has reconciled its floor against the chain.
   */
  private reconciled = false;

  constructor(store: KaNumberStore) {
    this.store = store;
  }

  /**
   * Consume the next number for `authorAddress` and return it together
   * with the packed `kaId`. Throws if startup reconciliation has not
   * been performed (`assertReconciled`) or if the address is not a valid
   * 20-byte hex address.
   */
  allocate(authorAddress: string): KaAllocation {
    this.assertReconciled();
    const authorBits = KaNumberAllocator.authorToUint160(authorAddress);
    const number = this.store.allocate(authorAddress);
    const kaId = (authorBits << NUMBER_BITS) | BigInt(number);
    return { kaId, number };
  }

  /**
   * Raise the stored floor for `authorAddress` from an observed on-chain
   * state. `observedNumber` is the highest number already minted under
   * that author; the next allocation must therefore be at least
   * `observedNumber + 1`. Idempotent and monotonic (never lowers).
   */
  reconcile(authorAddress: string, observedNumber: number): void {
    // Validate the address shape here too so reconciliation rejects junk
    // before it can poison the floor.
    KaNumberAllocator.authorToUint160(authorAddress);
    this.store.reconcileFloor(authorAddress, observedNumber + 1);
  }

  /**
   * The `kaId` the next `allocate(authorAddress)` would produce, without
   * consuming it. Does NOT require reconciliation (read-only peek).
   */
  peekKaId(authorAddress: string): bigint {
    const authorBits = KaNumberAllocator.authorToUint160(authorAddress);
    const number = this.store.peekNext(authorAddress);
    return (authorBits << NUMBER_BITS) | BigInt(number);
  }

  /**
   * Mark this allocator as having completed startup reconciliation,
   * unblocking `allocate()`. Called once the (deferred) reconciliation
   * oracle has bumped every relevant author floor.
   */
  markReconciled(): void {
    this.reconciled = true;
  }

  /** Whether `markReconciled()` has been called. */
  isReconciled(): boolean {
    return this.reconciled;
  }

  /**
   * Throw unless startup reconciliation has run. The RFC §4.5 cold-start
   * refusal: a node MUST NOT allocate before it has reconciled its floor
   * against observed on-chain state.
   */
  assertReconciled(): void {
    if (!this.reconciled) {
      throw new Error(
        'KaNumberAllocator: refusing to allocate before startup reconciliation (RFC §4.5 cold-start refusal); call markReconciled() after reconciling author floors',
      );
    }
  }

  /**
   * Validate `authorAddress` is a 20-byte hex address and return its
   * 160-bit integer value. Uses `ethers.getAddress` to validate (it
   * throws on a malformed/checksum-invalid address); `BigInt(0x…)` then
   * yields the unsigned 160-bit value. NEVER uses `Number()`.
   */
  static authorToUint160(authorAddress: string): bigint {
    // getAddress throws on anything that is not a valid 20-byte address
    // (wrong length, non-hex, bad checksum casing). Re-wrap so the error
    // is attributable to this module.
    let checksummed: string;
    try {
      checksummed = ethers.getAddress(authorAddress);
    } catch {
      throw new Error(`KaNumberAllocator: invalid author address: ${authorAddress}`);
    }
    return BigInt(checksummed);
  }

  /**
   * Unpack a packed kaId back into its author + number components.
   * `author` is a lowercase `0x`-prefixed 40-hex-char address; `number`
   * is the low-96-bit value as a `bigint`. Mirrors the pack performed by
   * `allocate`.
   */
  static unpack(kaId: bigint): { author: string; number: bigint } {
    const authorBits = kaId >> NUMBER_BITS;
    const author = '0x' + authorBits.toString(16).padStart(ADDRESS_HEX_CHARS, '0');
    const number = kaId & NUMBER_MASK;
    return { author, number };
  }
}
