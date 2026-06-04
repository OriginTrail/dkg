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
 *
 * `bigint` end-to-end (codex PR #976 F6) so this fixture mirrors the
 * SQLite store's `safeIntegers(true)` semantics and the counter stays
 * exact past `Number.MAX_SAFE_INTEGER`.
 */
class InMemoryKaNumberStore implements KaNumberStore {
  private readonly next = new Map<string, bigint>();

  allocate(authorAddress: string): bigint {
    const key = authorAddress.toLowerCase();
    const current = this.next.get(key) ?? 0n;
    this.next.set(key, current + 1n);
    return current;
  }

  reconcileFloor(authorAddress: string, nextNumberFloor: bigint): void {
    const key = authorAddress.toLowerCase();
    const current = this.next.get(key) ?? 0n;
    this.next.set(key, current > nextNumberFloor ? current : nextNumberFloor);
  }

  peekNext(authorAddress: string): bigint {
    return this.next.get(authorAddress.toLowerCase()) ?? 0n;
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
  it('hands out 0n,1n,2n,... for one author', () => {
    expect(alloc.allocate(AUTHOR_A).number).toBe(0n);
    expect(alloc.allocate(AUTHOR_A).number).toBe(1n);
    expect(alloc.allocate(AUTHOR_A).number).toBe(2n);
  });

  it('keeps independent sequences per author', () => {
    expect(alloc.allocate(AUTHOR_A).number).toBe(0n);
    expect(alloc.allocate(AUTHOR_B).number).toBe(0n);
    expect(alloc.allocate(AUTHOR_A).number).toBe(1n);
    expect(alloc.allocate(AUTHOR_B).number).toBe(1n);
  });

  it('treats checksum-cased and lower-cased authors as the same sequence', () => {
    expect(alloc.allocate(AUTHOR_A).number).toBe(0n);
    expect(alloc.allocate(AUTHOR_A.toLowerCase()).number).toBe(1n);
  });

  it('never reclaims a number across allocator instances on a shared store', () => {
    expect(alloc.allocate(AUTHOR_A).number).toBe(0n);
    expect(alloc.allocate(AUTHOR_A).number).toBe(1n);
    // A fresh allocator over the SAME durable store must continue the
    // sequence, not restart it (durable, never-reclaimed contract).
    const alloc2 = new KaNumberAllocator(store);
    alloc2.markReconciled();
    expect(alloc2.allocate(AUTHOR_A).number).toBe(2n);
    expect(alloc2.allocate(AUTHOR_A).number).toBe(3n);
  });

  // codex PR #976 F6 — the counter is bigint end-to-end. Crossing
  // `Number.MAX_SAFE_INTEGER` MUST remain exact (no silent precision
  // loss). Pre-fix this would have returned the same `number` twice
  // (or skipped one) because every cast went through JS `number`.
  it('stays exact past Number.MAX_SAFE_INTEGER (F6 precision invariant)', () => {
    const past = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 - 1
    // Reconcile the floor so the next allocation lands at exactly `past`.
    // `reconcile` adds 1, so observed = past - 1n => next = past.
    alloc.reconcile(AUTHOR_A, past - 1n);
    const a = alloc.allocate(AUTHOR_A);
    const b = alloc.allocate(AUTHOR_A);
    const c = alloc.allocate(AUTHOR_A);
    expect(a.number).toBe(past);
    expect(b.number).toBe(past + 1n);
    expect(c.number).toBe(past + 2n);
    // Critical: in JS `number`, `Number(past) + 2 === Number(past) + 3`
    // (both round to the same 2^53 even). With `bigint`, the three
    // allocations are distinct values — no kaId collision risk.
    expect(a.number).not.toBe(b.number);
    expect(b.number).not.toBe(c.number);
    // And the kaId packing must reflect the distinct numbers too.
    expect(a.kaId).not.toBe(b.kaId);
    expect(b.kaId).not.toBe(c.kaId);
    expect(typeof a.number).toBe('bigint');
  });
});

describe('KaNumberAllocator — reconcile (floor)', () => {
  it('advances the next number up to observed+1', () => {
    // Observed highest minted on-chain under AUTHOR_A is 41 => next is 42.
    alloc.reconcile(AUTHOR_A, 41n);
    expect(store.peekNext(AUTHOR_A)).toBe(42n);
    expect(alloc.allocate(AUTHOR_A).number).toBe(42n);
    expect(alloc.allocate(AUTHOR_A).number).toBe(43n);
  });

  it('never lowers an already-higher next number', () => {
    expect(alloc.allocate(AUTHOR_A).number).toBe(0n);
    expect(alloc.allocate(AUTHOR_A).number).toBe(1n);
    // Local store is already at next=2. A stale floor of observed=0
    // (=> proposed next 1) must NOT pull the sequence backwards.
    alloc.reconcile(AUTHOR_A, 0n);
    expect(store.peekNext(AUTHOR_A)).toBe(2n);
    expect(alloc.allocate(AUTHOR_A).number).toBe(2n);
  });

  it('reconcile is monotonic across repeated calls', () => {
    alloc.reconcile(AUTHOR_A, 9n); // next -> 10
    alloc.reconcile(AUTHOR_A, 4n); // stale, no-op
    alloc.reconcile(AUTHOR_A, 19n); // next -> 20
    expect(store.peekNext(AUTHOR_A)).toBe(20n);
  });
});

describe('KaNumberAllocator — kaId packing', () => {
  it('packs (uint160(author) << 96) | number and is non-zero', () => {
    const { kaId, number } = alloc.allocate(AUTHOR_A);
    expect(number).toBe(0n);
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
    expect(number).toBe(2n);
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
