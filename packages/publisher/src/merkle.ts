import { sha256, MerkleTree, hashTriple, hashTripleV10, V10MerkleTree, structuredKARootV10 } from '@origintrail-official/dkg-core';
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

// ── Structured KA commitment (PoS content-binding redesign) ────────────
// The canonical structured-root logic + sentinels live in dkg-core
// (`structuredKARootV10`), so publisher, prover, and the on-chain verifier
// cannot drift. Re-exported here for callers that read the sentinels directly.
export { SENTINEL_NO_PRIVATE_V10, SENTINEL_NO_PUBLIC_V10 } from '@origintrail-official/dkg-core';

/**
 * V10 per-KA **STRUCTURED** commitment — `root = hashPair(publicRoot, privateDataHash)`
 * with the public-only `leafCount` (the challenge index space). Public triples form
 * the challengeable subtree; private data is collapsed to one sibling, bound into the
 * root for integrity but NEVER a challengeable leaf. Returns both **atomically** so the
 * on-chain `merkleRoot` and `merkleLeafCount` can't be paired inconsistently — prefer
 * this over the deprecated `computeFlatKC*` names below.
 */
export function computeStructuredKCRootV10(
  publicQuads: Quad[],
  privateRoots: Uint8Array[],
): { root: Uint8Array; leafCount: number } {
  const r = structuredKARootV10(publicQuads.map(computeTripleHashV10), privateRoots);
  return { root: r.root, leafCount: r.leafCount };
}

/**
 * @deprecated Misleading name — this now returns the STRUCTURED root, not a
 * flat-mixed one. Kept as a thin wrapper so existing recompute call sites inherit
 * the new root with no edit; migrate to {@link computeStructuredKCRootV10}.
 */
export function computeFlatKCRootV10(
  publicQuads: Quad[],
  privateRoots: Uint8Array[],
): Uint8Array {
  return computeStructuredKCRootV10(publicQuads, privateRoots).root;
}

/**
 * @deprecated Use {@link computeStructuredKCRootV10}().leafCount. Public-only leaf
 * count (the challenge index space); `privateRoots` no longer affects it.
 */
export function computeFlatKCMerkleLeafCountV10(
  publicQuads: Quad[],
  privateRoots: Uint8Array[],
): number {
  return computeStructuredKCRootV10(publicQuads, privateRoots).leafCount;
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
