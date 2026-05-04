import { V10MerkleTree } from './v10-merkle.js';

/**
 * Bytes the off-chain Random Sampling prover must submit to
 * `RandomSampling.submitProof(leaf, merkleProof)`. Bound to the
 * canonical V10 sort+dedupe leaf set so the chain accepts it on the
 * first try.
 */
export interface V10ProofMaterial {
  /** Leaf at on-chain `chunkId` after V10 sort+dedupe — the `leaf` arg of `submitProof`. */
  leaf: Uint8Array;
  /** Merkle siblings from the deduped leaf to the root — the `merkleProof` arg of `submitProof`. */
  proof: Uint8Array[];
  /** Recomputed root; matches `expected.merkleRoot` (asserted before return). */
  merkleRoot: Uint8Array;
  /** Recomputed deduped leaf count; matches `expected.merkleLeafCount` (asserted before return). */
  leafCount: number;
}

/**
 * Expected on-chain merkle commitment, read from
 * `KnowledgeCollectionStorage.getLatestMerkleRoot(kcId)` +
 * `getMerkleLeafCount(kcId)` before building the proof.
 */
export interface V10MerkleCommitment {
  merkleRoot: Uint8Array;
  merkleLeafCount: number;
}

/**
 * Thrown when the locally-recomputed merkle root does not match the
 * on-chain expected root. Indicates the prover assembled the wrong leaf
 * set (sync gap, store corruption, or graph-URI drift between publish
 * and prover). **Non-retryable** with the same data; the prover MUST
 * skip the period and log loudly. Mirrors the on-chain
 * `MerkleRootMismatchError` revert.
 */
export class V10ProofRootMismatchError extends Error {
  readonly name = 'V10ProofRootMismatchError';
  constructor(
    readonly computedMerkleRoot: Uint8Array,
    readonly expectedMerkleRoot: Uint8Array,
  ) {
    super(
      `V10 proof root mismatch: computed=${toHex(computedMerkleRoot)} ` +
      `expected=${toHex(expectedMerkleRoot)}`,
    );
  }
}

/**
 * Thrown when the locally-recomputed leaf count does not match the
 * on-chain `merkleLeafCount`. Almost always a sort+dedupe drift caused
 * by including the wrong quad set (e.g. extra graph context, stale
 * private sub-roots). Non-retryable; same operator action as
 * {@link V10ProofRootMismatchError}.
 */
export class V10ProofLeafCountMismatchError extends Error {
  readonly name = 'V10ProofLeafCountMismatchError';
  constructor(
    readonly computedLeafCount: number,
    readonly expectedLeafCount: number,
  ) {
    super(
      `V10 proof leaf count mismatch: computed=${computedLeafCount} ` +
      `expected=${expectedLeafCount}`,
    );
  }
}

/**
 * Thrown when the on-chain `chunkId` falls outside the local tree's
 * `[0, leafCount)` range. This should be impossible if the root and
 * leaf-count invariants both hold (the chain enforces
 * `chunkId = kcSeed % merkleLeafCount` in `_generateChallenge`); if it
 * fires, it indicates the caller hand-rolled a chunkId or the
 * commitment came from the wrong kcId.
 */
export class V10ProofChunkOutOfRangeError extends RangeError {
  readonly name = 'V10ProofChunkOutOfRangeError';
  constructor(readonly chunkId: number, readonly leafCount: number) {
    super(`V10 proof chunkId ${chunkId} out of range [0, ${leafCount})`);
  }
}

/**
 * Build the `submitProof` argument tuple from raw V10 leaves.
 *
 * Inputs are the same flat-KC leaves the publisher fed to
 * `V10MerkleTree`: keccak256 of each `<s> <p> <o> .` plus any private
 * sub-roots, **unsorted, undeduped**. The constructor sorts + dedupes
 * internally to match the on-chain commitment.
 *
 * Fail-fast contract — every mismatch is non-retryable for the current
 * proof period:
 * 1. recompute `tree.leafCount`; assert it equals `expected.merkleLeafCount`,
 * 2. recompute `tree.root`; assert it equals `expected.merkleRoot`,
 * 3. assert `chunkId < tree.leafCount`,
 * 4. emit `(leaf, proof, root, leafCount)`.
 *
 * Pure: depends only on `V10MerkleTree`. No `Quad`/storage dependency
 * lives in `dkg-core` — that boundary is owned by the
 * `packages/random-sampling` extractor (Phase 3).
 */
export function buildV10ProofMaterial(
  rawLeaves: Uint8Array[],
  chunkId: number,
  expected: V10MerkleCommitment,
): V10ProofMaterial {
  const tree = new V10MerkleTree(rawLeaves);

  if (tree.leafCount !== expected.merkleLeafCount) {
    throw new V10ProofLeafCountMismatchError(tree.leafCount, expected.merkleLeafCount);
  }

  if (!bytesEqual(tree.root, expected.merkleRoot)) {
    throw new V10ProofRootMismatchError(tree.root, expected.merkleRoot);
  }

  if (chunkId < 0 || chunkId >= tree.leafCount) {
    throw new V10ProofChunkOutOfRangeError(chunkId, tree.leafCount);
  }

  return {
    leaf: tree.leafAt(chunkId),
    proof: tree.proof(chunkId),
    merkleRoot: tree.root,
    leafCount: tree.leafCount,
  };
}

/**
 * Round-trip self-check: verify the produced material against the
 * commitment using the on-chain-equivalent verifier. Used by tests and
 * by the prover as a defence-in-depth check before broadcasting
 * `submitProof` (the caller still pays gas if the chain disagrees).
 * Returns `true` only when {@link V10MerkleTree.verify} accepts.
 */
export function verifyV10ProofMaterial(
  material: V10ProofMaterial,
  chunkId: number,
  expected: V10MerkleCommitment,
): boolean {
  if (material.leafCount !== expected.merkleLeafCount) return false;
  if (!bytesEqual(material.merkleRoot, expected.merkleRoot)) return false;
  return V10MerkleTree.verify(expected.merkleRoot, material.leaf, material.proof, chunkId);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
