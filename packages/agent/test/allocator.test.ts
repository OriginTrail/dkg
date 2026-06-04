import { describe, it, expect, beforeEach } from 'vitest';
import type { KaNumberStore } from '@origintrail-official/dkg-core';
import { KaNumberAllocator } from '../src/allocator.js';

/**
 * OT-RFC-43 Option-1 deterministic KA identity — B2 allocator core.
 *
 * These pin the allocator invariants the RFC calls load-bearing:
 *   - per-author numbers are strictly monotonic from 0 and never reclaimed,
 *     including across allocator instances that share one durable store;
 *   - `reconcileFloor` only ever raises the next-number, never lowers it;
 *   - `kaId = (uint160(author) << 96) | uint96(number)` packs/unpacks
 *     round-trip, is computed in bigint, and is always non-zero;
 *   - a cold (un-reconciled) allocator refuses to allocate (RFC §4.5).
 *
 * `SqliteKaNumberStore` lives in `@origintrail-official/dkg-node-ui`, which
 * the agent package does not depend on, so the store's SQL is exercised by
 * a faithful in-memory `KaNumberStore` here (same atomic monotonic contract:
 * `next_number` starts at the floor, `allocate` returns then increments).
 * The DB-backed store gets its own test against the existing DashboardDB
 * harness in node-ui (see open issue).
 */

/**
 * In-memory `KaNumberStore` matching the `SqliteKaNumberStore` contract:
 * keyed by lowercased author, `next_number` is the value to hand out next,
 * `allocate` returns the current value then increments, `reconcileFloor`
 * raises but never lowers.
 */
class InMemoryKaNumberStore implements KaNumberStore {
  private readonly next = new Map<string, number>();

  allocate(authorAddress: string): number {
    const key = authorAddress.toLowerCase();
    const current = this.next.get(key) ?? 0;
    this.next.set(key, current + 1);
    return current;
  }

  reconcileFloor(authorAddress: string, nextNumberFloor: number): void {
    const key = authorAddress.toLowerCase();
    const current = this.next.get(key) ?? 0;
    this.next.set(key, Math.max(current, nextNumberFloor));
  }

  peekNext(authorAddress: string): number {
    return this.next.get(authorAddress.toLowerCase()) ?? 0;
  }
}

// Two distinct, valid checksummed 20-byte addresses.
const AUTHOR_A = '0x52908400098527886E0F7030069857D2E4169EE7';
const AUTHOR_B = '0xde709f2102306220921060314715629080e2fb77';
const NUMBER_MASK = (1n << 96n) - 1n;

let store: InMemoryKaNumberStore;
let alloc: KaNumberAllocator;

beforeEach(() => {
  store = new InMemoryKaNumberStore();
  alloc = new KaNumberAllocator(store);
  alloc.markReconciled();
});

describe('KaNumberAllocator — cold-start refusal (RFC §4.5)', () => {
  it('refuses to allocate before reconciliation', () => {
    const cold = new KaNumberAllocator(new InMemoryKaNumberStore());
    expect(() => cold.allocate(AUTHOR_A)).toThrow(/cold-start refusal/);
    expect(cold.isReconciled()).toBe(false);
  });

  it('allocates after markReconciled()', () => {
    const warm = new KaNumberAllocator(new InMemoryKaNumberStore());
    expect(warm.isReconciled()).toBe(false);
    warm.markReconciled();
    expect(warm.isReconciled()).toBe(true);
    expect(() => warm.allocate(AUTHOR_A)).not.toThrow();
  });

  it('peekKaId does not require reconciliation', () => {
    const cold = new KaNumberAllocator(new InMemoryKaNumberStore());
    expect(() => cold.peekKaId(AUTHOR_A)).not.toThrow();
  });
});

