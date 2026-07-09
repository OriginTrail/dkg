import { describe, it, expect, beforeEach } from 'vitest';
import type { KaNumberStore } from '@origintrail-official/dkg-core';
import {
  KaNumberAllocator,
  reconcileAndAllocateKaNumber,
  readMaxKaNumberWithRetry,
  isTransientChainError,
  KaFloorReconcileError,
} from '../src/allocator.js';

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

describe('KaNumberAllocator — zero address (codex PR #976 F7)', () => {
  const ZERO = '0x0000000000000000000000000000000000000000';

  it('refuses to allocate under the zero address', () => {
    // Under the packed scheme `kaId = (uint160(author) << 96) | number`
    // the first allocation for the zero address would produce
    // `kaId = (0n << 96n) | 0n === 0n`. That:
    //   (a) violates the documented `KaAllocation.kaId` non-zero contract;
    //   (b) collides with the chain-event-poller's "no kaId" sentinel
    //       (`handleKACreated`'s `if (kaId === 0n) return`), so the
    //       reconciliation callback would silently drop the mint event.
    // `ethers.getAddress(ZeroAddress)` accepts the zero address, so the
    // allocator has to reject it explicitly.
    expect(() => alloc.allocate(ZERO)).toThrow(/zero address/);
  });

  it('refuses to reconcile under the zero address', () => {
    // Same rationale — never let a stray zero-address observation poison
    // the floor map with a phantom-author key.
    expect(() => alloc.reconcile(ZERO, 0n)).toThrow(/zero address/);
  });

  it('refuses to peek under the zero address', () => {
    expect(() => alloc.peekKaId(ZERO)).toThrow(/zero address/);
  });

  it('accepts every non-zero address ethers.getAddress accepts', () => {
    // Sanity: a barely-non-zero address still works (no over-rejection).
    const oneLsb = '0x0000000000000000000000000000000000000001';
    expect(alloc.allocate(oneLsb).number).toBe(0n);
    expect(alloc.allocate(oneLsb).kaId).not.toBe(0n);
  });
});

describe('KaNumberAllocator — canonical address (codex PR #976 F8)', () => {
  it('passes a single canonical key to the store regardless of caller casing', () => {
    // The allocator now canonicalizes (lowercase) before talking to the
    // store, so a store implementation that forgot to lowercase its own
    // key still gets one stable key per on-chain author. We pin this
    // behaviour with a casing-aware fake store.
    class CaseAwareStore implements KaNumberStore {
      readonly seenKeys: string[] = [];
      private readonly next = new Map<string, bigint>();
      allocate(authorAddress: string): bigint {
        // INTENTIONALLY does NOT lowercase — that's the bug F8 defends
        // against. If the allocator forwards a checksummed string, the
        // sequence forks per casing variant.
        this.seenKeys.push(authorAddress);
        const cur = this.next.get(authorAddress) ?? 0n;
        this.next.set(authorAddress, cur + 1n);
        return cur;
      }
      reconcileFloor(authorAddress: string, nextNumberFloor: bigint): void {
        this.seenKeys.push(authorAddress);
        const cur = this.next.get(authorAddress) ?? 0n;
        this.next.set(authorAddress, cur > nextNumberFloor ? cur : nextNumberFloor);
      }
      peekNext(authorAddress: string): bigint {
        this.seenKeys.push(authorAddress);
        return this.next.get(authorAddress) ?? 0n;
      }
    }
    const store = new CaseAwareStore();
    const a = new KaNumberAllocator(store);
    a.markReconciled();

    // Caller hands us THREE different casings of the same on-chain
    // address. The allocator must collapse them to one key before the
    // store ever sees them.
    a.allocate(AUTHOR_A);                  // checksummed
    a.allocate(AUTHOR_A.toLowerCase());
    a.allocate(AUTHOR_A.toUpperCase().replace('0X', '0x')); // upper hex
    a.peekKaId(AUTHOR_A);
    a.reconcile(AUTHOR_A, 99n);

    // Every store key must be the lowercased canonical form. Without
    // the F8 fix the store would have seen the checksummed string at
    // least once.
    const lc = AUTHOR_A.toLowerCase();
    for (const key of store.seenKeys) {
      expect(key).toBe(lc);
    }
  });

  it('peek + allocate cannot disagree under mixed casing', () => {
    // Peek with one casing, allocate with another — the peeked kaId
    // MUST equal the kaId the next allocate produces. Without F8 the
    // two would index into different store keys and disagree.
    const peeked = alloc.peekKaId(AUTHOR_A);
    const { kaId } = alloc.allocate(AUTHOR_A.toLowerCase());
    expect(peeked).toBe(kaId);
  });
});

