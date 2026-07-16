import { sha256 } from './hashing.js';

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
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
  return sha256(combined);
}

export class MerkleTree {
  private readonly layers: Uint8Array[][];
  private readonly _originalLeafCount: number;

  constructor(leaves: Uint8Array[]) {
    if (leaves.length === 0) {
      this.layers = [[]];
      this._originalLeafCount = 0;
      return;
    }

    const sorted = [...leaves].sort(compareBytes);
    this._originalLeafCount = sorted.length;
    this.layers = [sorted];
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
    const topLayer = this.layers[this.layers.length - 1];
    return topLayer[0];
  }

  get leafCount(): number {
    return this._originalLeafCount;
  }

  proof(leafIndex: number): Uint8Array[] {
    if (leafIndex < 0 || leafIndex >= this._originalLeafCount) {
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
   * If only one is present, it IS the KA root.
   */
  static computeKARoot(
    publicRoot?: Uint8Array,
    privateRoot?: Uint8Array,
  ): Uint8Array {
    if (publicRoot && privateRoot) {
      return hashPair(publicRoot, privateRoot);
    }
    if (publicRoot) return publicRoot;
    if (privateRoot) return privateRoot;
    return new Uint8Array(32);
  }

  /**
   * Builds a merkle tree from sorted KA roots to produce the KC root.
   */
  static computeKCRoot(kaRoots: Uint8Array[]): Uint8Array {
    const tree = new MerkleTree(kaRoots);
    return tree.root;
  }
}
