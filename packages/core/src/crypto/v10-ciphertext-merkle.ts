/**
 * LU-11 / OT-RFC-39 — index-preserving Merkle tree over per-chunk
 * ciphertext digests for curated VM-publish.
 *
 * Why this is separate from {@link V10MerkleTree}:
 *
 *   {@link V10MerkleTree} (the KC-triple tree) **sorts and deduplicates**
 *   leaves before tree construction because public KC triples are an
 *   unordered set with possible duplicates — V10 canonicalises before
 *   hashing.
 *
 *   Ciphertext chunks are different in two ways that make sort+dedupe
 *   actively incorrect:
 *
 *   1. **Order is identity.** Random Sampling picks an on-chain
 *      `chunkId` uniformly in `[0, ciphertextChunkCount)` and the prover
 *      MUST load the ciphertext at exactly that chunk index. Sorting
 *      would scramble the publisher's chunk ordering, requiring a
 *      translation table no one has.
 *
 *   2. **Duplicates are real.** Two SWM messages can legitimately encode
 *      the same plaintext (idempotent re-attestation, identical agent
 *      heartbeats, etc.). Deduping would collapse the index space and
 *      break the `chunkId → chunk` mapping cores publish to chain.
 *
 * The pair-hash algorithm itself is unchanged from {@link V10MerkleTree}
 * (`keccak256(abi.encodePacked(left, right))`) so the on-chain
 * `_verifyV10MerkleProof` in `RandomSampling.sol` accepts proofs from
 * both trees verbatim — only the leaf preparation differs.
 *
 * Leaf convention: callers pass `keccak256(ct_i)` for each chunk in
 * chunkId order. The tree never touches the ciphertext bytes themselves.
 */

import { keccak256 } from './keccak.js';

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return keccak256(combined);
}

/**
 * Index-preserving binary Merkle tree over ciphertext-chunk leaves.
 *
 * Odd-count layers duplicate the last entry (same odd-padding rule as
 * {@link V10MerkleTree}) so `_verifyV10MerkleProof` parity arithmetic
 * lines up regardless of `ciphertextChunkCount`.
 */
export class V10CiphertextChunksMerkleTree {
  private readonly layers: Uint8Array[][];
  private readonly _leafCount: number;

  /**
   * @param leaves Pre-hashed chunk digests in chunkId order. Each entry
   * MUST be exactly 32 bytes (the keccak256 of one ciphertext chunk).
   * The tree intentionally does NOT call `keccak256` itself so callers
   * can pre-compute and cache leaves alongside the persisted chunks.
   */
  constructor(leaves: Uint8Array[]) {
    if (leaves.length === 0) {
      this.layers = [[]];
      this._leafCount = 0;
      return;
    }
    for (let i = 0; i < leaves.length; i++) {
      if (leaves[i].length !== 32) {
        throw new RangeError(
          `V10CiphertextChunksMerkleTree: leaf at index ${i} must be 32 bytes (got ${leaves[i].length})`,
        );
      }
    }
    this._leafCount = leaves.length;
    this.layers = [[...leaves]];
    this.buildTree();
  }

  private buildTree(): void {
    let current = this.layers[0];
    while (current.length > 1) {
      if (current.length % 2 !== 0) {
        current = [...current, current[current.length - 1]];
        this.layers[this.layers.length - 1] = current;
      }
      const next: Uint8Array[] = [];
      for (let i = 0; i < current.length; i += 2) {
        next.push(hashPair(current[i], current[i + 1]));
      }
      this.layers.push(next);
      current = next;
    }
  }

  /** Merkle root, or 32 zero bytes when leafCount === 0. */
  get root(): Uint8Array {
    if (this.layers[0].length === 0) return new Uint8Array(32);
    return this.layers[this.layers.length - 1][0];
  }

  /** Number of original chunkId-ordered leaves (pre-padding). */
  get leafCount(): number {
    return this._leafCount;
  }

  /**
   * Sibling-path proof for the leaf at `chunkIndex`. Compatible with
   * `RandomSampling._verifyV10MerkleProof(root, leaf, chunkIndex, proof)`.
   */
  proof(chunkIndex: number): Uint8Array[] {
    if (chunkIndex < 0 || chunkIndex >= this._leafCount) {
      throw new RangeError(`Chunk index ${chunkIndex} out of range [0, ${this._leafCount})`);
    }
    const siblings: Uint8Array[] = [];
    let idx = chunkIndex;
    for (let layer = 0; layer < this.layers.length - 1; layer++) {
      const current = this.layers[layer];
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (siblingIdx < current.length) {
        siblings.push(current[siblingIdx]);
      }
      idx = Math.floor(idx / 2);
    }
    return siblings;
  }

  /** Pre-hashed leaf at `chunkIndex` (the keccak256 the caller fed in). */
  leafAt(chunkIndex: number): Uint8Array {
    if (chunkIndex < 0 || chunkIndex >= this._leafCount) {
      throw new RangeError(`Chunk index ${chunkIndex} out of range [0, ${this._leafCount})`);
    }
    return this.layers[0][chunkIndex];
  }

  /**
   * Verify a chunk-Merkle proof using the same parity-driven pair-hash
   * algorithm as `RandomSampling._verifyV10MerkleProof`. Bytewise
   * identical output to {@link V10MerkleTree.verify} so an off-chain
   * caller can re-use either.
   */
  static verify(
    root: Uint8Array,
    leaf: Uint8Array,
    proof: Uint8Array[],
    chunkIndex: number,
  ): boolean {
    let hash = leaf;
    let idx = chunkIndex;
    for (const sibling of proof) {
      if (idx % 2 === 0) {
        hash = hashPair(hash, sibling);
      } else {
        hash = hashPair(sibling, hash);
      }
      idx = Math.floor(idx / 2);
    }
    return compareBytes(hash, root) === 0;
  }
}

export interface CiphertextChunksCommitment {
  /** 32-byte Merkle root, or 32 zero bytes when `chunks.length === 0`. */
  root: Uint8Array;
  /** Number of chunks (== on-chain `ciphertextChunkCount`). */
  leafCount: number;
  /** Pre-hashed leaves in chunkId order — `keccak256(ct_i)` per chunk. */
  leaves: Uint8Array[];
  /**
   * The tree itself. Held so callers that need proofs (publisher, prover)
   * can skip rebuilding. Heavy users that only need the root can discard.
   */
  tree: V10CiphertextChunksMerkleTree;
}

/**
 * Build a curated KC's `ciphertextChunksRoot` over an in-order array of
 * ciphertext chunks. Each chunk is hashed exactly once with keccak256
 * before tree construction; the tree's leafIndex is identical to the
 * publisher's chunkId and the on-chain `challenge.chunkId`.
 *
 * This is the canonical entrypoint used by:
 *  - the publisher when staging a curated PublishParams (computes root);
 *  - the core when reconciling locally-buffered chunks against the
 *    publisher's claimed root before ACK signing;
 *  - the prover when answering a curated random-sampling challenge.
 *
 * Pure function; no chain or filesystem coupling.
 */
export function buildCiphertextChunksRoot(chunks: Uint8Array[]): CiphertextChunksCommitment {
  const leaves = chunks.map((chunk) => keccak256(chunk));
  const tree = new V10CiphertextChunksMerkleTree(leaves);
  return {
    root: tree.root,
    leafCount: tree.leafCount,
    leaves,
    tree,
  };
}
