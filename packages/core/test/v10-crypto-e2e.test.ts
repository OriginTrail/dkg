import { describe, it, expect } from 'vitest';
import {
  keccak256,
  hashTripleV10,
  V10MerkleTree,
  computeACKDigest,
  eip191Hash,
  resolveRootEntities,
} from '../src/index.js';

describe('V10 crypto e2e: full publish pipeline', () => {
  const TRIPLES = [
    { subject: 'http://example.org/alice', predicate: 'http://schema.org/name', object: '"Alice"' },
    { subject: 'http://example.org/alice', predicate: 'http://schema.org/knows', object: 'http://example.org/bob' },
    { subject: 'http://example.org/bob', predicate: 'http://schema.org/name', object: '"Bob"' },
    { subject: 'http://example.org/bob', predicate: 'http://schema.org/age', object: '"25"^^<http://www.w3.org/2001/XMLSchema#integer>' },
  ];

  it('raw triples → hash → merkle tree → ACK digest → EIP-191 hash', () => {
    // Step 1: hash each triple
    const hashes = TRIPLES.map(t => hashTripleV10(t.subject, t.predicate, t.object));
    expect(hashes).toHaveLength(4);
    hashes.forEach(h => expect(h).toHaveLength(32));

    // Step 2: build merkle tree
    const tree = new V10MerkleTree(hashes);
    const merkleRoot = tree.root;
    expect(merkleRoot).toHaveLength(32);
    expect(merkleRoot).not.toEqual(new Uint8Array(32));

    // Step 3: compute ACK digest
    const contextGraphId = 42n;
    const digest = computeACKDigest(contextGraphId, merkleRoot);
    expect(digest).toHaveLength(32);

    // Step 4: apply EIP-191 hash (what ethers.signMessage would sign)
    const eip191Digest = eip191Hash(digest);
    expect(eip191Digest).toHaveLength(32);
    expect(eip191Digest).not.toEqual(digest);
  });

  it('merkle proof round-trip: prove one triple, verify against root', () => {
    const hashes = TRIPLES.map(t => hashTripleV10(t.subject, t.predicate, t.object));
    const tree = new V10MerkleTree(hashes);

    // Prove the first leaf (after sorting)
    const proof = tree.proof(0);
    expect(proof.length).toBeGreaterThan(0);

    // Get the sorted leaves to find what's at index 0
    const sorted = [...hashes].sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return 0;
    });

    // Verify
    expect(V10MerkleTree.verify(tree.root, sorted[0], proof, 0)).toBe(true);

    // Tamper: flip one byte in the leaf
    const tampered = new Uint8Array(sorted[0]);
    tampered[0] ^= 0xff;
    expect(V10MerkleTree.verify(tree.root, tampered, proof, 0)).toBe(false);
  });

  it('multi-entity: resolve → per-entity merkle roots → combined KC root', () => {
    // Step 1: resolve root entities
    const entities = resolveRootEntities(TRIPLES);
    expect(entities.size).toBe(2);
    expect(entities.has('http://example.org/alice')).toBe(true);
    expect(entities.has('http://example.org/bob')).toBe(true);

    // Step 2: per-entity merkle roots (KA roots)
    const kaRoots: Uint8Array[] = [];
    for (const [entity, quads] of entities) {
      const hashes = quads.map(q => hashTripleV10(q.subject, q.predicate, q.object));
      const tree = new V10MerkleTree(hashes);
      kaRoots.push(tree.root);
      expect(tree.root).toHaveLength(32);
    }
    expect(kaRoots).toHaveLength(2);

    // Step 3: combined KC root
    const kcRoot = V10MerkleTree.computeKCRoot(kaRoots);
    expect(kcRoot).toHaveLength(32);
    expect(kcRoot).not.toEqual(new Uint8Array(32));

    // KC root should differ from either KA root
    expect(kcRoot).not.toEqual(kaRoots[0]);
    expect(kcRoot).not.toEqual(kaRoots[1]);
  });

  it('cross-verify: prove triple in multi-entity tree', () => {
    // Flat tree of all triples
    const hashes = TRIPLES.map(t => hashTripleV10(t.subject, t.predicate, t.object));
    const tree = new V10MerkleTree(hashes);

    // Verify each leaf can be proved
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

  it('determinism: same triples always produce same root and digest', () => {
    const run = () => {
      const hashes = TRIPLES.map(t => hashTripleV10(t.subject, t.predicate, t.object));
      const tree = new V10MerkleTree(hashes);
      return {
        root: tree.root,
        digest: computeACKDigest(1n, tree.root),
      };
    };

    const r1 = run();
    const r2 = run();
    expect(r1.root).toEqual(r2.root);
    expect(r1.digest).toEqual(r2.digest);
  });

  it('duplicate triples are deduplicated in the tree', () => {
    const hashes = TRIPLES.map(t => hashTripleV10(t.subject, t.predicate, t.object));
    const treeNoDup = new V10MerkleTree(hashes);
    const treeWithDup = new V10MerkleTree([...hashes, ...hashes]);
    expect(treeWithDup.root).toEqual(treeNoDup.root);
    expect(treeWithDup.leafCount).toEqual(treeNoDup.leafCount);
  });
});
