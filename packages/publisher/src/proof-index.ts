import { MerkleTree, hashTriple } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

export interface TripleProof {
  tripleHash: string;
  leafIndex: number;
  siblings: string[];
  merkleRoot: string;
  batchId: string;
}

interface BatchEntry {
  sortedHashes: Uint8Array[];
  hashHexToIndex: Map<string, number>;
}

function toHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Maintains a mapping from (contextGraphId, batchId) → sorted triple hashes.
 * Used by the Context Oracle to generate Merkle inclusion proofs at query time.
 */
export class ProofIndex {
  private batches = new Map<string, Map<string, BatchEntry>>();

  private key(contextGraphId: string): Map<string, BatchEntry> {
    let map = this.batches.get(contextGraphId);
    if (!map) {
      map = new Map();
      this.batches.set(contextGraphId, map);
    }
    return map;
  }

  /**
   * Store sorted triple hashes for a batch. Called during publishToContextGraph.
   */
  storeBatch(contextGraphId: string, batchId: string, quads: Quad[]): void {
    const hashes = quads.map(q => hashTriple(q.subject, q.predicate, q.object));
    const sorted = [...hashes].sort(compareBytes);

    const hashHexToIndex = new Map<string, number>();
    for (let i = 0; i < sorted.length; i++) {
      hashHexToIndex.set(toHex(sorted[i]), i);
    }

    this.key(contextGraphId).set(batchId, { sortedHashes: sorted, hashHexToIndex });
  }

  /**
   * Find which batch contains a triple (by its hash) and return its leaf index.
   */
  findTriple(contextGraphId: string, tripleHash: Uint8Array): { batchId: string; leafIndex: number } | undefined {
    const hex = toHex(tripleHash);
    const map = this.batches.get(contextGraphId);
    if (!map) return undefined;

    for (const [batchId, entry] of map) {
      const idx = entry.hashHexToIndex.get(hex);
      if (idx !== undefined) return { batchId, leafIndex: idx };
    }
    return undefined;
  }

  /**
   * Generate a Merkle inclusion proof for a specific triple in a context graph.
   */
  generateProof(contextGraphId: string, subject: string, predicate: string, object: string): TripleProof | undefined {
    const tripleHash = hashTriple(subject, predicate, object);
    const location = this.findTriple(contextGraphId, tripleHash);
    if (!location) return undefined;

    const entry = this.key(contextGraphId).get(location.batchId);
    if (!entry) return undefined;

    const tree = new MerkleTree(entry.sortedHashes);
    const siblings = tree.proof(location.leafIndex);

    return {
      tripleHash: toHex(tripleHash),
      leafIndex: location.leafIndex,
      siblings: siblings.map(toHex),
      merkleRoot: toHex(tree.root),
      batchId: location.batchId,
    };
  }

  /**
   * Get all batch IDs for a context graph.
   */
  getBatchIds(contextGraphId: string): string[] {
    const map = this.batches.get(contextGraphId);
    return map ? [...map.keys()] : [];
  }

  /**
   * Get the merkle root for a specific batch (recomputed from stored hashes).
   */
  getBatchMerkleRoot(contextGraphId: string, batchId: string): string | undefined {
    const entry = this.key(contextGraphId).get(batchId);
    if (!entry || entry.sortedHashes.length === 0) return undefined;
    const tree = new MerkleTree(entry.sortedHashes);
    return toHex(tree.root);
  }

  /**
   * Get all merkle roots for batches that appear in a set of proofs.
   */
  getMerkleRoots(contextGraphId: string, batchIds: string[]): Record<string, string> {
    const roots: Record<string, string> = {};
    for (const bid of batchIds) {
      const root = this.getBatchMerkleRoot(contextGraphId, bid);
      if (root) roots[bid] = root;
    }
    return roots;
  }

  hasBatch(contextGraphId: string, batchId: string): boolean {
    return this.key(contextGraphId).has(batchId);
  }

  clear(contextGraphId?: string): void {
    if (contextGraphId) {
      this.batches.delete(contextGraphId);
    } else {
      this.batches.clear();
    }
  }
}