/**
 * KA-number-floor reconcile resilience to transient RPC failures.
 *
 * Repro: a free public RPC answered the one-time-per-author floor read with
 * `429 Too Many Requests`, and the reconcile threw a hard error → the daemon
 * returned HTTP 500 on `POST /api/knowledge-assets` (named-assertion create).
 * The fix retries transient errors and, if the chain stays unreachable, throws a
 * typed `KaFloorReconcileError` the HTTP layer maps to a retryable 503.
 *
 * `noSleep` is injected so the backoff doesn't actually wait in tests.
 */
describe('KA-number-floor reconcile resilience to RPC failures', () => {
  const noSleep = async () => {};

  it('isTransientChainError: rate-limit/timeout/5xx transient; revert/bad-input not', () => {
    expect(isTransientChainError(new Error('server response 429 Too Many Requests'))).toBe(true);
    expect(isTransientChainError(new Error('over rate limit'))).toBe(true);
    expect(isTransientChainError(new Error('Request timeout on the free tier'))).toBe(true);
    expect(isTransientChainError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransientChainError(new Error('failed to detect network'))).toBe(true);
    expect(isTransientChainError(new Error('execution reverted: TooLowBalance'))).toBe(false);
    expect(isTransientChainError(new Error('KaNumberAllocator: invalid author address'))).toBe(false);
  });

  it('readMaxKaNumberWithRetry retries a transient error then succeeds', async () => {
    let calls = 0;
    const read = async () => {
      calls += 1;
      if (calls < 3) throw new Error('server response 429 Too Many Requests');
      return 41n;
    };
    expect(await readMaxKaNumberWithRetry(read, AUTHOR_A, noSleep)).toBe(41n);
    expect(calls).toBe(3);
  });

  it('readMaxKaNumberWithRetry does NOT retry a deterministic error', async () => {
    let calls = 0;
    const read = async () => { calls += 1; throw new Error('execution reverted'); };
    await expect(readMaxKaNumberWithRetry(read, AUTHOR_A, noSleep)).rejects.toThrow(/reverted/);
    expect(calls).toBe(1);
  });

  it('reconcileAndAllocateKaNumber succeeds after transient retries (no 500 on a 429)', async () => {
    let calls = 0;
    const chain = {
      chainId: 'gnosis:100',
      getMaxKaNumberForAuthor: async () => {
        calls += 1;
        if (calls < 2) throw new Error('over rate limit');
        return 5n;
      },
    };
    const { number, reservedUal } = await reconcileAndAllocateKaNumber(
      alloc, chain, new Set<string>(), AUTHOR_A, noSleep,
    );
    expect(number).toBe(6n); // floor reconciled to 5 → next allocation is 6
    expect(reservedUal).toBe(`did:dkg:gnosis:100/${AUTHOR_A.toLowerCase()}/6`);
  });

  it('reconcileAndAllocateKaNumber throws a typed, retryable KaFloorReconcileError when the chain stays unreachable', async () => {
    const chain = {
      chainId: 'gnosis:100',
      getMaxKaNumberForAuthor: async () => { throw new Error('server response 429 Too Many Requests'); },
    };
    const err = await reconcileAndAllocateKaNumber(alloc, chain, new Set<string>(), AUTHOR_A, noSleep)
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(KaFloorReconcileError);
    expect(err.code).toBe('KA_FLOOR_RECONCILE_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    // keeps the legacy message substring existing matchers rely on
    expect(String(err.message)).toMatch(/failed to reconcile KA-number floor/);
  });
});
