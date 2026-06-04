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
  /**
   * The per-author number just consumed (first allocation is `0n`).
   * `bigint` end-to-end (codex PR #976 F6) so the counter stays exact
   * past `Number.MAX_SAFE_INTEGER`; the on-chain field is `uint96` and
   * the store backs it with a SQLite signed INTEGER (`2^63 - 1` cap).
   */
  number: bigint;
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
   * been performed (`assertReconciled`), if the address is not a valid
   * 20-byte hex address, or if it is the zero address (codex PR #976
   * F7 — `(0n << 96) | 0n === 0n`, which collides with the poller's
   * "no kaId" sentinel and violates the `KaAllocation.kaId` non-zero
   * contract).
   *
   * The address is canonicalized to the validated lowercase form
   * (codex PR #976 F8) BEFORE being passed to the store, so any
   * `KaNumberStore` implementation receives a single canonical key
   * regardless of caller casing. Without this, `0xAbc…` vs `0xabc…`
   * would fork the sequence in a store that forgot to lowercase its
   * own key, producing duplicate low-96 counters under the same
   * on-chain author.
   */
  allocate(authorAddress: string): KaAllocation {
    this.assertReconciled();
    const canonical = KaNumberAllocator.canonicalizeAuthor(authorAddress);
    const authorBits = BigInt(canonical);
    // `number` is a `bigint` straight off the store (codex PR #976 F6) —
    // no `BigInt()` round-trip, no chance of a stray `Number()` cast at
    // the call site silently truncating a counter past 2^53.
    const number = this.store.allocate(canonical);
    const kaId = (authorBits << NUMBER_BITS) | number;
    return { kaId, number };
  }

  /**
   * Raise the stored floor for `authorAddress` from an observed on-chain
   * state. `observedNumber` is the highest number already minted under
   * that author; the next allocation must therefore be at least
   * `observedNumber + 1n`. Idempotent and monotonic (never lowers).
   *
   * `observedNumber` is a `bigint` (codex PR #976 F6) — the chain reads
   * that compute it (`kaId & ((1n<<96n)-1n)`) already produce bigint;
   * accepting `number` here would force a precision-losing cast at the
   * caller. The address is canonicalized before being passed to the
   * store (codex PR #976 F8) to keep the per-author key stable across
   * casing variants.
   */
  reconcile(authorAddress: string, observedNumber: bigint): void {
    const canonical = KaNumberAllocator.canonicalizeAuthor(authorAddress);
    this.store.reconcileFloor(canonical, observedNumber + 1n);
  }

  /**
   * The `kaId` the next `allocate(authorAddress)` would produce, without
   * consuming it. Does NOT require reconciliation (read-only peek). The
   * address is canonicalized (codex PR #976 F8) so peek + allocate
   * cannot disagree under mixed casing.
   */
  peekKaId(authorAddress: string): bigint {
    const canonical = KaNumberAllocator.canonicalizeAuthor(authorAddress);
    const authorBits = BigInt(canonical);
    const number = this.store.peekNext(canonical);
    return (authorBits << NUMBER_BITS) | number;
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
   *
   * Rejects the zero address (codex PR #976 F7) — see
   * `canonicalizeAuthor()` for the rationale.
   */
  static authorToUint160(authorAddress: string): bigint {
    return BigInt(KaNumberAllocator.canonicalizeAuthor(authorAddress));
  }

  /**
   * Validate `authorAddress` and return its canonical lowercase
   * `0x`-prefixed 42-char form. This is the single normalization point
   * the allocator uses before talking to the store, so any
   * `KaNumberStore` implementation receives one canonical key per
   * on-chain author regardless of caller casing (codex PR #976 F8).
   *
   * Rejects:
   *   - Anything `ethers.getAddress()` rejects (wrong length, non-hex,
   *     bad checksum casing).
   *   - The zero address `0x0000…0000` (codex PR #976 F7). Allocating
   *     under the zero address would yield `kaId = 0n`, which both
   *     violates the `KaAllocation.kaId` non-zero contract and collides
   *     with the poller's "no kaId" sentinel (see
   *     `chain-event-poller.ts::handleKACreated`'s `if (kaId === 0n)
   *     return`).
   */
  static canonicalizeAuthor(authorAddress: string): string {
    let checksummed: string;
    try {
      checksummed = ethers.getAddress(authorAddress);
    } catch {
      throw new Error(`KaNumberAllocator: invalid author address: ${authorAddress}`);
    }
    if (checksummed === ethers.ZeroAddress) {
      throw new Error(
        'KaNumberAllocator: refusing to allocate under the zero address (kaId=0n collides with the poller "no kaId" sentinel and violates the KaAllocation non-zero contract)',
      );
    }
    return checksummed.toLowerCase();
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
