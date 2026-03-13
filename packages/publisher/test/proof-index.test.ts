import { describe, it, expect, beforeEach } from 'vitest';
import { MerkleTree, hashTriple } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { ProofIndex } from '../src/proof-index.js';

const GRAPH = 'did:dkg:paranet:test/contextGraphs/1';

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function hex(b: Uint8Array): string {
  return '0x' + Array.from(b).map(b => b.toString(16).padStart(2, '0')).join('');
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

describe('ProofIndex', () => {
  let index: ProofIndex;

  const CG_ID = '1';
  const BATCH_A = '10';
  const BATCH_B = '20';

  const triplesA: Quad[] = [
    q('did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"'),
    q('did:dkg:agent:Alice', 'http://schema.org/age', '"30"'),
    q('did:dkg:agent:Bob', 'http://schema.org/name', '"Bob"'),
  ];

  const triplesB: Quad[] = [
    q('did:dkg:agent:Charlie', 'http://schema.org/name', '"Charlie"'),
  ];

  beforeEach(() => {
    index = new ProofIndex();
  });

  describe('storeBatch + hasBatch', () => {
    it('stores a batch and reports it exists', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      expect(index.hasBatch(CG_ID, BATCH_A)).toBe(true);
      expect(index.hasBatch(CG_ID, 'nonexistent')).toBe(false);
      expect(index.hasBatch('other', BATCH_A)).toBe(false);
    });

    it('stores multiple batches for same context graph', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      index.storeBatch(CG_ID, BATCH_B, triplesB);
      expect(index.hasBatch(CG_ID, BATCH_A)).toBe(true);
      expect(index.hasBatch(CG_ID, BATCH_B)).toBe(true);
    });
  });

  describe('getBatchIds', () => {
    it('returns empty for unknown context graph', () => {
      expect(index.getBatchIds('unknown')).toEqual([]);
    });

    it('returns all batch ids for a context graph', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      index.storeBatch(CG_ID, BATCH_B, triplesB);
      const ids = index.getBatchIds(CG_ID);
      expect(ids).toContain(BATCH_A);
      expect(ids).toContain(BATCH_B);
      expect(ids).toHaveLength(2);
    });
  });

  describe('findTriple', () => {
    it('finds a triple in the correct batch', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      const hash = hashTriple('did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"');
      const found = index.findTriple(CG_ID, hash);
      expect(found).toBeDefined();
      expect(found!.batchId).toBe(BATCH_A);
      expect(found!.leafIndex).toBeGreaterThanOrEqual(0);
    });

    it('returns undefined for non-existent triple', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      const hash = hashTriple('did:dkg:agent:Unknown', 'http://schema.org/name', '"Nobody"');
      expect(index.findTriple(CG_ID, hash)).toBeUndefined();
    });

    it('returns undefined for non-existent context graph', () => {
      const hash = hashTriple('did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"');
      expect(index.findTriple('nonexistent', hash)).toBeUndefined();
    });

    it('searches across multiple batches', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      index.storeBatch(CG_ID, BATCH_B, triplesB);
      const hash = hashTriple('did:dkg:agent:Charlie', 'http://schema.org/name', '"Charlie"');
      const found = index.findTriple(CG_ID, hash);
      expect(found).toBeDefined();
      expect(found!.batchId).toBe(BATCH_B);
    });
  });

  describe('generateProof', () => {
    it('generates a valid Merkle proof for a stored triple', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);

      const proof = index.generateProof(
        CG_ID, 'did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"',
      );

      expect(proof).toBeDefined();
      expect(proof!.batchId).toBe(BATCH_A);
      expect(proof!.tripleHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(proof!.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
      expect(proof!.leafIndex).toBeGreaterThanOrEqual(0);
      expect(proof!.siblings.length).toBeGreaterThan(0);

      // Verify the proof is cryptographically correct
      const tripleHash = hashTriple('did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"');
      const hashes = triplesA.map(t => hashTriple(t.subject, t.predicate, t.object));
      const tree = new MerkleTree(hashes);

      expect(hex(tripleHash)).toBe(proof!.tripleHash);
      expect(hex(tree.root)).toBe(proof!.merkleRoot);
    });

    it('returns undefined for a triple not in the index', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      const proof = index.generateProof(
        CG_ID, 'did:dkg:agent:NoOne', 'http://schema.org/x', '"y"',
      );
      expect(proof).toBeUndefined();
    });

    it('proof verifies via MerkleTree.verify (power-of-2 batch)', () => {
      // Use a power-of-2 batch to avoid the known promoted-leaf issue
      // in MerkleTree.verify for odd-length layers (see merkle.test.ts)
      const evenTriples: Quad[] = [
        q('did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"'),
        q('did:dkg:agent:Alice', 'http://schema.org/age', '"30"'),
        q('did:dkg:agent:Bob', 'http://schema.org/name', '"Bob"'),
        q('did:dkg:agent:Bob', 'http://schema.org/age', '"25"'),
      ];
      index.storeBatch(CG_ID, '50', evenTriples);

      for (const triple of evenTriples) {
        const proof = index.generateProof(
          CG_ID, triple.subject, triple.predicate, triple.object,
        );
        expect(proof).toBeDefined();

        const leaf = hashTriple(triple.subject, triple.predicate, triple.object);
        const rootBytes = hexToBytes(proof!.merkleRoot);
        const siblingBytes = proof!.siblings.map(hexToBytes);

        expect(MerkleTree.verify(rootBytes, leaf, siblingBytes, proof!.leafIndex)).toBe(true);
      }
    });

    it('all proofs share the same merkle root for the same batch', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);

      const roots = triplesA.map(t => {
        const p = index.generateProof(CG_ID, t.subject, t.predicate, t.object);
        return p!.merkleRoot;
      });

      expect(new Set(roots).size).toBe(1);
    });

    it('different batches have different merkle roots', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      index.storeBatch(CG_ID, BATCH_B, triplesB);

      const rootA = index.getBatchMerkleRoot(CG_ID, BATCH_A);
      const rootB = index.getBatchMerkleRoot(CG_ID, BATCH_B);

      expect(rootA).not.toBe(rootB);
    });
  });

  describe('getBatchMerkleRoot', () => {
    it('returns the correct merkle root', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);

      const hashes = triplesA.map(t => hashTriple(t.subject, t.predicate, t.object));
      const tree = new MerkleTree(hashes);

      expect(index.getBatchMerkleRoot(CG_ID, BATCH_A)).toBe(hex(tree.root));
    });

    it('returns undefined for unknown batch', () => {
      expect(index.getBatchMerkleRoot(CG_ID, 'unknown')).toBeUndefined();
    });
  });

  describe('getMerkleRoots', () => {
    it('returns roots for requested batch ids', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      index.storeBatch(CG_ID, BATCH_B, triplesB);

      const roots = index.getMerkleRoots(CG_ID, [BATCH_A, BATCH_B]);
      expect(Object.keys(roots)).toHaveLength(2);
      expect(roots[BATCH_A]).toMatch(/^0x[0-9a-f]{64}$/);
      expect(roots[BATCH_B]).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('skips unknown batch ids', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      const roots = index.getMerkleRoots(CG_ID, [BATCH_A, 'unknown']);
      expect(Object.keys(roots)).toHaveLength(1);
      expect(roots[BATCH_A]).toBeDefined();
    });
  });

  describe('clear', () => {
    it('clears a specific context graph', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      index.storeBatch('2', BATCH_B, triplesB);
      index.clear(CG_ID);
      expect(index.hasBatch(CG_ID, BATCH_A)).toBe(false);
      expect(index.hasBatch('2', BATCH_B)).toBe(true);
    });

    it('clears all context graphs', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);
      index.storeBatch('2', BATCH_B, triplesB);
      index.clear();
      expect(index.getBatchIds(CG_ID)).toHaveLength(0);
      expect(index.getBatchIds('2')).toHaveLength(0);
    });
  });

  describe('leaf ordering', () => {
    it('leaf indices follow sorted hash order (not insertion order)', () => {
      index.storeBatch(CG_ID, BATCH_A, triplesA);

      const hashes = triplesA.map(t => hashTriple(t.subject, t.predicate, t.object));
      const sorted = [...hashes].sort(compareBytes);

      for (let i = 0; i < sorted.length; i++) {
        const found = index.findTriple(CG_ID, sorted[i]);
        expect(found).toBeDefined();
        expect(found!.leafIndex).toBe(i);
      }
    });
  });
});

function hexToBytes(h: string): Uint8Array {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
