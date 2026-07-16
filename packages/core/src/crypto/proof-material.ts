import { V10MerkleTree, structuredKARootV10 } from './v10-merkle.js';
import { buildCiphertextChunksRoot } from './v10-ciphertext-merkle.js';
import { keccak256 } from './keccak.js';

/**
 * Bytes the off-chain Random Sampling prover must submit to
 * `RandomSampling.submitProof(leaf, merkleProof)`. Bound to the
 * canonical V10 sort+dedupe leaf set so the chain accepts it on the
 * first try.
 */
export interface V10ProofMaterial {
  /**
   * The CONTENT the prover submits to `submitProof(bytes content, ...)`; the
   * chain derives `leaf = keccak256(content)` (content-binding — an attacker
   * can no longer echo the public root as a leaf). Public path: the canonical
   * N-Triple bytes of the challenged triple. Curated path: the raw chunk bytes.
   */
  content: Uint8Array;
  /** `keccak256(content)` — the leaf at `chunkId` after V10 sort+dedupe. */
  leaf: Uint8Array;
  /** Merkle siblings from the leaf to the root (public path ends with `privateDataHash`). */
  proof: Uint8Array[];
  /** Recomputed root; matches `expected.merkleRoot` (asserted before return). */
  merkleRoot: Uint8Array;
  /** Recomputed deduped leaf count; matches `expected.merkleLeafCount` (asserted before return). */
  leafCount: number;
}

/**
 * Expected on-chain merkle commitment, read from
 * `KnowledgeCollectionStorage.getLatestMerkleRoot(kaId)` +
 * `getMerkleLeafCount(kaId)` before building the proof.
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
 * commitment came from the wrong kaId.
 */
export class V10ProofChunkOutOfRangeError extends RangeError {
  readonly name = 'V10ProofChunkOutOfRangeError';
  constructor(readonly chunkId: number, readonly leafCount: number) {
    super(`V10 proof chunkId ${chunkId} out of range [0, ${leafCount})`);
  }
}

/**
 * Build the `submitProof` argument tuple for the PUBLIC path (content-binding +
 * structured tree).
 *
 * Inputs:
 *  - `publicLeafContents`: the canonical N-Triple bytes (`<s> <p> <o> .`) of each
 *    public triple, **unsorted/undeduped**. The leaf is `keccak256(content)`, so
 *    the prover submits the content and the chain re-derives the leaf — closing
 *    the empty-proof bypass (no triple preimage hashes to the public root).
 *  - `privateRoots`: per-entity private sub-roots, collapsed N->1 and committed
 *    as the RIGHT sibling (integrity preserved) but never a challengeable leaf.
 *
 * The commitment goes through the shared `structuredKARootV10`, so it agrees
 * byte-for-byte with the publisher and the on-chain verify. The proof is
 * `[...publicSubtreeProof(chunkId), privateDataHash]`, which folds
 * `leaf -> publicRoot -> hashPair(publicRoot, privateDataHash) == merkleRoot`.
 *
 * Fail-fast contract — every mismatch is non-retryable for the current period:
 *  1. assert recomputed public-only `leafCount == expected.merkleLeafCount`,
 *  2. assert recomputed structured `root == expected.merkleRoot`,
 *  3. assert `chunkId < leafCount`,
 *  4. emit `(content, leaf, proof, root, leafCount)`.
 */
export function buildV10ProofMaterial(
  publicLeafContents: Uint8Array[],
  privateRoots: Uint8Array[],
  chunkId: number,
  expected: V10MerkleCommitment,
): V10ProofMaterial {
  const leaves = publicLeafContents.map((c) => keccak256(c));
  const { root: merkleRoot, leafCount, publicTree, privateDataHash } = structuredKARootV10(leaves, privateRoots);

  if (leafCount !== expected.merkleLeafCount) {
    throw new V10ProofLeafCountMismatchError(leafCount, expected.merkleLeafCount);
  }
  if (!bytesEqual(merkleRoot, expected.merkleRoot)) {
    throw new V10ProofRootMismatchError(merkleRoot, expected.merkleRoot);
  }
  if (chunkId < 0 || chunkId >= leafCount) {
    throw new V10ProofChunkOutOfRangeError(chunkId, leafCount);
  }

  // Recover the content for the post-sort+dedupe leaf at `chunkId` (no tree surgery).
  const leafHash = publicTree.leafAt(chunkId);
  const byHash = new Map(leaves.map((h, i) => [toHex(h), publicLeafContents[i]]));
  const content = byHash.get(toHex(leafHash));
  if (content === undefined) {
    throw new Error('V10 proof: no content for the challenged leaf (sort/dedupe drift)');
  }

  return {
    content,
    leaf: leafHash,
    proof: [...publicTree.proof(chunkId), privateDataHash],
    merkleRoot,
    leafCount,
  };
}

