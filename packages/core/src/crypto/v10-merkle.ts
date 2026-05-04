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
 * V10 Merkle tree using keccak256 pair hashing, matching on-chain Solidity verification.
 *
 * Algorithm (spec §9.0.2):
 * 1. Sort leaves lexicographically (byte-order)
 * 2. Deduplicate exact matches
 * 3. If odd count, duplicate last leaf
 * 4. Pair-hash: keccak256(abi.encodePacked(left, right))
 * 5. Repeat until one root remains
 */
export class V10MerkleTree {
  private readonly layers: Uint8Array[][];
  private readonly _leafCount: number;

  constructor(leaves: Uint8Array[]) {
    if (leaves.length === 0) {
      this.layers = [[]];
      this._leafCount = 0;
      return;
    }

    const sorted = [...leaves].sort(compareBytes);

    const deduped: Uint8Array[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (compareBytes(sorted[i], sorted[i - 1]) !== 0) {
        deduped.push(sorted[i]);
      }
    }

    this._leafCount = deduped.length;
    this.layers = [deduped];
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

  get root(): Uint8Array {
    if (this.layers[0].length === 0) return new Uint8Array(32);
    return this.layers[this.layers.length - 1][0];
  }

  get leafCount(): number {
    return this._leafCount;
  }

  proof(leafIndex: number): Uint8Array[] {
    if (leafIndex < 0 || leafIndex >= this._leafCount) {
      throw new RangeError(`Leaf index ${leafIndex} out of range`);
    }

    const siblings: Uint8Array[] = [];
    let idx = leafIndex;

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

  /**
   * Returns the leaf bytes at the given **post-sort+dedupe** index (the
   * same index space used by `proof(leafIndex)` and the on-chain
   * `chunkId`). The Random Sampling prover passes this value as the
   * `leaf` argument to `submitProof`; without it, callers would have to
   * re-implement V10's sort+dedupe just to read back the canonical leaf
   * the chain expects.
   *
   * Throws `RangeError` for indices outside `[0, leafCount)` — same
   * boundary as `proof()` so a caller can do the bounds check once.
   */
  leafAt(leafIndex: number): Uint8Array {
    if (leafIndex < 0 || leafIndex >= this._leafCount) {
      throw new RangeError(`Leaf index ${leafIndex} out of range`);
    }
    return this.layers[0][leafIndex];
  }

  static verify(
    root: Uint8Array,
    leaf: Uint8Array,
    proof: Uint8Array[],
    leafIndex: number,
  ): boolean {
    let hash = leaf;
    let idx = leafIndex;

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

  /**
   * Combines public and private sub-roots into a single KA root.
   */
  static computeKARoot(
    publicRoot?: Uint8Array,
    privateRoot?: Uint8Array,
  ): Uint8Array {
    if (publicRoot && privateRoot) return hashPair(publicRoot, privateRoot);
    if (publicRoot) return publicRoot;
    if (privateRoot) return privateRoot;
    return new Uint8Array(32);
  }

  /**
   * Builds a V10 merkle tree from sorted KA roots to produce the KC root.
   */
  static computeKCRoot(kaRoots: Uint8Array[]): Uint8Array {
    return new V10MerkleTree(kaRoots).root;
  }
}
