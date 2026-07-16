/**
 * proof-material — V10 Random Sampling proof builders (content-binding).
 *
 * Two builders, both content-bound (`leaf = keccak256(content)`):
 *  - buildV10CatalogProofMaterial — plain tree (curated public `_catalog`)
 *  - buildV10ProofMaterial        — structured tree (public CG: private as sibling)
 *
 * Invariants mirror the on-chain `submitProof` boundary so a publisher/prover
 * refactor that breaks the agreement surfaces here, not in production.
 */
import { describe, it, expect } from 'vitest';
import {
  V10MerkleTree,
  tripleContentV10,
  keccak256,
  structuredKARootV10,
  buildV10ProofMaterial,
  buildV10CatalogProofMaterial,
  verifyV10ProofMaterial,
  V10ProofRootMismatchError,
  V10ProofLeafCountMismatchError,
  V10ProofChunkOutOfRangeError,
} from '../src/index.js';

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

/** Canonical N-Triple content bytes — what the prover submits; leaf = keccak256(content). */
function content(s: string, p: string, o: string): Uint8Array {
  return tripleContentV10(s, p, o);
}
function dummyContents(n: number): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => content(`<urn:s:${i}>`, '<urn:p:eq>', `<urn:o:${i}>`));
}

// ── CATALOG path: plain tree, content-binding ─────────────────────────
describe('buildV10CatalogProofMaterial — plain tree, content-binding', () => {
  const expectedFor = (contents: Uint8Array[]) => {
    const tree = new V10MerkleTree(contents.map(keccak256));
    return { merkleRoot: tree.root, merkleLeafCount: tree.leafCount };
  };

  it('every leaf index verifies and is content-bound (keccak256(content) === leaf)', () => {
    const contents = dummyContents(5);
    const expected = expectedFor(contents);
    for (let chunkId = 0; chunkId < expected.merkleLeafCount; chunkId++) {
      const m = buildV10CatalogProofMaterial(contents, chunkId, expected);
      expect(m.leafCount).toBe(expected.merkleLeafCount);
      expect(m.merkleRoot).toEqual(expected.merkleRoot);
      expect(hex(keccak256(m.content))).toBe(hex(m.leaf));
      expect(verifyV10ProofMaterial(m, chunkId, expected)).toBe(true);
    }
  });

  it('handles unsorted + duplicated content the way the publisher does', () => {
    const a = content('<urn:s:1>', '<p>', '<o>');
    const b = content('<urn:s:2>', '<p>', '<o>');
    const c = content('<urn:s:3>', '<p>', '<o>');
    const dupes = [c, a, b, a, c];
    const expected = expectedFor(dupes);
    expect(expected.merkleLeafCount).toBe(3); // dedupe
    expect(verifyV10ProofMaterial(buildV10CatalogProofMaterial(dupes, 1, expected), 1, expected)).toBe(true);
  });

  it('throws on root / leafCount / chunkId violations', () => {
    const contents = dummyContents(4);
    const expected = expectedFor(contents);
    expect(() => buildV10CatalogProofMaterial(contents, 0, { merkleRoot: new Uint8Array(32).fill(0xff), merkleLeafCount: expected.merkleLeafCount })).toThrow(V10ProofRootMismatchError);
    expect(() => buildV10CatalogProofMaterial(contents, 0, { merkleRoot: expected.merkleRoot, merkleLeafCount: expected.merkleLeafCount + 1 })).toThrow(V10ProofLeafCountMismatchError);
    expect(() => buildV10CatalogProofMaterial(contents, 99, expected)).toThrow(V10ProofChunkOutOfRangeError);
    expect(() => buildV10CatalogProofMaterial(contents, -1, expected)).toThrow(V10ProofChunkOutOfRangeError);
  });
});

// ── PUBLIC path: structured tree, content-binding ─────────────────────
describe('buildV10ProofMaterial — structured tree, content-binding', () => {
  const privateRoots = [new Uint8Array(32).fill(0xab)];
  const expectedFor = (contents: Uint8Array[], priv: Uint8Array[]) => {
    const { root, leafCount } = structuredKARootV10(contents.map(keccak256), priv);
    return { merkleRoot: root, merkleLeafCount: leafCount };
  };

  it('every leaf index verifies; proof ends with the privateDataHash sibling', () => {
    const contents = dummyContents(5);
    const expected = expectedFor(contents, privateRoots);
    for (let chunkId = 0; chunkId < expected.merkleLeafCount; chunkId++) {
      const m = buildV10ProofMaterial(contents, privateRoots, chunkId, expected);
      expect(hex(keccak256(m.content))).toBe(hex(m.leaf));
      expect(m.proof.length).toBeGreaterThanOrEqual(1); // ≥ the private sibling
      expect(verifyV10ProofMaterial(m, chunkId, expected)).toBe(true);
    }
  });

  it('binds private data into the root (integrity): different private -> different root', () => {
    const contents = dummyContents(3);
    expect(hex(expectedFor(contents, [new Uint8Array(32).fill(0x01)]).merkleRoot))
      .not.toBe(hex(expectedFor(contents, [new Uint8Array(32).fill(0x02)]).merkleRoot));
  });

  it('no private data still uses the sentinel sibling (NOT the bypass-prone flat root)', () => {
    const contents = dummyContents(4);
    const structured = expectedFor(contents, []);
    const flat = new V10MerkleTree(contents.map(keccak256)).root;
    expect(hex(structured.merkleRoot)).not.toBe(hex(flat));
    expect(verifyV10ProofMaterial(buildV10ProofMaterial(contents, [], 0, structured), 0, structured)).toBe(true);
  });
});

// ── content-binding rejections (the bypass is dead) ───────────────────
describe('verifyV10ProofMaterial — content-binding rejections', () => {
  const contents = dummyContents(4);
  const priv = [new Uint8Array(32).fill(0xcd)];
  const { root, leafCount } = structuredKARootV10(contents.map(keccak256), priv);
  const expected = { merkleRoot: root, merkleLeafCount: leafCount };

  it('rejects an empty proof with content echoing the root (the original bypass)', () => {
    const atk = { content: root, leaf: keccak256(root), proof: [], merkleRoot: root, leafCount };
    expect(verifyV10ProofMaterial(atk, 0, expected)).toBe(false);
  });

  it('rejects when content does not hash to the leaf', () => {
    const m = buildV10ProofMaterial(contents, priv, 0, expected);
    expect(verifyV10ProofMaterial({ ...m, content: content('<x>', '<y>', '<z>') }, 0, expected)).toBe(false);
  });

  it('rejects a stripped proof (private sibling removed)', () => {
    const m = buildV10ProofMaterial(contents, priv, 0, expected);
    expect(verifyV10ProofMaterial({ ...m, proof: [] }, 0, expected)).toBe(false);
  });
});
