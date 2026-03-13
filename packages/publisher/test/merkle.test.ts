/**
 * Robust Merkle and triple-hashing tests for the publisher.
 *
 * The algorithm must be stable and identical everywhere the root is computed:
 * - Publisher (this package) when publishing/updating
 * - Receivers when verifying P2P data
 * - On-chain random sampling proof verification (contract must use the same
 *   triple hash format and tree construction; see SPEC and RandomSampling.sol)
 *
 * Algorithm (lock in):
 * - Triple hash: SHA-256(UTF-8(canonical N-Triple line)). Graph excluded.
 *   N-Triple: <s> <p> o . (URIs in angle brackets, literals as-is, space before period)
 * - We do NOT sort triples. We hash each triple → get one 32-byte leaf per triple,
 *   then SORT those leaves (byte comparison) before building the tree. So the same
 *   set of triples in any order yields the same root.
 * - Public/private root: sort leaf hashes, then Merkle tree with
 *   SHA-256(left || right) for internal nodes. Single leaf → root = leaf.
 * - KA root: SHA-256(publicRoot || privateRoot) when both present; else the single one.
 * - KC root: Merkle tree over sorted KA roots (same tree construction).
 *
 * On-chain alignment: The root we submit at publish time is computed with this
 * algorithm. For random-sampling proof verification the contract must reconstruct
 * the same root from chunk + proof; that requires the same triple serialization
 * and the same hash (SHA-256) and tree construction. These tests are the spec.
 */
import { describe, it, expect } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import { MerkleTree, hashTriple, sha256 } from '@origintrail-official/dkg-core';
import {
  computeTripleHash,
  computePublicRoot,
  computePrivateRoot,
  computeKARoot,
  computeKCRoot,
} from '../src/merkle.js';

const GRAPH = 'did:dkg:paranet:test';

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

