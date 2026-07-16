import { describe, it, expect } from 'vitest';
import {
  generateEd25519Keypair,
  ed25519Sign,
  ed25519Verify,
  sha256,
  MerkleTree,
  hashTriple,
  canonicalize,
  hexToBytes,
} from '../src/index.js';

describe('Ed25519', () => {
  it('generates a keypair and signs/verifies', async () => {
    const kp = await generateEd25519Keypair();
    expect(kp.secretKey).toHaveLength(32);
    expect(kp.publicKey).toHaveLength(32);

    const msg = new TextEncoder().encode('hello dkg');
    const sig = await ed25519Sign(msg, kp.secretKey);
    expect(sig).toHaveLength(64);

    const valid = await ed25519Verify(sig, msg, kp.publicKey);
    expect(valid).toBe(true);

    const tampered = new Uint8Array(msg);
    tampered[0] ^= 0xff;
    const invalid = await ed25519Verify(sig, tampered, kp.publicKey);
    expect(invalid).toBe(false);
  });
});

describe('SHA-256', () => {
  it('produces a 32-byte hash', () => {
    const data = new TextEncoder().encode('test');
    const hash = sha256(data);
    expect(hash).toHaveLength(32);
  });

  it('is deterministic', () => {
    const data = new TextEncoder().encode('deterministic');
    expect(sha256(data)).toEqual(sha256(data));
  });
});

describe('MerkleTree', () => {
  it('handles empty leaves', () => {
    const tree = new MerkleTree([]);
    expect(tree.root).toHaveLength(32);
    expect(tree.leafCount).toBe(0);
  });

  it('single leaf root equals the leaf', () => {
    const leaf = sha256(new TextEncoder().encode('single'));
    const tree = new MerkleTree([leaf]);
    expect(tree.root).toEqual(leaf);
  });

  it('two leaves produce a different root than either leaf', () => {
    const a = sha256(new TextEncoder().encode('a'));
    const b = sha256(new TextEncoder().encode('b'));
    const tree = new MerkleTree([a, b]);
    expect(tree.root).not.toEqual(a);
    expect(tree.root).not.toEqual(b);
    expect(tree.root).toHaveLength(32);
  });

  it('proof() rejects index at padding boundary for odd-leaf trees', () => {
    const leaves = ['a', 'b', 'c'].map(s =>
      sha256(new TextEncoder().encode(s)),
    );
    const tree = new MerkleTree(leaves);
    expect(tree.leafCount).toBe(3);
    // Index 0-2 are valid, index 3 is the synthetic duplicate padding leaf
    expect(() => tree.proof(2)).not.toThrow();
    expect(() => tree.proof(3)).toThrow(RangeError);
  });

  it('leafCount returns original count, not padded (odd leaves)', () => {
    const leaves = ['a', 'b', 'c', 'd', 'e'].map(s =>
      sha256(new TextEncoder().encode(s)),
    );
    const tree = new MerkleTree(leaves);
    expect(tree.leafCount).toBe(5);
  });

  it('leafCount returns original count for even leaves', () => {
    const leaves = ['a', 'b', 'c', 'd'].map(s =>
      sha256(new TextEncoder().encode(s)),
    );
    const tree = new MerkleTree(leaves);
    expect(tree.leafCount).toBe(4);
  });

  it('is order-independent (sorted internally)', () => {
    const a = sha256(new TextEncoder().encode('a'));
    const b = sha256(new TextEncoder().encode('b'));
    const tree1 = new MerkleTree([a, b]);
    const tree2 = new MerkleTree([b, a]);
    expect(tree1.root).toEqual(tree2.root);
  });

  it('generates and verifies proofs', () => {
    const leaves = ['x', 'y', 'z', 'w'].map((s) =>
      sha256(new TextEncoder().encode(s)),
    );
    const tree = new MerkleTree(leaves);

    const sorted = [...leaves].sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return 0;
    });

    for (let i = 0; i < sorted.length; i++) {
      const proof = tree.proof(i);
      expect(MerkleTree.verify(tree.root, sorted[i], proof, i)).toBe(true);
    }
  });

  it('computeKARoot with both public and private roots', () => {
    const pub = sha256(new TextEncoder().encode('public'));
    const priv = sha256(new TextEncoder().encode('private'));
    const combined = MerkleTree.computeKARoot(pub, priv);
    expect(combined).toHaveLength(32);
    expect(combined).not.toEqual(pub);
    expect(combined).not.toEqual(priv);
  });

  it('computeKARoot with only public root', () => {
    const pub = sha256(new TextEncoder().encode('public'));
    expect(MerkleTree.computeKARoot(pub, undefined)).toEqual(pub);
  });

  it('computeKCRoot computes root from KA roots as a MerkleTree', () => {
    const r1 = sha256(new TextEncoder().encode('ka1'));
    const r2 = sha256(new TextEncoder().encode('ka2'));
    const root = MerkleTree.computeKCRoot([r1, r2]);
    expect(root).toHaveLength(32);

    const tree = new MerkleTree([r1, r2]);
    expect(root).toEqual(tree.root);
  });

  it('computeKCRoot with single KA root equals that root', () => {
    const r = sha256(new TextEncoder().encode('only-ka'));
    const root = MerkleTree.computeKCRoot([r]);
    expect(root).toEqual(r);
  });
});

