import { describe, it, expect } from 'vitest';
import {
  buildV10ProofMaterial,
  structuredKARootV10,
  tripleContentV10,
  hashTripleV10,
  keccak256,
  bytesToHex0x,
  hex0xToBytes,
  verifyCitationProof,
  citationProofToMaterial,
  isVerifiableCitationShape,
  type CitationTriple,
  type VerifiableCitation,
} from '../src/index.js';

// Pure (no chain / no ethers) verification of the dRAG verifiable-citation
// Merkle path. A citation that verifies here verifies on-chain by construction,
// because it uses the SAME structured V10 tree (`structuredKARootV10` /
// `buildV10ProofMaterial`) as the publisher and the on-chain `submitProof`.

const TRIPLES: CitationTriple[] = [
  { subject: 'urn:drag:fact-supplier', predicate: 'http://schema.org/name', object: '"Northwind Components"' },
  { subject: 'urn:drag:fact-supplier', predicate: 'http://schema.org/auditStatus', object: '"flagged"' },
  { subject: 'urn:drag:fact-supplier', predicate: 'http://schema.org/incidents', object: '"3"' },
  { subject: 'urn:drag:fact-supplier', predicate: 'http://schema.org/region', object: '"EU"' },
];

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Assemble a VerifiableCitation for `triples[citedIndex]` exactly the way the
 * agent producer would, but over a synthetic in-test KA whose "on-chain" root is
 * the structured V10 root of the triple set (private roots empty).
 */
function synthCitation(triples: CitationTriple[], citedIndex: number): VerifiableCitation {
  const contents = triples.map((t) => tripleContentV10(t.subject, t.predicate, t.object));
  const leaves = contents.map((c) => keccak256(c));
  const { root, leafCount, publicTree } = structuredKARootV10(leaves, []);

  const cited = triples[citedIndex];
  const citedLeaf = hashTripleV10(cited.subject, cited.predicate, cited.object);
  let chunkId = -1;
  for (let i = 0; i < publicTree.leafCount; i++) {
    if (bytesEq(publicTree.leafAt(i), citedLeaf)) { chunkId = i; break; }
  }
  expect(chunkId, 'cited triple must be a leaf').toBeGreaterThanOrEqual(0);

  const material = buildV10ProofMaterial(contents, [], chunkId, {
    merkleRoot: root,
    merkleLeafCount: leafCount,
  });

  return {
    ual: 'did:dkg:context-graph:drag-test/0x00/1',
    kaId: '1',
    contextGraphId: '3',
    servingNode: 'local',
    triple: cited,
    proof: {
      content: bytesToHex0x(material.content),
      leaf: bytesToHex0x(material.leaf),
      siblings: material.proof.map(bytesToHex0x),
      chunkId,
      leafCount: material.leafCount,
    },
    onChain: {
      merkleRoot: bytesToHex0x(root),
      author: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      chainId: '31337',
    },
    checks: { merkle: true, onChain: true, authorSig: null, verified: true },
  };
}

