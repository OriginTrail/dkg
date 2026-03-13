import { sha256, MerkleTree, hashTriple } from '@dkg/core';
import type { Quad } from '@dkg/storage';

/**
 * Compute SHA-256 hash of a single triple (s, p, o).
 * Graph component is excluded per spec.
 */
export function computeTripleHash(q: Quad): Uint8Array {
  return hashTriple(q.subject, q.predicate, q.object);
}

export function computePublicRoot(publicQuads: Quad[]): Uint8Array | undefined {
  if (publicQuads.length === 0) return undefined;
  const hashes = publicQuads.map(computeTripleHash);
  return new MerkleTree(hashes).root;
}

export function computePrivateRoot(
  privateQuads: Quad[],
): Uint8Array | undefined {
  if (privateQuads.length === 0) return undefined;
  const hashes = privateQuads.map(computeTripleHash);
  return new MerkleTree(hashes).root;
}

/**
 * Compute flat KC merkle root from public triple hashes plus any
 * private merkle roots as synthetic leaves.  This anchors private
 * content commitments to the on-chain root so they cannot be
 * mutated after confirmation without invalidating the root.
 */
export function computeFlatKCRoot(
  publicQuads: Quad[],
  privateRoots: Uint8Array[],
): Uint8Array {
  const leaves: Uint8Array[] = publicQuads.map(computeTripleHash);
  for (const root of privateRoots) {
    leaves.push(root);
  }
  return new MerkleTree(leaves).root;
}

export function computeKARoot(
  publicRoot?: Uint8Array,
  privateRoot?: Uint8Array,
): Uint8Array {
  return MerkleTree.computeKARoot(publicRoot, privateRoot);
}

export function computeKCRoot(kaRoots: Uint8Array[]): Uint8Array {
  return MerkleTree.computeKCRoot(kaRoots);
}
