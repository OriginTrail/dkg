import { sha256, MerkleTree, hashTriple, hashTripleV10, V10MerkleTree } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

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

// ── V10 variants (keccak256, spec §9.0.2) ──────────────────────────────

export function computeTripleHashV10(q: Quad): Uint8Array {
  return hashTripleV10(q.subject, q.predicate, q.object);
}

export function computePublicRootV10(publicQuads: Quad[]): Uint8Array | undefined {
  if (publicQuads.length === 0) return undefined;
  const hashes = publicQuads.map(computeTripleHashV10);
  return new V10MerkleTree(hashes).root;
}

export function computePrivateRootV10(privateQuads: Quad[]): Uint8Array | undefined {
  if (privateQuads.length === 0) return undefined;
  const hashes = privateQuads.map(computeTripleHashV10);
  return new V10MerkleTree(hashes).root;
}

export function computeFlatKCRootV10(
  publicQuads: Quad[],
  privateRoots: Uint8Array[],
): Uint8Array {
  const leaves: Uint8Array[] = publicQuads.map(computeTripleHashV10);
  for (const root of privateRoots) {
    leaves.push(root);
  }
  return new V10MerkleTree(leaves).root;
}

/** Leaf count after V10 sort+dedupe (same tree as {@link computeFlatKCRootV10}). */
export function computeFlatKCMerkleLeafCountV10(
  publicQuads: Quad[],
  privateRoots: Uint8Array[],
): number {
  const leaves: Uint8Array[] = publicQuads.map(computeTripleHashV10);
  for (const root of privateRoots) {
    leaves.push(root);
  }
  return new V10MerkleTree(leaves).leafCount;
}

export function computeKARootV10(
  publicRoot?: Uint8Array,
  privateRoot?: Uint8Array,
): Uint8Array {
  return V10MerkleTree.computeKARoot(publicRoot, privateRoot);
}

export function computeKCRootV10(kaRoots: Uint8Array[]): Uint8Array {
  return V10MerkleTree.computeKCRoot(kaRoots);
}
