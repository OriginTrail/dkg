import { describe, it, expect } from 'vitest';
import {
  keccak256,
  keccak256Hex,
  hashTripleV10,
  V10MerkleTree,
  computeACKDigest,
  eip191Hash,
  uint256ToBytes,
  resolveRootEntities,
  hexToBytes,
} from '../src/index.js';

// ── keccak256 ─────────────────────────────────────────────────────────

describe('keccak256', () => {
  it('produces a 32-byte hash', () => {
    const data = new TextEncoder().encode('test');
    expect(keccak256(data)).toHaveLength(32);
  });

  it('is deterministic', () => {
    const data = new TextEncoder().encode('deterministic');
    expect(keccak256(data)).toEqual(keccak256(data));
  });

  it('different inputs produce different hashes', () => {
    const a = keccak256(new TextEncoder().encode('a'));
    const b = keccak256(new TextEncoder().encode('b'));
    expect(a).not.toEqual(b);
  });

  it('golden vector: keccak256 of empty string', () => {
    // Well-known: keccak256("") = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
    const hash = keccak256Hex(new Uint8Array(0));
    expect(hash).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });

  it('golden vector: keccak256 of "hello"', () => {
    // keccak256("hello") = 0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8
    const hash = keccak256Hex(new TextEncoder().encode('hello'));
    expect(hash).toBe('0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8');
  });

  it('keccak256Hex returns 0x-prefixed lowercase hex', () => {
    const hex = keccak256Hex(new TextEncoder().encode('test'));
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ── hashTripleV10 ─────────────────────────────────────────────────────

describe('hashTripleV10', () => {
  it('produces a 32-byte hash', () => {
    const h = hashTripleV10(
      'did:dkg:agent:0xAbc',
      'http://schema.org/name',
      '"Bot"',
    );
    expect(h).toHaveLength(32);
  });

  it('is deterministic', () => {
    const a = hashTripleV10('s', 'p', 'o');
    const b = hashTripleV10('s', 'p', 'o');
    expect(a).toEqual(b);
  });

  it('different triples produce different hashes', () => {
    const a = hashTripleV10('s1', 'p', 'o');
    const b = hashTripleV10('s2', 'p', 'o');
    expect(a).not.toEqual(b);
  });

  it('wraps URIs in angle brackets', () => {
    const withBrackets = hashTripleV10('<http://example.org/s>', '<http://example.org/p>', '<http://example.org/o>');
    const withoutBrackets = hashTripleV10('http://example.org/s', 'http://example.org/p', 'http://example.org/o');
    expect(withBrackets).toEqual(withoutBrackets);
  });

  it('preserves literals as-is', () => {
    const a = hashTripleV10('http://example.org/s', 'http://example.org/p', '"hello"');
    const b = hashTripleV10('http://example.org/s', 'http://example.org/p', '"world"');
    expect(a).not.toEqual(b);
  });

  it('preserves blank nodes as-is', () => {
    const h = hashTripleV10('_:b0', 'http://example.org/p', '"value"');
    expect(h).toHaveLength(32);
  });
});

// ── V10MerkleTree ─────────────────────────────────────────────────────

describe('V10MerkleTree', () => {
  it('handles empty leaves', () => {
    const tree = new V10MerkleTree([]);
    expect(tree.root).toHaveLength(32);
    expect(tree.root).toEqual(new Uint8Array(32));
    expect(tree.leafCount).toBe(0);
  });

  it('single leaf root equals the leaf', () => {
    const leaf = keccak256(new TextEncoder().encode('single'));
    const tree = new V10MerkleTree([leaf]);
    expect(tree.root).toEqual(leaf);
    expect(tree.leafCount).toBe(1);
  });

  it('two leaves produce a root different from either leaf', () => {
    const a = keccak256(new TextEncoder().encode('a'));
    const b = keccak256(new TextEncoder().encode('b'));
    const tree = new V10MerkleTree([a, b]);
    expect(tree.root).not.toEqual(a);
    expect(tree.root).not.toEqual(b);
    expect(tree.root).toHaveLength(32);
  });

  it('is order-independent (sorted internally)', () => {
    const a = keccak256(new TextEncoder().encode('a'));
    const b = keccak256(new TextEncoder().encode('b'));
    const tree1 = new V10MerkleTree([a, b]);
    const tree2 = new V10MerkleTree([b, a]);
    expect(tree1.root).toEqual(tree2.root);
  });

  it('deduplicates identical leaves', () => {
    const a = keccak256(new TextEncoder().encode('dup'));
    const tree = new V10MerkleTree([a, a, a]);
    expect(tree.leafCount).toBe(1);
    expect(tree.root).toEqual(a);
  });

  it('deduplication: two unique out of four', () => {
    const a = keccak256(new TextEncoder().encode('alpha'));
    const b = keccak256(new TextEncoder().encode('beta'));
    const treeFull = new V10MerkleTree([a, b]);
    const treeDup = new V10MerkleTree([a, a, b, b]);
    expect(treeDup.root).toEqual(treeFull.root);
  });

  it('handles odd leaf count (padding)', () => {
    const leaves = ['x', 'y', 'z'].map(s =>
      keccak256(new TextEncoder().encode(s)),
    );
    const tree = new V10MerkleTree(leaves);
    expect(tree.root).toHaveLength(32);
    expect(tree.leafCount).toBe(3);
  });

  it('generates and verifies proofs for all leaves', () => {
    const leaves = ['alpha', 'beta', 'gamma', 'delta'].map(s =>
      keccak256(new TextEncoder().encode(s)),
    );
    const tree = new V10MerkleTree(leaves);

    for (let i = 0; i < tree.leafCount; i++) {
      const proof = tree.proof(i);
      const sorted = [...leaves].sort((a, b) => {
        for (let j = 0; j < a.length; j++) {
          if (a[j] !== b[j]) return a[j] - b[j];
        }
        return 0;
      });
      expect(V10MerkleTree.verify(tree.root, sorted[i], proof, i)).toBe(true);
    }
  });

  it('rejects tampered proofs', () => {
    const leaves = ['a', 'b', 'c', 'd'].map(s =>
      keccak256(new TextEncoder().encode(s)),
    );
    const tree = new V10MerkleTree(leaves);
    const proof = tree.proof(0);

    const fakeSibling = new Uint8Array(32).fill(0xff);
    const tampered = [fakeSibling, ...proof.slice(1)];
    const sorted = [...leaves].sort((a, b) => {
      for (let j = 0; j < a.length; j++) {
        if (a[j] !== b[j]) return a[j] - b[j];
      }
      return 0;
    });
    expect(V10MerkleTree.verify(tree.root, sorted[0], tampered, 0)).toBe(false);
  });

  it('rejects proof for wrong leaf', () => {
    const leaves = ['a', 'b'].map(s =>
      keccak256(new TextEncoder().encode(s)),
    );
    const tree = new V10MerkleTree(leaves);
    const proof = tree.proof(0);
    const fakeLeaf = keccak256(new TextEncoder().encode('fake'));
    expect(V10MerkleTree.verify(tree.root, fakeLeaf, proof, 0)).toBe(false);
  });

  it('throws on out-of-range leaf index', () => {
    const tree = new V10MerkleTree([keccak256(new Uint8Array([1]))]);
    expect(() => tree.proof(-1)).toThrow(RangeError);
    expect(() => tree.proof(1)).toThrow(RangeError);
  });

  it('golden vector: specific triples produce consistent root', () => {
    const triples = [
      ['http://example.org/entity1', 'http://schema.org/name', '"Alice"'],
      ['http://example.org/entity1', 'http://schema.org/age', '"30"^^<http://www.w3.org/2001/XMLSchema#integer>'],
      ['http://example.org/entity2', 'http://schema.org/name', '"Bob"'],
    ] as const;

    const hashes = triples.map(([s, p, o]) => hashTripleV10(s, p, o));
    const tree = new V10MerkleTree(hashes);
    const root1 = tree.root;

    // Same triples in different order should produce same root
    const reversed = [...hashes].reverse();
    const tree2 = new V10MerkleTree(reversed);
    expect(tree2.root).toEqual(root1);

    // Snapshot: root should be 32 bytes and non-zero
    expect(root1).toHaveLength(32);
    expect(root1).not.toEqual(new Uint8Array(32));
  });

  it('computeKARoot with both public and private roots', () => {
    const pub = keccak256(new TextEncoder().encode('public'));
    const priv = keccak256(new TextEncoder().encode('private'));
    const combined = V10MerkleTree.computeKARoot(pub, priv);
    expect(combined).toHaveLength(32);
    expect(combined).not.toEqual(pub);
    expect(combined).not.toEqual(priv);
  });

  it('computeKARoot with only public root returns it directly', () => {
    const pub = keccak256(new TextEncoder().encode('public'));
    expect(V10MerkleTree.computeKARoot(pub, undefined)).toEqual(pub);
  });

  it('computeKARoot with no roots returns zero bytes', () => {
    expect(V10MerkleTree.computeKARoot()).toEqual(new Uint8Array(32));
  });

  it('computeKCRoot produces a root from KA roots', () => {
    const r1 = keccak256(new TextEncoder().encode('ka1'));
    const r2 = keccak256(new TextEncoder().encode('ka2'));
    const root = V10MerkleTree.computeKCRoot([r1, r2]);
    expect(root).toHaveLength(32);
  });
});

// ── ACK Signature Scheme ──────────────────────────────────────────────

describe('computeACKDigest', () => {
  it('produces a 32-byte digest', () => {
    const merkleRoot = keccak256(new TextEncoder().encode('root'));
    const digest = computeACKDigest(42n, merkleRoot);
    expect(digest).toHaveLength(32);
  });

  it('is deterministic', () => {
    const merkleRoot = keccak256(new TextEncoder().encode('root'));
    const a = computeACKDigest(1n, merkleRoot);
    const b = computeACKDigest(1n, merkleRoot);
    expect(a).toEqual(b);
  });

  it('different contextGraphIds produce different digests', () => {
    const merkleRoot = keccak256(new TextEncoder().encode('root'));
    const a = computeACKDigest(1n, merkleRoot);
    const b = computeACKDigest(2n, merkleRoot);
    expect(a).not.toEqual(b);
  });

  it('different merkleRoots produce different digests', () => {
    const root1 = keccak256(new TextEncoder().encode('root1'));
    const root2 = keccak256(new TextEncoder().encode('root2'));
    const a = computeACKDigest(1n, root1);
    const b = computeACKDigest(1n, root2);
    expect(a).not.toEqual(b);
  });

  it('rejects invalid merkleRoot length', () => {
    expect(() => computeACKDigest(1n, new Uint8Array(16))).toThrow('merkleRoot must be 32 bytes');
  });

  it('golden vector: contextGraphId=0, zero merkleRoot', () => {
    const zeroRoot = new Uint8Array(32);
    const digest = computeACKDigest(0n, zeroRoot);
    expect(digest).toHaveLength(32);
    // keccak256 of 64 zero bytes
    const expected = keccak256(new Uint8Array(64));
    expect(digest).toEqual(expected);
  });
});

describe('uint256ToBytes', () => {
  it('encodes 0 as 32 zero bytes', () => {
    expect(uint256ToBytes(0n)).toEqual(new Uint8Array(32));
  });

  it('encodes 1 correctly', () => {
    const bytes = uint256ToBytes(1n);
    expect(bytes[31]).toBe(1);
    expect(bytes.slice(0, 31).every(b => b === 0)).toBe(true);
  });

  it('encodes 256 correctly', () => {
    const bytes = uint256ToBytes(256n);
    expect(bytes[30]).toBe(1);
    expect(bytes[31]).toBe(0);
  });

  it('encodes max uint256', () => {
    const max = (1n << 256n) - 1n;
    const bytes = uint256ToBytes(max);
    expect(bytes.every(b => b === 0xff)).toBe(true);
  });
});

describe('eip191Hash', () => {
  it('produces a 32-byte hash', () => {
    const digest = keccak256(new TextEncoder().encode('test'));
    expect(eip191Hash(digest)).toHaveLength(32);
  });

  it('is different from raw keccak256 of the digest', () => {
    const digest = keccak256(new TextEncoder().encode('test'));
    expect(eip191Hash(digest)).not.toEqual(keccak256(digest));
  });
});

// ── Root Entity Resolution ────────────────────────────────────────────

describe('resolveRootEntities', () => {
  it('returns empty map for empty input', () => {
    expect(resolveRootEntities([]).size).toBe(0);
  });

  it('groups triples by subject URI', () => {
    const quads = [
      { subject: 'http://example.org/e1', predicate: 'http://schema.org/name', object: '"Alice"' },
      { subject: 'http://example.org/e1', predicate: 'http://schema.org/age', object: '"30"' },
      { subject: 'http://example.org/e2', predicate: 'http://schema.org/name', object: '"Bob"' },
    ];
    const entities = resolveRootEntities(quads);
    expect(entities.size).toBe(2);
    expect(entities.get('http://example.org/e1')).toHaveLength(2);
    expect(entities.get('http://example.org/e2')).toHaveLength(1);
  });

  it('excludes blank nodes as root entities', () => {
    const quads = [
      { subject: '_:b0', predicate: 'http://schema.org/name', object: '"Internal"' },
      { subject: 'http://example.org/e1', predicate: 'http://schema.org/ref', object: '_:b0' },
    ];
    const entities = resolveRootEntities(quads);
    expect(entities.size).toBe(1);
    expect(entities.has('_:b0')).toBe(false);
    expect(entities.has('http://example.org/e1')).toBe(true);
  });

  it('handles single entity with multiple triples', () => {
    const quads = Array.from({ length: 5 }, (_, i) => ({
      subject: 'http://example.org/entity',
      predicate: `http://schema.org/prop${i}`,
      object: `"val${i}"`,
    }));
    const entities = resolveRootEntities(quads);
    expect(entities.size).toBe(1);
    expect(entities.get('http://example.org/entity')).toHaveLength(5);
  });

  it('preserves graph field if present', () => {
    const quads = [
      { subject: 'http://example.org/e1', predicate: 'http://schema.org/name', object: '"Alice"', graph: 'http://example.org/g' },
    ];
    const entities = resolveRootEntities(quads);
    const triple = entities.get('http://example.org/e1')![0];
    expect(triple.graph).toBe('http://example.org/g');
  });
});