describe('verifiable citation — pure Merkle proof', () => {
  it('verifies a citation for every triple in the KA', () => {
    for (let i = 0; i < TRIPLES.length; i++) {
      const c = synthCitation(TRIPLES, i);
      expect(verifyCitationProof(c), `triple ${i} should verify`).toBe(true);
    }
  });

  it('content-binds the proof to the cited triple (swapping the object fails)', () => {
    const c = synthCitation(TRIPLES, 0);
    const tampered: VerifiableCitation = {
      ...c,
      triple: { ...c.triple, object: '"Globex Materials"' },
    };
    // The proof.content still encodes the original triple, so the cited-triple
    // content check fails before the merkle walk.
    expect(verifyCitationProof(tampered)).toBe(false);
  });

  it('rejects a forged content payload that does not hash to the proven leaf', () => {
    const c = synthCitation(TRIPLES, 0);
    const forged: VerifiableCitation = {
      ...c,
      triple: { ...c.triple, object: '"Tampered"' },
      proof: { ...c.proof, content: bytesToHex0x(tripleContentV10(c.triple.subject, c.triple.predicate, '"Tampered"')) },
    };
    // Content now matches the (tampered) triple, but its keccak leaf is not in
    // the tree under the on-chain root → merkle walk fails.
    expect(verifyCitationProof(forged)).toBe(false);
  });

  it('rejects a citation whose on-chain root has been altered', () => {
    const c = synthCitation(TRIPLES, 1);
    const wrongRoot = new Uint8Array(32).fill(0xab);
    const tampered: VerifiableCitation = {
      ...c,
      onChain: { ...c.onChain, merkleRoot: bytesToHex0x(wrongRoot) },
    };
    expect(verifyCitationProof(tampered)).toBe(false);
  });

  it('rejects a citation with a corrupted sibling in the proof path', () => {
    const c = synthCitation(TRIPLES, 2);
    const siblings = [...c.proof.siblings];
    expect(siblings.length).toBeGreaterThan(0);
    siblings[0] = bytesToHex0x(new Uint8Array(32).fill(0x01));
    const tampered: VerifiableCitation = { ...c, proof: { ...c.proof, siblings } };
    expect(verifyCitationProof(tampered)).toBe(false);
  });

  it('round-trips hex codecs', () => {
    const b = keccak256(new TextEncoder().encode('drag'));
    expect(bytesEq(hex0xToBytes(bytesToHex0x(b)), b)).toBe(true);
  });

  it('citationProofToMaterial reconstructs the on-chain commitment', () => {
    const c = synthCitation(TRIPLES, 0);
    const { commitment } = citationProofToMaterial(c.proof, c.onChain.merkleRoot);
    expect(commitment.merkleLeafCount).toBe(c.proof.leafCount);
    expect(bytesToHex0x(commitment.merkleRoot)).toBe(c.onChain.merkleRoot);
  });

  it('a single-triple KA (one leaf) still produces a verifiable citation', () => {
    const single = [TRIPLES[0]];
    const c = synthCitation(single, 0);
    expect(verifyCitationProof(c)).toBe(true);
  });
});

describe('isVerifiableCitationShape — canonical bounded wire-shape guard', () => {
  const valid = () => synthCitation(TRIPLES, 1);

  it('accepts a real producer-shaped citation (with and without a seal)', () => {
    expect(isVerifiableCitationShape(valid())).toBe(true);
    const sealed: VerifiableCitation = {
      ...valid(),
      seal: {
        merkleRoot: `0x${'ab'.repeat(32)}`,
        authorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        r: `0x${'cd'.repeat(32)}`,
        vs: `0x${'ef'.repeat(32)}`,
        schemeVersion: 1,
        chainId: '31337',
        kav10Address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        reservedKaId: '1',
      },
    };
    expect(isVerifiableCitationShape(sealed)).toBe(true);
  });

  it('rejects non-objects and missing sections', () => {
    expect(isVerifiableCitationShape(null)).toBe(false);
    expect(isVerifiableCitationShape('citation')).toBe(false);
    for (const section of ['triple', 'proof', 'onChain', 'checks'] as const) {
      const c = valid() as unknown as Record<string, unknown>;
      delete c[section];
      expect(isVerifiableCitationShape(c), `missing ${section}`).toBe(false);
    }
  });

  it('enforces uint256 range and decimal format on ids', () => {
    expect(isVerifiableCitationShape({ ...valid(), kaId: '-1' })).toBe(false);
    expect(isVerifiableCitationShape({ ...valid(), kaId: '0x10' })).toBe(false);
    const overUint256 = (2n ** 256n).toString();
    expect(isVerifiableCitationShape({ ...valid(), kaId: overUint256 })).toBe(false);
  });

  it('enforces the DoS bounds a remote peer could abuse', () => {
    const c = valid();
    expect(
      isVerifiableCitationShape({ ...c, proof: { ...c.proof, siblings: Array(65).fill(`0x${'11'.repeat(32)}`) } }),
      'sibling-count cap',
    ).toBe(false);
    expect(
      isVerifiableCitationShape({ ...c, triple: { ...c.triple, object: `"${'x'.repeat(70_000)}"` } }),
      'triple field length cap',
    ).toBe(false);
    expect(
      isVerifiableCitationShape({ ...c, proof: { ...c.proof, leafCount: c.proof.chunkId } }),
      'leafCount must exceed chunkId',
    ).toBe(false);
  });

  it('rejects a malformed seal instead of ignoring it', () => {
    const c: VerifiableCitation = {
      ...valid(),
      seal: {
        merkleRoot: 'not-hex',
        authorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        r: `0x${'cd'.repeat(32)}`,
        vs: `0x${'ef'.repeat(32)}`,
        schemeVersion: 1,
        chainId: '31337',
        kav10Address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        reservedKaId: '1',
      },
    };
    expect(isVerifiableCitationShape(c)).toBe(false);
  });
});
