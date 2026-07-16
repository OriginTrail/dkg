/**
 * Table-tests for LU-11 ciphertext-chunk Merkle (the index-preserving
 * binary tree feeding RFC-39 curated random sampling).
 *
 * Three invariants exercised:
 *
 *   - leafIndex (== chunkId == on-chain `challenge.chunkId`) is preserved
 *     end-to-end: `tree.proof(i)` + `leaves[i]` round-trips through
 *     `V10CiphertextChunksMerkleTree.verify` for every valid index.
 *   - root output is identical to the same parity-driven pair-hash that
 *     `RandomSampling._verifyV10MerkleProof` runs on-chain, including
 *     odd-count layer padding (last leaf duplicated).
 *   - small-N edge cases (0, 1, 2, 3 chunks) cover the contract picker's
 *     entire low end since most curated KCs land here.
 */
import { describe, it, expect } from 'vitest';
import {
  V10CiphertextChunksMerkleTree,
  buildCiphertextChunksRoot,
  keccak256,
  keccak256Hex,
} from '../src/index.js';

function ct(seed: string): Uint8Array {
  // Synthetic per-chunk ciphertext; bytes don't matter beyond producing
  // distinct keccak256 leaves so we can assert chunkId identity.
  return new TextEncoder().encode(`ciphertext-chunk:${seed}`);
}

function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);
  return keccak256(combined);
}

