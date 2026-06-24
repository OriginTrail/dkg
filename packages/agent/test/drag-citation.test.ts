import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  buildV10ProofMaterial,
  structuredKARootV10,
  tripleContentV10,
  hashTripleV10,
  keccak256,
  bytesToHex0x,
  buildAuthorAttestationTypedData,
  type CitationTriple,
  type CitationSeal,
  type VerifiableCitation,
} from '@origintrail-official/dkg-core';
import {
  recoverCitationAuthor,
  verifyVerifiableCitation,
  type CitationChainReads,
} from '../src/drag/citation.js';

// Author-seal recovery + end-to-end verify for dRAG verifiable citations.
// Uses a real ethers wallet to sign the EIP-712 AuthorAttestation, so the
// off-chain recovery path is exercised against a genuine signature (the same
// shape the publisher produces and the chain recovers at publish time).

const CHAIN_ID = 31337n;
const KAV10 = '0x0000000000000000000000000000000000000042';

const TRIPLES: CitationTriple[] = [
  { subject: 'urn:drag:fact', predicate: 'http://schema.org/name', object: '"Northwind Components"' },
  { subject: 'urn:drag:fact', predicate: 'http://schema.org/auditStatus', object: '"flagged"' },
  { subject: 'urn:drag:fact', predicate: 'http://schema.org/incidents', object: '"3"' },
];

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function signSeal(
  wallet: ethers.Wallet,
  merkleRoot: Uint8Array,
): Promise<CitationSeal> {
  const reservedKaId = (BigInt(wallet.address) << 96n) | 1n;
  const typed = buildAuthorAttestationTypedData({
    chainId: CHAIN_ID,
    kav10Address: KAV10,
    merkleRoot,
    authorAddress: wallet.address,
    reservedKaId,
    schemeVersion: 1,
  });
  const sig = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  const s = ethers.Signature.from(sig);
  return {
    merkleRoot: bytesToHex0x(merkleRoot),
    authorAddress: wallet.address,
    r: s.r,
    vs: s.yParityAndS,
    schemeVersion: 1,
    chainId: CHAIN_ID.toString(),
    kav10Address: KAV10,
    reservedKaId: reservedKaId.toString(),
  };
}

async function buildSignedCitation(
  wallet: ethers.Wallet,
  triples: CitationTriple[],
  citedIndex: number,
): Promise<{ citation: VerifiableCitation; root: Uint8Array }> {
  const contents = triples.map((t) => tripleContentV10(t.subject, t.predicate, t.object));
  const leaves = contents.map((c) => keccak256(c));
  const { root, leafCount, publicTree } = structuredKARootV10(leaves, []);

  const cited = triples[citedIndex];
  const citedLeaf = hashTripleV10(cited.subject, cited.predicate, cited.object);
  let chunkId = -1;
  for (let i = 0; i < publicTree.leafCount; i++) {
    if (bytesEq(publicTree.leafAt(i), citedLeaf)) { chunkId = i; break; }
  }
  const material = buildV10ProofMaterial(contents, [], chunkId, { merkleRoot: root, merkleLeafCount: leafCount });
  const seal = await signSeal(wallet, root);

  const citation: VerifiableCitation = {
    ual: 'did:dkg:context-graph:drag-test/0x00/1',
    kaId: '1',
    contextGraphId: '3',
    servingNode: '12D3KooWTest',
    triple: cited,
    proof: {
      content: bytesToHex0x(material.content),
      leaf: bytesToHex0x(material.leaf),
      siblings: material.proof.map(bytesToHex0x),
      chunkId,
      leafCount: material.leafCount,
    },
    onChain: { merkleRoot: bytesToHex0x(root), author: wallet.address, chainId: CHAIN_ID.toString() },
    seal,
    checks: { merkle: true, onChain: true, authorSig: true, verified: true },
  };
  return { citation, root };
}

function mockChain(root: Uint8Array, author: string): CitationChainReads {
  return {
    getLatestMerkleRoot: async () => root,
    getMerkleLeafCount: async () => 0,
    getLatestMerkleRootAuthor: async () => author,
  };
}

