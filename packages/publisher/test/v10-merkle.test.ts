import { describe, it, expect } from 'vitest';
import { hashTripleV10, V10MerkleTree } from '@origintrail-official/dkg-core';
import {
  computeTripleHashV10,
  computePublicRootV10,
  computePrivateRootV10,
  computeFlatKCRootV10,
  computeFlatKCMerkleLeafCountV10,
  computeKARootV10,
  computeKCRootV10,
  SENTINEL_NO_PRIVATE_V10,
} from '../src/merkle.js';

const quad = (s: string, p: string, o: string) => ({
  subject: s, predicate: p, object: o, graph: 'http://test.graph',
});

describe('V10 publisher merkle wrappers', () => {
  describe('computeTripleHashV10', () => {
    it('matches hashTripleV10 from core', () => {
      const q = quad('http://example.org/e', 'http://schema.org/name', '"Alice"');
      const fromPublisher = computeTripleHashV10(q);
      const fromCore = hashTripleV10(q.subject, q.predicate, q.object);
      expect(fromPublisher).toEqual(fromCore);
    });

    it('produces 32-byte hash', () => {
      const h = computeTripleHashV10(quad('http://example.org/s', 'http://example.org/p', '"o"'));
      expect(h).toHaveLength(32);
    });
  });

  describe('computePublicRootV10', () => {
    it('returns undefined for empty quads', () => {
      expect(computePublicRootV10([])).toBeUndefined();
    });

    it('returns 32-byte root for non-empty quads', () => {
      const quads = [
        quad('http://example.org/e1', 'http://schema.org/name', '"Alice"'),
        quad('http://example.org/e1', 'http://schema.org/age', '"30"'),
      ];
      const root = computePublicRootV10(quads);
      expect(root).toHaveLength(32);
    });

    it('is order-independent', () => {
      const q1 = quad('http://example.org/e1', 'http://schema.org/name', '"A"');
      const q2 = quad('http://example.org/e2', 'http://schema.org/name', '"B"');
      const root1 = computePublicRootV10([q1, q2]);
      const root2 = computePublicRootV10([q2, q1]);
      expect(root1).toEqual(root2);
    });

    it('golden vector: single triple has root equal to its hash', () => {
      const q = quad('http://example.org/e', 'http://schema.org/name', '"Test"');
      const root = computePublicRootV10([q])!;
      const expected = hashTripleV10(q.subject, q.predicate, q.object);
      expect(root).toEqual(expected);
    });
  });

  describe('computePrivateRootV10', () => {
    it('returns undefined for empty quads', () => {
      expect(computePrivateRootV10([])).toBeUndefined();
    });

    it('returns 32-byte root for non-empty quads', () => {
      const quads = [
        quad('http://example.org/private', 'http://schema.org/secret', '"hidden"'),
      ];
      expect(computePrivateRootV10(quads)).toHaveLength(32);
    });
  });

  // STRUCTURED (PoS content-binding redesign): root = hashPair(publicRoot, privateDataHash).
  // Public is the challengeable subtree; private data is a committed sibling, never sampled.
  describe('computeFlatKCRootV10 (structured)', () => {
    const publicQuads = [
      quad('http://example.org/e1', 'http://schema.org/name', '"Alice"'),
      quad('http://example.org/e2', 'http://schema.org/name', '"Bob"'),
    ];

    it('is hashPair(publicRoot, collapsed privateDataHash)', () => {
      const privateRoots = [new Uint8Array(32).fill(0xab), new Uint8Array(32).fill(0xcd)];
      const root = computeFlatKCRootV10(publicQuads, privateRoots);
      const publicRoot = computePublicRootV10(publicQuads)!;
      const privateDataHash = new V10MerkleTree(privateRoots).root; // N->1 collapse
      expect(root).toEqual(computeKARootV10(publicRoot, privateDataHash));
      expect(root).toHaveLength(32);
    });

    it('private data is bound into the root (integrity): changing it changes the root', () => {
      const r1 = computeFlatKCRootV10(publicQuads, [new Uint8Array(32).fill(0x01)]);
      const r2 = computeFlatKCRootV10(publicQuads, [new Uint8Array(32).fill(0x02)]);
      expect(r1).not.toEqual(r2);
    });

    it('no private data uses the non-zero sentinel, NOT the bare public root', () => {
      const root = computeFlatKCRootV10(publicQuads, []);
      const publicRoot = computePublicRootV10(publicQuads)!;
      expect(root).not.toEqual(publicRoot); // would be the bypass-prone flat root
      expect(root).toEqual(computeKARootV10(publicRoot, SENTINEL_NO_PRIVATE_V10));
    });

    it('leaf count is PUBLIC-only and ignores private roots', () => {
      const withPrivate = computeFlatKCMerkleLeafCountV10(publicQuads, [new Uint8Array(32).fill(0x09)]);
      const noPrivate = computeFlatKCMerkleLeafCountV10(publicQuads, []);
      expect(withPrivate).toEqual(noPrivate);
      expect(noPrivate).toEqual(new V10MerkleTree(publicQuads.map(computeTripleHashV10)).leafCount);
    });
  });

  describe('computeKARootV10', () => {
    it('combines public and private roots', () => {
      const pub = new Uint8Array(32).fill(0x11);
      const priv = new Uint8Array(32).fill(0x22);
      const combined = computeKARootV10(pub, priv);
      expect(combined).toHaveLength(32);
      expect(combined).not.toEqual(pub);
      expect(combined).not.toEqual(priv);
    });

    it('returns public root when only public is provided', () => {
      const pub = new Uint8Array(32).fill(0x11);
      expect(computeKARootV10(pub)).toEqual(pub);
    });

    it('returns zero bytes when neither is provided', () => {
      expect(computeKARootV10()).toEqual(new Uint8Array(32));
    });
  });

  describe('computeKCRootV10', () => {
    it('produces root from KA roots', () => {
      const r1 = new Uint8Array(32).fill(0x11);
      const r2 = new Uint8Array(32).fill(0x22);
      const root = computeKCRootV10([r1, r2]);
      expect(root).toHaveLength(32);
    });

    it('is order-independent (sorted internally)', () => {
      const r1 = new Uint8Array(32).fill(0x11);
      const r2 = new Uint8Array(32).fill(0x22);
      expect(computeKCRootV10([r1, r2])).toEqual(computeKCRootV10([r2, r1]));
    });
  });

  describe('round-trip: quads → root → proof → verify', () => {
    it('proves a single triple in a multi-quad set', () => {
      const quads = [
        quad('http://example.org/e1', 'http://schema.org/name', '"Alice"'),
        quad('http://example.org/e1', 'http://schema.org/age', '"30"'),
        quad('http://example.org/e2', 'http://schema.org/name', '"Bob"'),
        quad('http://example.org/e2', 'http://schema.org/employer', 'http://example.org/corp'),
      ];

      const hashes = quads.map(computeTripleHashV10);
      const tree = new V10MerkleTree(hashes);

      const sorted = [...hashes].sort((a, b) => {
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) return a[i] - b[i];
        }
        return 0;
      });

      for (let i = 0; i < sorted.length; i++) {
        const proof = tree.proof(i);
        expect(V10MerkleTree.verify(tree.root, sorted[i], proof, i)).toBe(true);
      }
    });
  });
});