describe('hashTriple', () => {
  it('produces a 32-byte hash', () => {
    const h = hashTriple(
      'did:dkg:agent:QmBot',
      'http://schema.org/name',
      '"Bot"',
    );
    expect(h).toHaveLength(32);
  });

  it('is deterministic', () => {
    const a = hashTriple('s', 'p', 'o');
    const b = hashTriple('s', 'p', 'o');
    expect(a).toEqual(b);
  });

  it('different triples produce different hashes', () => {
    const a = hashTriple('s1', 'p', 'o');
    const b = hashTriple('s2', 'p', 'o');
    expect(a).not.toEqual(b);
  });
});

describe('canonicalize', () => {
  it('returns exact canonical output for a single quad', async () => {
    const input = [
      '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
      '',
    ].join('\n');
    const result = await canonicalize(input);
    expect(result.trim()).toBe(
      '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
    );
  });

  it('sorts multiple quads into deterministic order', async () => {
    const input = [
      '<http://example.org/b> <http://example.org/p> <http://example.org/o> .',
      '<http://example.org/a> <http://example.org/p> <http://example.org/o> .',
      '',
    ].join('\n');
    const result = await canonicalize(input);
    const lines = result.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('example.org/a');
    expect(lines[1]).toContain('example.org/b');
  });

  it('produces identical output regardless of input order', async () => {
    const inputA = '<http://ex.org/z> <http://ex.org/p> "1" .\n<http://ex.org/a> <http://ex.org/p> "2" .\n';
    const inputB = '<http://ex.org/a> <http://ex.org/p> "2" .\n<http://ex.org/z> <http://ex.org/p> "1" .\n';
    const resultA = await canonicalize(inputA);
    const resultB = await canonicalize(inputB);
    expect(resultA).toBe(resultB);
  });
});

describe('hexToBytes', () => {
  it('converts valid hex to bytes', () => {
    expect(Array.from(hexToBytes('0xdeadbeef'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(Array.from(hexToBytes('abcd'))).toEqual([0xab, 0xcd]);
  });

  it('rejects odd-length hex strings', () => {
    expect(() => hexToBytes('0xabc')).toThrow('Invalid hex string');
  });

  it('rejects non-hex characters', () => {
    expect(() => hexToBytes('0xgggg')).toThrow('Invalid hex string');
    expect(() => hexToBytes('xyz!')).toThrow('Invalid hex string');
  });

  it('handles empty string with 0x prefix', () => {
    expect(Array.from(hexToBytes('0x'))).toEqual([]);
  });
});