/**
 * CATALOG path (OT-RFC-49) — content-binding over the curated public `_catalog`.
 *
 * The catalog commitment is a PLAIN `V10MerkleTree` over the catalog triples (no
 * private sibling — the catalog is wholly public), so unlike the structured
 * public-CG path there is no `privateDataHash` to append. Content-binding still
 * applies: the prover submits the catalog triple's N-Triple bytes and the chain
 * derives `leaf = keccak256(content) = hashTripleV10(...)`.
 */
export function buildV10CatalogProofMaterial(
  catalogContents: Uint8Array[],
  chunkId: number,
  expected: V10MerkleCommitment,
): V10ProofMaterial {
  const leaves = catalogContents.map((c) => keccak256(c));
  const tree = new V10MerkleTree(leaves);

  if (tree.leafCount !== expected.merkleLeafCount) {
    throw new V10ProofLeafCountMismatchError(tree.leafCount, expected.merkleLeafCount);
  }
  if (!bytesEqual(tree.root, expected.merkleRoot)) {
    throw new V10ProofRootMismatchError(tree.root, expected.merkleRoot);
  }
  if (chunkId < 0 || chunkId >= tree.leafCount) {
    throw new V10ProofChunkOutOfRangeError(chunkId, tree.leafCount);
  }

  const leafHash = tree.leafAt(chunkId);
  const byHash = new Map(leaves.map((h, i) => [toHex(h), catalogContents[i]]));
  const content = byHash.get(toHex(leafHash));
  if (content === undefined) {
    throw new Error('V10 catalog proof: no content for the challenged leaf (sort/dedupe drift)');
  }

  return { content, leaf: leafHash, proof: tree.proof(chunkId), merkleRoot: tree.root, leafCount: tree.leafCount };
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
  // content-binding: the leaf MUST be keccak256(content) — mirrors the chain.
  const leaf = keccak256(material.content);
  if (!bytesEqual(leaf, material.leaf)) return false;
  return V10MerkleTree.verify(expected.merkleRoot, leaf, material.proof, chunkId);
}

/**
 * OT-RFC-39 — curated counterpart of {@link buildV10ProofMaterial}.
 *
 * Builds the `submitProof` argument tuple from raw ciphertext chunks
 * (in chunkId order, NOT sorted/deduped). The `V10CiphertextChunksMerkleTree`
 * hash algorithm is identical to {@link V10MerkleTree} so the on-chain
 * `_verifyV10MerkleProof` accepts the resulting proof verbatim; the
 * only difference is leaf preparation:
 *   - public:  sort + dedupe + use leaf-as-given (publisher already hashed)
 *   - curated: keep order + keep duplicates + hash chunk bytes
 *
 * Same fail-fast contract as the public path:
 *   1. recompute `tree.leafCount`; assert it equals `expected.merkleLeafCount`,
 *   2. recompute `tree.root`; assert it equals `expected.merkleRoot`,
 *   3. assert `chunkId < tree.leafCount`,
 *   4. emit `(leaf, proof, root, leafCount)`.
 *
 * `expected.merkleRoot` here is the on-chain
 * `KnowledgeCollectionStorage.getLatestCiphertextChunksRoot(kaId)`;
 * `expected.merkleLeafCount` is `getCiphertextChunkCount(kaId)`.
 *
 * Pure: depends only on `V10CiphertextChunksMerkleTree`. No `Quad`/storage
 * dependency lives in `dkg-core` — the boundary is owned by the
 * `packages/random-sampling` ciphertext-chunk extractor.
 */
export function buildV10CiphertextChunksProofMaterial(
  ciphertextChunks: Uint8Array[],
  chunkId: number,
  expected: V10MerkleCommitment,
): V10ProofMaterial {
  const { root, leafCount, tree } = buildCiphertextChunksRoot(ciphertextChunks);

  if (leafCount !== expected.merkleLeafCount) {
    throw new V10ProofLeafCountMismatchError(leafCount, expected.merkleLeafCount);
  }

  if (!bytesEqual(root, expected.merkleRoot)) {
    throw new V10ProofRootMismatchError(root, expected.merkleRoot);
  }

  if (chunkId < 0 || chunkId >= leafCount) {
    throw new V10ProofChunkOutOfRangeError(chunkId, leafCount);
  }

  return {
    // Curated content-binding: chain derives leaf = keccak256(content).
    // NOTE (Phase 2): post-RFC-49 the curated branch samples the public `_catalog`
    // (computeCatalogRoot), not ciphertext. The catalog proof path will supply the
    // catalog N-Triple bytes as `content`; this ciphertext path is kept for parity.
    content: ciphertextChunks[chunkId],
    leaf: tree.leafAt(chunkId),
    proof: tree.proof(chunkId),
    merkleRoot: root,
    leafCount,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
