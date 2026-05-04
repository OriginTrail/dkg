/**
 * proof-material — V10 Random Sampling proof builder unit tests.
 *
 * Covers the `submitProof` argument tuple builder used by the off-chain
 * Random Sampling prover:
 *  - happy path: leaves -> tree -> (leaf, proof) round-trips through V10MerkleTree.verify
 *  - root mismatch -> V10ProofRootMismatchError (non-retryable for the period)
 *  - leaf-count mismatch -> V10ProofLeafCountMismatchError
 *  - chunkId out of range -> V10ProofChunkOutOfRangeError
 *  - V10MerkleTree.leafAt boundary parity with proof()
 *
 * Invariants tested deliberately mirror the on-chain
 * `_verifyV10MerkleProof` boundary so a publisher refactor that breaks
 * the prover surfaces here, not in production.
 */
import { describe, it, expect } from 'vitest';
import {
  V10MerkleTree,
  hashTripleV10,
  buildV10ProofMaterial,
  verifyV10ProofMaterial,
  V10ProofRootMismatchError,
  V10ProofLeafCountMismatchError,
  V10ProofChunkOutOfRangeError,
} from '../src/index.js';

function leafFor(s: string, p: string, o: string): Uint8Array {
  return hashTripleV10(s, p, o);
}

function dummyLeaves(n: number): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => leafFor(`urn:s:${i}`, 'urn:p:eq', `urn:o:${i}`));
}

describe('buildV10ProofMaterial — happy path', () => {
  it('produces a proof that V10MerkleTree.verify accepts at every leaf index', () => {
    const leaves = dummyLeaves(5);
    const tree = new V10MerkleTree(leaves);
    const expected = { merkleRoot: tree.root, merkleLeafCount: tree.leafCount };

    for (let chunkId = 0; chunkId < tree.leafCount; chunkId++) {
      const material = buildV10ProofMaterial(leaves, chunkId, expected);

      expect(material.leafCount).toBe(tree.leafCount);
      expect(material.merkleRoot).toEqual(tree.root);
      expect(V10MerkleTree.verify(expected.merkleRoot, material.leaf, material.proof, chunkId))
        .toBe(true);
      expect(verifyV10ProofMaterial(material, chunkId, expected)).toBe(true);
    }
  });

  it('handles unsorted + duplicated input the same way the publisher does', () => {
    const a = leafFor('urn:s:1', 'p', 'o');
    const b = leafFor('urn:s:2', 'p', 'o');
    const c = leafFor('urn:s:3', 'p', 'o');
    const unsortedWithDupes = [c, a, b, a, c];

    const tree = new V10MerkleTree(unsortedWithDupes);
    const expected = { merkleRoot: tree.root, merkleLeafCount: tree.leafCount };

    expect(tree.leafCount).toBe(3); // dedupe
    const material = buildV10ProofMaterial(unsortedWithDupes, 1, expected);
    expect(verifyV10ProofMaterial(material, 1, expected)).toBe(true);
  });

  it('leaf returned matches V10MerkleTree.leafAt at the same index', () => {
    const leaves = dummyLeaves(7);
    const tree = new V10MerkleTree(leaves);
    const expected = { merkleRoot: tree.root, merkleLeafCount: tree.leafCount };

    const material = buildV10ProofMaterial(leaves, 3, expected);
    expect(material.leaf).toEqual(tree.leafAt(3));
  });
});

describe('buildV10ProofMaterial — invariant violations', () => {
  it('throws V10ProofRootMismatchError when expected root does not match', () => {
    const leaves = dummyLeaves(4);
    const tree = new V10MerkleTree(leaves);
    const wrongRoot = new Uint8Array(32).fill(0xff);

    expect(() =>
      buildV10ProofMaterial(leaves, 0, {
        merkleRoot: wrongRoot,
        merkleLeafCount: tree.leafCount,
      }),
    ).toThrow(V10ProofRootMismatchError);
  });

  it('throws V10ProofLeafCountMismatchError when expected count does not match', () => {
    const leaves = dummyLeaves(4);
    const tree = new V10MerkleTree(leaves);

    expect(() =>
      buildV10ProofMaterial(leaves, 0, {
        merkleRoot: tree.root,
        merkleLeafCount: tree.leafCount + 1,
      }),
    ).toThrow(V10ProofLeafCountMismatchError);
  });

  it('checks leaf count BEFORE root so leaf-set drift surfaces with the precise message', () => {
    const leaves = dummyLeaves(4);
    const tree = new V10MerkleTree(leaves);

    try {
      buildV10ProofMaterial(leaves, 0, {
        merkleRoot: new Uint8Array(32).fill(0xff),
        merkleLeafCount: tree.leafCount + 1,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(V10ProofLeafCountMismatchError);
    }
  });

  it.each([
    { chunkId: -1 },
    { chunkId: 999 },
  ])('throws V10ProofChunkOutOfRangeError for chunkId=$chunkId', ({ chunkId }) => {
    const leaves = dummyLeaves(3);
    const tree = new V10MerkleTree(leaves);

    expect(() =>
      buildV10ProofMaterial(leaves, chunkId, {
        merkleRoot: tree.root,
        merkleLeafCount: tree.leafCount,
      }),
    ).toThrow(V10ProofChunkOutOfRangeError);
  });
});

describe('verifyV10ProofMaterial', () => {
  it('returns false when the supplied leaf has been tampered with', () => {
    const leaves = dummyLeaves(4);
    const tree = new V10MerkleTree(leaves);
    const expected = { merkleRoot: tree.root, merkleLeafCount: tree.leafCount };
    const material = buildV10ProofMaterial(leaves, 1, expected);

    const tampered = { ...material, leaf: new Uint8Array(32).fill(0xab) };
    expect(verifyV10ProofMaterial(tampered, 1, expected)).toBe(false);
  });

  it('returns false when verifying against a different expected root', () => {
    const leaves = dummyLeaves(4);
    const tree = new V10MerkleTree(leaves);
    const expected = { merkleRoot: tree.root, merkleLeafCount: tree.leafCount };
    const material = buildV10ProofMaterial(leaves, 0, expected);

    expect(verifyV10ProofMaterial(material, 0, {
      merkleRoot: new Uint8Array(32).fill(0xff),
      merkleLeafCount: tree.leafCount,
    })).toBe(false);
  });
});

describe('V10MerkleTree.leafAt', () => {
  it('returns the same byte content the prover signed', () => {
    const leaves = dummyLeaves(5);
    const tree = new V10MerkleTree(leaves);

    const sortedDeduped = [...leaves].sort((a, b) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return a.length - b.length;
    });

    for (let i = 0; i < tree.leafCount; i++) {
      expect(tree.leafAt(i)).toEqual(sortedDeduped[i]);
    }
  });

  it('throws RangeError outside [0, leafCount)', () => {
    const tree = new V10MerkleTree(dummyLeaves(3));
    expect(() => tree.leafAt(-1)).toThrow(RangeError);
    expect(() => tree.leafAt(tree.leafCount)).toThrow(RangeError);
  });
});