describe('dRAG citation — EIP-712 author seal', () => {
  it('recovers the signing author from a compact-sig seal', async () => {
    const wallet = ethers.Wallet.createRandom();
    const root = new Uint8Array(32).fill(0x11);
    const seal = await signSeal(wallet as unknown as ethers.Wallet, root);
    expect(recoverCitationAuthor(seal).toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('a tampered seal merkleRoot recovers a different (wrong) author', async () => {
    const wallet = ethers.Wallet.createRandom();
    const root = new Uint8Array(32).fill(0x11);
    const seal = await signSeal(wallet as unknown as ethers.Wallet, root);
    const tampered = { ...seal, merkleRoot: bytesToHex0x(new Uint8Array(32).fill(0x22)) };
    expect(recoverCitationAuthor(tampered).toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });
});

describe('dRAG citation — verifyVerifiableCitation', () => {
  it('verifies a well-formed signed citation (offline, carried values)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { citation } = await buildSignedCitation(wallet as unknown as ethers.Wallet, TRIPLES, 0);
    const checks = await verifyVerifiableCitation(citation);
    expect(checks).toMatchObject({ merkle: true, authorSig: true, verified: true });
  });

  it('verifies against a live chain (re-anchor root + author)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { citation, root } = await buildSignedCitation(wallet as unknown as ethers.Wallet, TRIPLES, 1);
    const checks = await verifyVerifiableCitation(citation, { chain: mockChain(root, wallet.address) });
    expect(checks).toEqual({ merkle: true, onChain: true, authorSig: true, verified: true });
  });

  it('fails when the live chain root disagrees (stale / forged anchor)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { citation } = await buildSignedCitation(wallet as unknown as ethers.Wallet, TRIPLES, 0);
    const wrongRoot = new Uint8Array(32).fill(0xab);
    const checks = await verifyVerifiableCitation(citation, { chain: mockChain(wrongRoot, wallet.address) });
    expect(checks.onChain).toBe(false);
    expect(checks.verified).toBe(false);
  });

  it('fails authorSig when the on-chain author differs from the seal signer', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { citation, root } = await buildSignedCitation(wallet as unknown as ethers.Wallet, TRIPLES, 0);
    const checks = await verifyVerifiableCitation(citation, {
      chain: mockChain(root, '0x000000000000000000000000000000000000dEaD'),
    });
    expect(checks.authorSig).toBe(false);
    expect(checks.verified).toBe(false);
  });

  it('content-binding: a swapped triple object fails merkle even with a valid seal', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { citation } = await buildSignedCitation(wallet as unknown as ethers.Wallet, TRIPLES, 0);
    const tampered: VerifiableCitation = { ...citation, triple: { ...citation.triple, object: '"Globex"' } };
    const checks = await verifyVerifiableCitation(tampered);
    expect(checks.merkle).toBe(false);
    expect(checks.verified).toBe(false);
  });

  it('falls back to onChain author (authorSig=null) when no seal is present', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { citation } = await buildSignedCitation(wallet as unknown as ethers.Wallet, TRIPLES, 0);
    const sealless: VerifiableCitation = { ...citation, seal: undefined };
    const checks = await verifyVerifiableCitation(sealless);
    expect(checks.authorSig).toBeNull();
    expect(checks.merkle).toBe(true);
    expect(checks.verified).toBe(true); // chain-verified author still trusted
  });

  it('a sealless citation with a zero author is not verified', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { citation } = await buildSignedCitation(wallet as unknown as ethers.Wallet, TRIPLES, 0);
    const bad: VerifiableCitation = {
      ...citation,
      seal: undefined,
      onChain: { ...citation.onChain, author: '0x0000000000000000000000000000000000000000' },
    };
    const checks = await verifyVerifiableCitation(bad);
    expect(checks.authorSig).toBe(false);
    expect(checks.verified).toBe(false);
  });
});
