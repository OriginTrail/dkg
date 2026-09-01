/**
 * The finalized event position model (#2435): canonicalization of one
 * on-chain log's identity, identity equality vs ordering, and resume
 * filtering at identity equality. Split out of the VM-convergence suite at
 * review r9 to mirror the production module boundary.
 */
import { describe, expect, it } from 'vitest';
import {
  VmUpdateConvergenceError,
  canonicalEventPositionV1,
  canonicalFinalizedUpdate,
  compareEventPosition,
  isDiscardedByResume,
  sameEventIdentity,
  type FinalizedEventPositionV1,
} from '../src/vm-update-convergence.js';


const OTHER_ADDRESS = `0x${'c3'.repeat(20)}`;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const HASH_A = `0x${'11'.repeat(32)}`;
const HASH_B = `0x${'22'.repeat(32)}`;
const HASH_C = `0x${'33'.repeat(32)}`;


function position(overrides: Partial<FinalizedEventPositionV1> = {}): FinalizedEventPositionV1 {
  return {
    blockNumber: 100,
    blockHash: HASH_A,
    transactionHash: HASH_B,
    transactionIndex: 0,
    logIndex: 0,
    ...overrides,
  };
}


function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof VmUpdateConvergenceError) return error.code;
    throw error;
  }
  throw new Error('expected the call to throw a VmUpdateConvergenceError, but it returned');
}


describe('canonical event position', () => {
  it('canonicalEventPositionV1 throws NEUTRAL errors; W2 adapts them into its typed code (review r17)', () => {
    // The position validator is a reusable core seam: a publisher validating
    // a malformed hash must not receive VM-update terminology.
    try {
      canonicalEventPositionV1({
        blockNumber: 1, blockHash: 'nope',
        transactionHash: `0x${'ab'.repeat(32)}`, transactionIndex: 0, logIndex: 0,
      });
      expect.unreachable('a malformed blockHash must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('Error');
      expect((err as Error).message).not.toContain('vm-update');
      expect((err as Error).message).toContain('position.blockHash');
    }
    // …while W2's own page validation still surfaces its typed code, because
    // the VM boundary adapts the neutral failure exactly as it does for the
    // shipped scalar assertions.
    expect(codeOf(() => canonicalFinalizedUpdate({
      kind: 'lifecycle-update',
      kaId: '7',
      author: null,
      merkleRoot: `0x${'cd'.repeat(32)}`,
      blockNumber: 1, blockHash: 'nope',
      transactionHash: `0x${'ab'.repeat(32)}`, transactionIndex: 0, logIndex: 0,
    }))).toBe('noncanonical-scalar');
  });
});

describe('resume filtering compares identity at equality (review P1-4)', () => {
  const resume = position({ blockNumber: 101, transactionIndex: 2, logIndex: 3 });

  it('throws rather than silently discarding a DIFFERENT event at the same position', () => {
    const impostor = { ...resume, transactionHash: HASH_C };
    expect(compareEventPosition(impostor, resume)).toBe(0);
    expect(sameEventIdentity(impostor, resume)).toBe(false);
    expect(codeOf(() => isDiscardedByResume(impostor, resume))).toBe('resume-identity-conflict');
  });

  it('also catches a different block hash at the same position', () => {
    expect(
      codeOf(() => isDiscardedByResume({ ...resume, blockHash: HASH_C }, resume)),
    ).toBe('resume-identity-conflict');
  });

  it('still discards the genuinely identical event and retains later ones', () => {
    expect(isDiscardedByResume({ ...resume }, resume)).toBe(true);
    expect(
      isDiscardedByResume(position({ blockNumber: 101, transactionIndex: 2, logIndex: 4 }), resume),
    ).toBe(false);
    expect(
      isDiscardedByResume(position({ blockNumber: 101, transactionIndex: 2, logIndex: 2 }), resume),
    ).toBe(true);
  });
});

describe('exact event identity and ordering', () => {
  it('orders by (block, txIndex, logIndex) and ignores transactionHash', () => {
    const a = position({ blockNumber: 10, transactionIndex: 2, logIndex: 5 });
    const b = position({ blockNumber: 10, transactionIndex: 3, logIndex: 0 });
    expect(compareEventPosition(a, b)).toBeLessThan(0);
    expect(compareEventPosition(b, a)).toBeGreaterThan(0);

    // Same ordering coordinates, different tx hash: ordering says equal…
    const sameOrder = position({ transactionHash: HASH_C });
    expect(compareEventPosition(position(), sameOrder)).toBe(0);
    // …but identity says different, which is how a malformed page is caught.
    expect(sameEventIdentity(position(), sameOrder)).toBe(false);
    expect(sameEventIdentity(position(), position())).toBe(true);
  });

  it('accepts a legal zero author on the admin path', () => {
    const update = canonicalFinalizedUpdate({
      kind: 'lifecycle-update',
      kaId: '7',
      author: ZERO_ADDRESS,
      merkleRoot: HASH_C,
      ...position(),
    });
    expect(update.author).toBeNull();
    expect(Object.isFrozen(update)).toBe(true);
  });

  it('rejects a root-added event that claims an author', () => {
    expect(
      codeOf(() =>
        canonicalFinalizedUpdate({
          kind: 'root-added',
          kaId: '7',
          author: OTHER_ADDRESS,
          merkleRoot: HASH_C,
          ...position(),
        }),
      ),
    ).toBe('page-malformed');
  });
});