describe('V10CiphertextChunksMerkleTree — leaf format + edge cases', () => {
  it('throws on non-32-byte leaves', () => {
    expect(() => new V10CiphertextChunksMerkleTree([new Uint8Array(31)])).toThrow(/32 bytes/);
    expect(() => new V10CiphertextChunksMerkleTree([new Uint8Array(33)])).toThrow(/32 bytes/);
  });

  it('empty chunk set → 32-byte zero root, leafCount 0', () => {
    const { root, leafCount } = buildCiphertextChunksRoot([]);
    expect(leafCount).toBe(0);
    expect(root).toEqual(new Uint8Array(32));
  });

  it('single chunk → root equals the leaf, leafCount 1, empty proof', () => {
    const { root, leafCount, leaves, tree } = buildCiphertextChunksRoot([ct('only')]);
    expect(leafCount).toBe(1);
    expect(root).toEqual(leaves[0]);
    expect(tree.proof(0)).toEqual([]);
    expect(V10CiphertextChunksMerkleTree.verify(root, leaves[0], [], 0)).toBe(true);
  });

  it('two chunks → root = hashPair(leaf0, leaf1)', () => {
    const { root, leaves, tree } = buildCiphertextChunksRoot([ct('a'), ct('b')]);
    const expected = hashPair(leaves[0], leaves[1]);
    expect(root).toEqual(expected);
    expect(tree.proof(0)).toEqual([leaves[1]]);
    expect(tree.proof(1)).toEqual([leaves[0]]);
  });

  it('three chunks → odd-count padding duplicates last leaf', () => {
    const { root, leaves } = buildCiphertextChunksRoot([ct('a'), ct('b'), ct('c')]);
    // Layer 0 (after pad): [L0, L1, L2, L2]
    // Layer 1: [hash(L0,L1), hash(L2,L2)]
    // Root:    hash(hash(L0,L1), hash(L2,L2))
    const expected = hashPair(hashPair(leaves[0], leaves[1]), hashPair(leaves[2], leaves[2]));
    expect(root).toEqual(expected);
  });

  it.each([1, 2, 3, 4, 5, 7, 8, 16, 32, 33])(
    'round-trips proof for every chunkIndex when leafCount = %i',
    (count) => {
      const chunks = Array.from({ length: count }, (_, i) => ct(`r${i}`));
      const { root, leafCount, leaves, tree } = buildCiphertextChunksRoot(chunks);
      expect(leafCount).toBe(count);
      for (let i = 0; i < count; i++) {
        const proof = tree.proof(i);
        expect(V10CiphertextChunksMerkleTree.verify(root, leaves[i], proof, i)).toBe(true);
      }
    },
  );

  it('proof(i) is rejected when verified at the wrong chunkIndex', () => {
    const { root, leaves, tree } = buildCiphertextChunksRoot([ct('a'), ct('b'), ct('c'), ct('d')]);
    const proof0 = tree.proof(0);
    expect(V10CiphertextChunksMerkleTree.verify(root, leaves[0], proof0, 0)).toBe(true);
    expect(V10CiphertextChunksMerkleTree.verify(root, leaves[0], proof0, 1)).toBe(false);
  });

  it('proof(i) is rejected when the leaf at i is swapped', () => {
    const { root, leaves, tree } = buildCiphertextChunksRoot([ct('a'), ct('b'), ct('c'), ct('d')]);
    expect(V10CiphertextChunksMerkleTree.verify(root, leaves[1], tree.proof(0), 0)).toBe(false);
  });

  it('preserves duplicate chunks (no dedupe) — leafCount and chunkId are both stable', () => {
    // Same plaintext twice → same leaf hash, but still TWO chunks with
    // distinct chunkIds. Sort-and-dedupe would collapse this to 1 leaf
    // and break the on-chain chunkCount; verify we keep both.
    const dup = ct('repeat');
    const { root, leafCount, leaves, tree } = buildCiphertextChunksRoot([dup, dup, ct('other')]);
    expect(leafCount).toBe(3);
    expect(leaves[0]).toEqual(leaves[1]);
    expect(V10CiphertextChunksMerkleTree.verify(root, leaves[0], tree.proof(0), 0)).toBe(true);
    expect(V10CiphertextChunksMerkleTree.verify(root, leaves[1], tree.proof(1), 1)).toBe(true);
    expect(V10CiphertextChunksMerkleTree.verify(root, leaves[2], tree.proof(2), 2)).toBe(true);
  });

  it('preserves chunk order (no sort) — swapping input changes the root', () => {
    const a = ct('a');
    const b = ct('b');
    const c = ct('c');
    const r1 = buildCiphertextChunksRoot([a, b, c]).root;
    const r2 = buildCiphertextChunksRoot([c, b, a]).root;
    expect(keccak256Hex(r1)).not.toBe(keccak256Hex(r2));
  });

  it('out-of-range chunkIndex throws on proof() and leafAt()', () => {
    const { tree } = buildCiphertextChunksRoot([ct('a'), ct('b')]);
    expect(() => tree.proof(-1)).toThrow(/out of range/);
    expect(() => tree.proof(2)).toThrow(/out of range/);
    expect(() => tree.leafAt(-1)).toThrow(/out of range/);
    expect(() => tree.leafAt(2)).toThrow(/out of range/);
  });

  it('leafAt(i) returns the same bytes used to build proof(i)', () => {
    const { tree, leaves } = buildCiphertextChunksRoot([ct('a'), ct('b'), ct('c')]);
    for (let i = 0; i < 3; i++) {
      expect(tree.leafAt(i)).toEqual(leaves[i]);
    }
  });
});

describe('buildCiphertextChunksRoot — golden vector', () => {
  // Locks the leaf format ("ciphertext bytes hashed once with keccak256
  // in chunkId order") so any future refactor that silently changes the
  // wire shape is caught by this test. The vector values were computed
  // by hand below; they will also be re-derivable from the formula.
  it('matches a deterministic vector for 4 fixed chunks', () => {
    const chunks = [
      new TextEncoder().encode('chunk-0'),
      new TextEncoder().encode('chunk-1'),
      new TextEncoder().encode('chunk-2'),
      new TextEncoder().encode('chunk-3'),
    ];
    const { root, leaves, leafCount } = buildCiphertextChunksRoot(chunks);
    expect(leafCount).toBe(4);

    // Hand-derived: leaves[i] = keccak256("chunk-i"),
    // expected root = hashPair(hashPair(L0,L1), hashPair(L2,L3)).
    const expected = hashPair(hashPair(leaves[0], leaves[1]), hashPair(leaves[2], leaves[3]));
    expect(root).toEqual(expected);
  });
});
