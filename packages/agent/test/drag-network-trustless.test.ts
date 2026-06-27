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
import { DragMethods } from '../src/dkg-agent-drag.js';
import type { DKGAgent } from '../src/dkg-agent.js';

// dRAG P3 — the trustless-aggregation guarantee: a node that holds NONE of the
// CG must re-verify every remote citation against ITS OWN chain and never trust
// a serving peer's self-reported verdict. These tests feed dragAnswerNetwork
// crafted malicious peer responses (a lying tamper, an off-scope citation, a
// throwing peer) and assert the asker defends itself. Pure unit test — the peer
// + chain reads are mocked; no devnet.

const CHAIN_ID = 31337n;
const KAV10 = '0x0000000000000000000000000000000000000042';
const TRIPLES: CitationTriple[] = [
  { subject: 'urn:supplier:northwind', predicate: 'http://schema.org/name', object: '"Northwind Components"' },
  { subject: 'urn:supplier:northwind', predicate: 'http://schema.org/auditStatus', object: '"flagged"' },
];

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function signSeal(wallet: ethers.Wallet, merkleRoot: Uint8Array): Promise<CitationSeal> {
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
  citedIndex: number,
): Promise<{ citation: VerifiableCitation; root: Uint8Array }> {
  const contents = TRIPLES.map((t) => tripleContentV10(t.subject, t.predicate, t.object));
  const leaves = contents.map((c) => keccak256(c));
  const { root, leafCount, publicTree } = structuredKARootV10(leaves, []);
  const cited = TRIPLES[citedIndex];
  const citedLeaf = hashTripleV10(cited.subject, cited.predicate, cited.object);
  let chunkId = -1;
  for (let i = 0; i < publicTree.leafCount; i++) {
    if (bytesEq(publicTree.leafAt(i), citedLeaf)) {
      chunkId = i;
      break;
    }
  }
  const material = buildV10ProofMaterial(contents, [], chunkId, { merkleRoot: root, merkleLeafCount: leafCount });
  const seal = await signSeal(wallet, root);
  const citation: VerifiableCitation = {
    ual: 'did:dkg:context-graph:drag-test/0x00/1',
    kaId: '1',
    contextGraphId: '3',
    servingNode: '12D3KooWServer',
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

const peerResult = (citations: VerifiableCitation[]) => ({
  question: 'q',
  contextGraphId: 'cg',
  scope: 'local' as const,
  answer: '',
  llm: false,
  citations,
  facts: [],
  stats: { keywords: [], kasMatched: 0, factsCited: citations.length, verified: citations.length, retrieval: 'keyword' },
});

function makeAsker(opts: {
  remote: Map<string, unknown>; // peerId -> peerResult | Error
  root: Uint8Array;
  author: string;
  leafCount: number;
  kaScope: bigint; // on-chain CG id that getKAContextGraphId reports for the KA
  askedCgId: bigint;
}): DKGAgent {
  return {
    peerId: '12D3KooWAsker',
    getContextGraphOnChainId: async () => opts.askedCgId.toString(),
    discovery: { findNodesServingCG: async () => [...opts.remote.keys()] },
    dragAnswerRemote: async (peer: string) => {
      const r = opts.remote.get(peer);
      if (r instanceof Error) throw r;
      return r;
    },
    chain: {
      getLatestMerkleRoot: async () => opts.root,
      getMerkleLeafCount: async () => opts.leafCount,
      getLatestMerkleRootAuthor: async () => opts.author,
      getKAContextGraphId: async () => opts.kaScope,
    },
  } as unknown as DKGAgent;
}

const run = (asker: DKGAgent, peers: string[]) =>
  DragMethods.prototype.dragAnswerNetwork.call(asker, { question: 'q', contextGraphId: 'cg', peers });

describe('dRAG P3 — trustless aggregation (asker re-verifies, never trusts a peer verdict)', () => {
  it("flips a lying peer's checks.verified=true to false on a tampered triple", async () => {
    const wallet = ethers.Wallet.createRandom() as unknown as ethers.Wallet;
    const { citation, root } = await buildSignedCitation(wallet, 1);
    // The peer tampers the triple's object but still SELF-REPORTS verified:true.
    const lie: VerifiableCitation = {
      ...citation,
      triple: { ...citation.triple, object: '"PASSED — compliant"' },
      checks: { merkle: true, onChain: true, authorSig: true, verified: true },
    };
    const asker = makeAsker({
      remote: new Map([['peerLiar', peerResult([lie])]]),
      root,
      author: wallet.address,
      leafCount: citation.proof.leafCount,
      kaScope: 1n,
      askedCgId: 1n,
    });
    const res = await run(asker, ['peerLiar']);
    // The asker re-verified with its OWN chain and rejected the tamper — it did
    // NOT echo the peer's verified:true.
    expect(res.citations.filter((c) => c.checks.verified)).toHaveLength(0);
    expect(res.perNode[0].verified).toBe(0);
    expect(res.stats.verified).toBe(0);
  });

  it('drops a genuinely-verifiable citation that belongs to a DIFFERENT CG (scope-swap defense)', async () => {
    const wallet = ethers.Wallet.createRandom() as unknown as ethers.Wallet;
    const { citation, root } = await buildSignedCitation(wallet, 0); // cryptographically valid
    const asker = makeAsker({
      remote: new Map([['peerOffScope', peerResult([citation])]]),
      root,
      author: wallet.address,
      leafCount: citation.proof.leafCount,
      kaScope: 999n, // this KA actually belongs to CG 999, not the asked CG 1
      askedCgId: 1n,
    });
    const res = await run(asker, ['peerOffScope']);
    expect(res.citations).toHaveLength(0); // dropped off-scope despite being valid
  });

  it('isolates a throwing peer as a per-node error without dropping an honest peer', async () => {
    const wallet = ethers.Wallet.createRandom() as unknown as ethers.Wallet;
    const { citation, root } = await buildSignedCitation(wallet, 0);
    const asker = makeAsker({
      remote: new Map<string, unknown>([
        ['peerBad', new Error('peer exploded')],
        ['peerGood', peerResult([citation])],
      ]),
      root,
      author: wallet.address,
      leafCount: citation.proof.leafCount,
      kaScope: 1n,
      askedCgId: 1n,
    });
    const res = await run(asker, ['peerBad', 'peerGood']);
    expect(res.citations.some((c) => c.checks.verified)).toBe(true); // honest peer survives
    expect(res.perNode.find((p) => p.peerId === 'peerBad')?.error).toBeTruthy();
    expect(res.perNode.find((p) => p.peerId === 'peerGood')?.verified).toBe(1);
  });

  it('rejects a SPARQL-injection contextGraphId before it reaches any SPARQL sink', async () => {
    let sinkCalled = false;
    const asker = {
      peerId: '12D3KooWAsker',
      getContextGraphOnChainId: async () => {
        sinkCalled = true;
        return '1';
      },
      discovery: {
        findNodesServingCG: async () => {
          sinkCalled = true;
          return [];
        },
      },
      dragAnswerRemote: async () => peerResult([]),
      chain: {},
    } as unknown as DKGAgent;
    const res = await DragMethods.prototype.dragAnswerNetwork.call(asker, {
      question: 'q',
      contextGraphId: 'cg> } INSERT DATA { <urn:x> <urn:y> <urn:z> } #',
      peers: ['x'],
    });
    expect(sinkCalled).toBe(false); // the crafted id never reached getContextGraphOnChainId/findNodesServingCG
    expect(res.citations).toHaveLength(0);
    expect(res.answer).toMatch(/invalid context graph id/i);
  });

  it('accepts an honest peer (sanity: a valid in-scope citation verifies true)', async () => {
    const wallet = ethers.Wallet.createRandom() as unknown as ethers.Wallet;
    const { citation, root } = await buildSignedCitation(wallet, 1);
    const asker = makeAsker({
      remote: new Map([['peerHonest', peerResult([citation])]]),
      root,
      author: wallet.address,
      leafCount: citation.proof.leafCount,
      kaScope: 1n,
      askedCgId: 1n,
    });
    const res = await run(asker, ['peerHonest']);
    expect(res.citations.filter((c) => c.checks.verified)).toHaveLength(1);
  });
});
