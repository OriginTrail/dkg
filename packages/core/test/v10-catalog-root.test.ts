/**
 * OT-RFC-49 / WS-C — tests for `computeCatalogRoot`, the curated PUBLIC
 * `_catalog` commitment that replaces the stripped ciphertext commitment in
 * random sampling.
 *
 * The load-bearing invariant (RC18 master plan): the catalog leaf-hash + tree
 * shape MUST be byte-identical at the publisher (commitment), the prover
 * (proof), and the contract (`_verifyV10MerkleProof`). Both off-chain sites go
 * through `computeCatalogRoot`, so they agree by construction; this file pins:
 *
 *   - leafIndex (== chunkId == on-chain `challenge.chunkId`) round-trips:
 *     `tree.proof(i)` + `tree.leafAt(i)` verifies against `root` for every i.
 *   - `leafCount` is the POST sort+dedupe count (`V10MerkleTree.leafCount`),
 *     NEVER the raw triple count — the `seed % catalogLeafCount` draw modulus.
 *   - each leaf is exactly `hashTripleV10(s,p,o)` (graph excluded), so the
 *     catalog tree is the SAME tree the public path and the contract use.
 *   - empty catalog → 32 zero bytes root + leafCount 0 (the "skip in draw"
 *     sentinel the contract reads as `getCatalogLeafCount == 0`).
 */
import { describe, it, expect } from 'vitest';
import { computeCatalogRoot, V10MerkleTree, hashTripleV10 } from '../src/index.js';

const CG = 'did:dkg:context-graph:42';

function catalogTriples(n: number) {
  // A realistic curated `_catalog` floor: dual-typed dcat:Dataset +
  // dkg:PrivateContextGraph, dct:identifier, dct:accessRights, plus filler.
  const base = [
    { subject: CG, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://www.w3.org/ns/dcat#Dataset' },
    { subject: CG, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#PrivateContextGraph' },
    { subject: CG, predicate: 'http://purl.org/dc/terms/identifier', object: '"ual:did:dkg:context-graph:42"' },
    { subject: CG, predicate: 'http://purl.org/dc/terms/accessRights', object: 'http://publications.europa.eu/resource/authority/access-right/RESTRICTED' },
  ];
  const out = [...base];
  for (let i = base.length; i < n; i++) {
    out.push({ subject: CG, predicate: 'https://dkg.network/ontology#tag', object: `"tag-${i}"` });
  }
  return out.slice(0, n);
}

describe('computeCatalogRoot', () => {
  it('proof(i) + leafAt(i) round-trips against root for every leaf index', () => {
    for (const n of [1, 2, 3, 4, 5, 8, 13]) {
      const { root, leafCount, tree } = computeCatalogRoot(catalogTriples(n));
      for (let i = 0; i < leafCount; i++) {
        const proof = tree.proof(i);
        const leaf = tree.leafAt(i);
        expect(V10MerkleTree.verify(root, leaf, proof, i)).toBe(true);
      }
    }
  });

  it('leafCount is the post sort+dedupe count, never the raw triple count', () => {
    const triples = catalogTriples(5);
    // Duplicate two triples — the tree must dedupe them away.
    const withDupes = [...triples, triples[0], triples[2]];
    const { leafCount } = computeCatalogRoot(withDupes);
    expect(withDupes.length).toBe(7);
    expect(leafCount).toBe(5); // deduped back to the 5 distinct triples
  });

  it('each leaf is hashTripleV10(s,p,o) — same leaf hash as the public path', () => {
    const triples = catalogTriples(4);
    const { tree } = computeCatalogRoot(triples);
    // Build the expected sorted+deduped leaf set independently.
    const expected = new V10MerkleTree(triples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)));
    expect(tree.root).toEqual(expected.root);
    expect(tree.leafCount).toBe(expected.leafCount);
  });

  it('root is independent of input ordering (V10 sorts leaves)', () => {
    const triples = catalogTriples(6);
    const a = computeCatalogRoot(triples);
    const b = computeCatalogRoot([...triples].reverse());
    expect(a.root).toEqual(b.root);
    expect(a.leafCount).toBe(b.leafCount);
  });

  it('empty catalog → 32 zero bytes root and leafCount 0 (skip-in-draw sentinel)', () => {
    const { root, leafCount } = computeCatalogRoot([]);
    expect(leafCount).toBe(0);
    expect(root).toEqual(new Uint8Array(32));
  });
});