describe('KaNumberAllocator — monotonic per-author numbers', () => {
  it('hands out 0,1,2,... for one author', () => {
    expect(alloc.allocate(AUTHOR_A).number).toBe(0);
    expect(alloc.allocate(AUTHOR_A).number).toBe(1);
    expect(alloc.allocate(AUTHOR_A).number).toBe(2);
  });

  it('keeps independent sequences per author', () => {
    expect(alloc.allocate(AUTHOR_A).number).toBe(0);
    expect(alloc.allocate(AUTHOR_B).number).toBe(0);
    expect(alloc.allocate(AUTHOR_A).number).toBe(1);
    expect(alloc.allocate(AUTHOR_B).number).toBe(1);
  });

  it('treats checksum-cased and lower-cased authors as the same sequence', () => {
    expect(alloc.allocate(AUTHOR_A).number).toBe(0);
    expect(alloc.allocate(AUTHOR_A.toLowerCase()).number).toBe(1);
  });

  it('never reclaims a number across allocator instances on a shared store', () => {
    expect(alloc.allocate(AUTHOR_A).number).toBe(0);
    expect(alloc.allocate(AUTHOR_A).number).toBe(1);
    // A fresh allocator over the SAME durable store must continue the
    // sequence, not restart it (durable, never-reclaimed contract).
    const alloc2 = new KaNumberAllocator(store);
    alloc2.markReconciled();
    expect(alloc2.allocate(AUTHOR_A).number).toBe(2);
    expect(alloc2.allocate(AUTHOR_A).number).toBe(3);
  });
});

describe('KaNumberAllocator — reconcile (floor)', () => {
  it('advances the next number up to observed+1', () => {
    // Observed highest minted on-chain under AUTHOR_A is 41 => next is 42.
    alloc.reconcile(AUTHOR_A, 41);
    expect(store.peekNext(AUTHOR_A)).toBe(42);
    expect(alloc.allocate(AUTHOR_A).number).toBe(42);
    expect(alloc.allocate(AUTHOR_A).number).toBe(43);
  });

  it('never lowers an already-higher next number', () => {
    expect(alloc.allocate(AUTHOR_A).number).toBe(0);
    expect(alloc.allocate(AUTHOR_A).number).toBe(1);
    // Local store is already at next=2. A stale floor of observed=0
    // (=> proposed next 1) must NOT pull the sequence backwards.
    alloc.reconcile(AUTHOR_A, 0);
    expect(store.peekNext(AUTHOR_A)).toBe(2);
    expect(alloc.allocate(AUTHOR_A).number).toBe(2);
  });

  it('reconcile is monotonic across repeated calls', () => {
    alloc.reconcile(AUTHOR_A, 9); // next -> 10
    alloc.reconcile(AUTHOR_A, 4); // stale, no-op
    alloc.reconcile(AUTHOR_A, 19); // next -> 20
    expect(store.peekNext(AUTHOR_A)).toBe(20);
  });
});

describe('KaNumberAllocator — kaId packing', () => {
  it('packs (uint160(author) << 96) | number and is non-zero', () => {
    const { kaId, number } = alloc.allocate(AUTHOR_A);
    expect(number).toBe(0);
    expect(typeof kaId).toBe('bigint');
    expect(kaId).not.toBe(0n);
    // Low 96 bits == number, high bits == author.
    expect(kaId & NUMBER_MASK).toBe(0n);
    expect(kaId >> 96n).toBe(BigInt(AUTHOR_A));
  });

  it('round-trips through unpack for a non-zero number', () => {
    // Consume a few so number is non-zero.
    alloc.allocate(AUTHOR_B);
    alloc.allocate(AUTHOR_B);
    const { kaId, number } = alloc.allocate(AUTHOR_B);
    expect(number).toBe(2);
    const unpacked = KaNumberAllocator.unpack(kaId);
    expect(unpacked.number).toBe(2n);
    expect(unpacked.author).toBe(AUTHOR_B.toLowerCase());
  });

  it('unpack pads the author to 40 hex chars (leading-zero authors)', () => {
    // An address with leading zero bytes must still round-trip to 40 chars.
    const lowAuthor = '0x0000000000000000000000000000000000000abc';
    const a = new KaNumberAllocator(new InMemoryKaNumberStore());
    a.markReconciled();
    const { kaId } = a.allocate(lowAuthor);
    const unpacked = KaNumberAllocator.unpack(kaId);
    expect(unpacked.author).toBe(lowAuthor);
    expect(unpacked.author).toHaveLength(42); // '0x' + 40
  });

  it('peekKaId equals the kaId the next allocate would produce', () => {
    const peeked = alloc.peekKaId(AUTHOR_A);
    const { kaId } = alloc.allocate(AUTHOR_A);
    expect(peeked).toBe(kaId);
  });

  it('every allocation yields a non-zero kaId', () => {
    for (let i = 0; i < 5; i++) {
      expect(alloc.allocate(AUTHOR_A).kaId).not.toBe(0n);
    }
  });

  it('rejects an invalid author address', () => {
    expect(() => alloc.allocate('not-an-address')).toThrow(/invalid author address/);
    expect(() => alloc.allocate('0x1234')).toThrow(/invalid author address/);
  });
});