describe('Merkle / triple hashing (robust)', () => {
  describe('computeTripleHash (hashTriple) — canonical N-Triple + SHA-256', () => {
    it('is deterministic for the same triple', () => {
      const quad = q('did:dkg:agent:QmBot', 'http://schema.org/name', '"Bot"');
      const h1 = computeTripleHash(quad);
      const h2 = computeTripleHash(quad);
      expect(h1).toEqual(h2);
      expect(h1).toHaveLength(32);
    });

    it('produces a fixed golden hash for a known triple (algorithm stability)', () => {
      // N-Triple line: <did:dkg:agent:QmBot> <http://schema.org/name> "Bot" .
      // Hash = SHA-256(UTF-8(that string)). Any change in format or hash breaks this.
      const quad = q('did:dkg:agent:QmBot', 'http://schema.org/name', '"Bot"');
      const h = computeTripleHash(quad);
      const actualHex = hex(h);
      expect(actualHex).toHaveLength(64);
      expect(actualHex).toMatch(/^[0-9a-f]+$/);
      // Golden: lock in so on-chain and other clients can rely on same algorithm
      const goldenHex =
        '6822626fbdbea2f4ae31db12f3b95a8db7e9a4ed1875cd09954afd6dd673f448';
      // If this fails, hashing changed; update golden only after intentional spec change
      expect(actualHex).toBe(goldenHex);
    });

    it('different subject changes the hash', () => {
      const h1 = computeTripleHash(q('did:dkg:agent:A', 'http://ex.org/p', '"v"'));
      const h2 = computeTripleHash(q('did:dkg:agent:B', 'http://ex.org/p', '"v"'));
      expect(h1).not.toEqual(h2);
    });

    it('different predicate changes the hash', () => {
      const h1 = computeTripleHash(q('did:dkg:agent:A', 'http://ex.org/p1', '"v"'));
      const h2 = computeTripleHash(q('did:dkg:agent:A', 'http://ex.org/p2', '"v"'));
      expect(h1).not.toEqual(h2);
    });

    it('different object changes the hash', () => {
      const h1 = computeTripleHash(q('did:dkg:agent:A', 'http://ex.org/p', '"v1"'));
      const h2 = computeTripleHash(q('did:dkg:agent:A', 'http://ex.org/p', '"v2"'));
      expect(h1).not.toEqual(h2);
    });

    it('graph is excluded from the hash', () => {
      const quad1 = { ...q('s', 'p', '"o"'), graph: 'g1' };
      const quad2 = { ...q('s', 'p', '"o"'), graph: 'g2' };
      expect(computeTripleHash(quad1)).toEqual(computeTripleHash(quad2));
    });

    it('matches @origintrail-official/dkg-core hashTriple for same (s,p,o)', () => {
      const subject = 'did:dkg:agent:QmBot';
      const predicate = 'http://schema.org/name';
      const object = '"Bot"';
      const coreHash = hashTriple(subject, predicate, object);
      const quadHash = computeTripleHash(q(subject, predicate, object));
      expect(quadHash).toEqual(coreHash);
    });

    it('exact N-Triple string is documented for implementers', () => {
      // Canonical form: bare URIs wrapped in <>, literals quoted as-is, space before period
      // So: <did:dkg:agent:QmBot> <http://schema.org/name> "Bot" .
      const expectedNTriple =
        '<did:dkg:agent:QmBot> <http://schema.org/name> "Bot" .';
      const encoded = new TextEncoder().encode(expectedNTriple);
      const expectedHash = sha256(encoded);
      const h = hashTriple('did:dkg:agent:QmBot', 'http://schema.org/name', '"Bot"');
      expect(h).toEqual(expectedHash);
      expect(hex(h)).toBe(
        '6822626fbdbea2f4ae31db12f3b95a8db7e9a4ed1875cd09954afd6dd673f448',
      );
    });
  });

  describe('computePublicRoot — sorted triple hashes, Merkle tree', () => {
    it('empty quads returns undefined', () => {
      expect(computePublicRoot([])).toBeUndefined();
    });

    it('single triple: root equals that triple hash', () => {
      const quads = [q('did:dkg:agent:QmBot', 'http://schema.org/name', '"Bot"')];
      const root = computePublicRoot(quads);
      expect(root).toBeDefined();
      expect(root).toEqual(computeTripleHash(quads[0]));
      expect(root!).toHaveLength(32);
    });

    it('two triples: root is SHA-256(sorted_leaf_0 || sorted_leaf_1)', () => {
      const q1 = q('did:dkg:agent:A', 'http://ex.org/p', '"a"');
      const q2 = q('did:dkg:agent:B', 'http://ex.org/p', '"b"');
      const h1 = computeTripleHash(q1);
      const h2 = computeTripleHash(q2);
      const [first, second] = [h1, h2].slice().sort((a, b) => {
        for (let i = 0; i < 32; i++) {
          if (a[i] !== b[i]) return a[i]! - b[i]!;
        }
        return 0;
      });
      const expectedRoot = new MerkleTree([first, second]).root;
      const actualRoot = computePublicRoot([q1, q2]);
      expect(actualRoot).toEqual(expectedRoot);
    });

    it('order of quads does not change the root (sorted internally)', () => {
      const q1 = q('did:dkg:agent:A', 'http://ex.org/p', '"a"');
      const q2 = q('did:dkg:agent:B', 'http://ex.org/p', '"b"');
      const root1 = computePublicRoot([q1, q2]);
      const root2 = computePublicRoot([q2, q1]);
      expect(root1).toEqual(root2);
    });

    it('three triples produce a deterministic root', () => {
      const quads = [
        q('did:dkg:agent:X', 'http://ex.org/name', '"X"'),
        q('did:dkg:agent:X', 'http://ex.org/version', '"1"'),
        q('did:dkg:agent:Y', 'http://ex.org/name', '"Y"'),
      ];
      const rootA = computePublicRoot(quads);
      const rootB = computePublicRoot([quads[1]!, quads[0]!, quads[2]!]);
      expect(rootA).toEqual(rootB);
      expect(rootA).toHaveLength(32);
    });

    it('we sort leaf hashes, not triples (order of triples does not affect root)', () => {
      const triples = [
        q('did:dkg:agent:C', 'http://ex.org/p', '"c"'),
        q('did:dkg:agent:A', 'http://ex.org/p', '"a"'),
        q('did:dkg:agent:B', 'http://ex.org/p', '"b"'),
      ];
      const root1 = computePublicRoot(triples);
      const root2 = computePublicRoot([triples[1]!, triples[2]!, triples[0]!]);
      expect(root1).toEqual(root2);
      // MerkleTree sorts the hashes; we never sort the triples themselves
      const hashes = triples.map(computeTripleHash);
      const sortedHashes = [...hashes].sort((a, b) => {
        for (let i = 0; i < 32; i++) {
          if (a[i] !== b[i]) return a[i]! - b[i]!;
        }
        return 0;
      });
      expect(computePublicRoot(triples)).toEqual(new MerkleTree(sortedHashes).root);
    });

    it('golden: public root of two fixed triples (tree construction lock-in)', () => {
      const q1 = q('did:dkg:agent:A', 'http://ex.org/p', '"a"');
      const q2 = q('did:dkg:agent:B', 'http://ex.org/p', '"b"');
      const root = computePublicRoot([q1, q2]);
      const actualHex = hex(root!);
      const goldenHex =
        '63b5357065c378a07731992abbcb97407ceeacc2798b29d76846cf56edd960b3';
      expect(actualHex).toHaveLength(64);
      expect(actualHex).toBe(goldenHex);
    });

    it('golden: public root of six fixed triples (multi-level tree lock-in)', () => {
      const triples = [
        q('did:dkg:agent:Entity1', 'http://schema.org/name', '"Entity1"'),
        q('did:dkg:agent:Entity1', 'http://schema.org/version', '"1"'),
        q('did:dkg:agent:Entity2', 'http://schema.org/name', '"Entity2"'),
        q('did:dkg:agent:Entity2', 'http://schema.org/version', '"2"'),
        q('did:dkg:agent:Entity3', 'http://schema.org/name', '"Entity3"'),
        q('did:dkg:agent:Entity3', 'http://schema.org/version', '"3"'),
      ];
      const root = computePublicRoot(triples);
      const actualHex = hex(root!);
      const goldenHex =
        '89a5e67f0c299318f22ba653ebae8eb5eb98e49f69126e901b067a6596abcc4b';
      expect(actualHex).toHaveLength(64);
      expect(actualHex).toBe(goldenHex);
    });
  });

  describe('computePrivateRoot', () => {
    it('empty returns undefined', () => {
      expect(computePrivateRoot([])).toBeUndefined();
    });

    it('same algorithm as public root (deterministic, sorted)', () => {
      const quads = [q('did:dkg:agent:QmBot', 'http://ex.org/secret', '"s1"')];
      const root = computePrivateRoot(quads);
      expect(root).toBeDefined();
      expect(root).toEqual(computeTripleHash(quads[0]));
    });
  });

  describe('computeKARoot', () => {
    it('only public root returns it unchanged', () => {
      const pub = computePublicRoot([q('s', 'p', '"o"')])!;
      expect(computeKARoot(pub, undefined)).toEqual(pub);
    });

    it('only private root returns it unchanged', () => {
      const priv = computePrivateRoot([q('s', 'p', '"o"')])!;
      expect(computeKARoot(undefined, priv)).toEqual(priv);
    });

    it('both: combined with SHA-256(publicRoot || privateRoot)', () => {
      const pub = computePublicRoot([q('s', 'p', '"pub"')])!;
      const priv = computePrivateRoot([q('s', 'p', '"priv"')])!;
      const combined = computeKARoot(pub, priv);
      const expected = new MerkleTree([pub, priv]).root;
      expect(combined).toEqual(expected);
      expect(combined).not.toEqual(pub);
      expect(combined).not.toEqual(priv);
    });

    it('neither returns 32 zero bytes', () => {
      const z = computeKARoot(undefined, undefined);
      expect(z).toHaveLength(32);
      expect(z.every((b) => b === 0)).toBe(true);
    });
  });

  describe('computeKCRoot', () => {
    it('sorts KA roots and builds tree (order-independent)', () => {
      const r1 = computePublicRoot([q('did:dkg:agent:A', 'http://ex.org/p', '"a"')])!;
      const r2 = computePublicRoot([q('did:dkg:agent:B', 'http://ex.org/p', '"b"')])!;
      const root1 = computeKCRoot([r1, r2]);
      const root2 = computeKCRoot([r2, r1]);
      expect(root1).toEqual(root2);
      expect(root1).toHaveLength(32);
    });

    it('single KA root equals that root', () => {
      const kaRoot = computePublicRoot([q('s', 'p', '"o"')])!;
      expect(computeKCRoot([kaRoot])).toEqual(kaRoot);
    });

    it('empty KA roots array produces 32 zero bytes', () => {
      const z = computeKCRoot([]);
      expect(z).toHaveLength(32);
      expect(z.every((b) => b === 0)).toBe(true);
    });
  });

  describe('proof generation and verification (on-chain compatible)', () => {
    it('MerkleTree.verify accepts proof produced by same tree', () => {
      const quads = [
        q('did:dkg:agent:A', 'http://ex.org/p', '"a"'),
        q('did:dkg:agent:B', 'http://ex.org/p', '"b"'),
        q('did:dkg:agent:C', 'http://ex.org/p', '"c"'),
        q('did:dkg:agent:D', 'http://ex.org/p', '"d"'),
      ];
      const hashes = quads.map((q) => computeTripleHash(q));
      const tree = new MerkleTree(hashes);
      const root = tree.root;
      const compareBytes = (a: Uint8Array, b: Uint8Array) => {
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) return a[i]! - b[i]!;
        }
        return a.length - b.length;
      };
      const sortedLeaves = [...hashes].sort(compareBytes);

      for (let i = 0; i < sortedLeaves.length; i++) {
        const proof = tree.proof(i);
        expect(MerkleTree.verify(root, sortedLeaves[i]!, proof, i)).toBe(true);
      }
    });

    it('public root matches manual tree from same triples', () => {
      const quads = [
        q('did:dkg:agent:X', 'http://ex.org/name', '"X"'),
        q('did:dkg:agent:X', 'http://ex.org/version', '"1"'),
      ];
      const rootFromPublisher = computePublicRoot(quads);
      const hashes = quads.map(computeTripleHash);
      const manualTree = new MerkleTree(hashes);
      expect(rootFromPublisher).toEqual(manualTree.root);
    });

    it('proof verification for 6-leaf tree (multi-level)', () => {
      const triples = [
        q('did:dkg:agent:Entity1', 'http://schema.org/name', '"Entity1"'),
        q('did:dkg:agent:Entity1', 'http://schema.org/version', '"1"'),
        q('did:dkg:agent:Entity2', 'http://schema.org/name', '"Entity2"'),
        q('did:dkg:agent:Entity2', 'http://schema.org/version', '"2"'),
        q('did:dkg:agent:Entity3', 'http://schema.org/name', '"Entity3"'),
        q('did:dkg:agent:Entity3', 'http://schema.org/version', '"3"'),
      ];
      const hashes = triples.map(computeTripleHash);
      const tree = new MerkleTree(hashes);
      const root = tree.root;
      const compareBytes = (a: Uint8Array, b: Uint8Array) => {
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) return a[i]! - b[i]!;
        }
        return a.length - b.length;
      };
      const sortedLeaves = [...hashes].sort(compareBytes);
      expect(root).toHaveLength(32);
      expect(hex(root)).toBe(
        '89a5e67f0c299318f22ba653ebae8eb5eb98e49f69126e901b067a6596abcc4b',
      );

      for (let i = 0; i < sortedLeaves.length; i++) {
        const proof = tree.proof(i);
        expect(MerkleTree.verify(root, sortedLeaves[i]!, proof, i)).toBe(true);
      }
    });
  });

  describe('full pipeline: flat KC root (entityProofs false)', () => {
    it('one KA with one triple: KC root equals that triple hash', () => {
      const quads = [q('did:dkg:agent:QmBot', 'http://schema.org/name', '"Bot"')];
      const pubRoot = computePublicRoot(quads)!;
      const kcRoot = computeKCRoot([pubRoot]);
      expect(kcRoot).toEqual(pubRoot);
      expect(kcRoot).toEqual(computeTripleHash(quads[0]));
    });

    it('two KAs (flat): KC root is Merkle tree of two triple hashes', () => {
      const q1 = q('did:dkg:agent:A', 'http://ex.org/p', '"a"');
      const q2 = q('did:dkg:agent:B', 'http://ex.org/p', '"b"');
      const hashes = [computeTripleHash(q1), computeTripleHash(q2)];
      const expectedKCRoot = new MerkleTree(hashes).root;
      const pubRoot1 = computePublicRoot([q1])!;
      const pubRoot2 = computePublicRoot([q2])!;
      const actualKCRoot = computeKCRoot([pubRoot1, pubRoot2]);
      expect(actualKCRoot).toEqual(expectedKCRoot);
    });
  });

  describe('full pipeline: entityProofs (per-entity roots then KC tree)', () => {
    it('two entities with two triples each: KC root differs from flat', () => {
      const entityA = 'did:dkg:agent:EntityA';
      const entityB = 'did:dkg:agent:EntityB';
      const quads = [
        q(entityA, 'http://ex.org/name', '"A"'),
        q(entityA, 'http://ex.org/version', '"1"'),
        q(entityB, 'http://ex.org/name', '"B"'),
        q(entityB, 'http://ex.org/version', '"2"'),
      ];

      const flatHashes = quads.map(computeTripleHash);
      const flatRoot = new MerkleTree(flatHashes).root;

      const kaRootA = computePublicRoot(quads.filter((q) => q.subject === entityA))!;
      const kaRootB = computePublicRoot(quads.filter((q) => q.subject === entityB))!;
      const entityProofsRoot = computeKCRoot([kaRootA, kaRootB]);

      expect(flatRoot).not.toEqual(entityProofsRoot);
      expect(entityProofsRoot).toHaveLength(32);
    });
  });

  describe('synthetic private root triple (anchor)', () => {
    it('synthetic triple contributes to public root like any other triple', () => {
      const normal = q('did:dkg:agent:QmBot', 'http://schema.org/name', '"Bot"');
      const synthetic = {
        subject: 'urn:dkg:kc',
        predicate: 'http://dkg.io/ontology/privateContentRoot',
        object: '"0xabcdef1234567890"',
        graph: GRAPH,
      };
      const rootWithSynthetic = computePublicRoot([normal, synthetic]);
      const rootWithout = computePublicRoot([normal]);
      expect(rootWithSynthetic).not.toEqual(rootWithout);
      expect(rootWithSynthetic).toHaveLength(32);
    });
  });
});
