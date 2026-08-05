/**
 * gatherVerifiedFacts — the closed-world completeness gate, exercised through
 * the REAL method (not a mock): a real in-process OxigraphStore laid out with
 * the same v1 KC fixture shape as the random-sampling extractor gold tests,
 * real extraction + citation building, and a fake chain returning the genuine
 * Merkle root computed from the extracted triples.
 *
 * `complete` is what makes EYE reasoning sound (closed-world negation over a
 * partial fact set derives wrong conclusions), so every way it can drop to
 * false is pinned here against the method that actually computes it:
 * locally-unextractable KAs, failed chain reads, un-decodable legacy VM graph
 * names, the checks.verified trust gate itself (zero-address author), graph
 * caps and triple caps — plus the documented sub-graph invisibility gap, pinned
 * so it fails loudly when sub-graph-aware extraction lands.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  structuredKARootV10,
  tripleContentV10,
  keccak256,
  contextGraphMetaUri,
  contextGraphDataUri,
} from '@origintrail-official/dkg-core';
import { extractV10KCFromStore } from '@origintrail-official/dkg-random-sampling';
import { DragMethods } from '../src/dkg-agent-drag.js';
import type { DKGAgent } from '../src/dkg-agent.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const CONTEXT_GRAPH_ON_CHAIN_ID = 'https://dkg.network/ontology#ContextGraphOnChainId';

const CG_NAME = 'drag-gvf';
const CG_ID = 77n;
const AUTHOR = '0x1111111111111111111111111111111111111111';
const KA_NUMBER = 9n;
const KA_ID = (BigInt(AUTHOR) << 96n) | KA_NUMBER;
const CHAIN_ID = 31337n;

const CG_URI = `did:dkg:context-graph:${CG_NAME}`;
const META_GRAPH = contextGraphMetaUri(CG_NAME, CG_ID.toString());
const DATA_GRAPH = contextGraphDataUri(CG_NAME, CG_ID.toString());

const TRIPLES = [
  { subject: 'urn:gvf:supplier', predicate: 'http://schema.org/name', object: '"Northwind Components"' },
  { subject: 'urn:gvf:supplier', predicate: 'http://schema.org/auditStatus', object: '"flagged"' },
  { subject: 'urn:gvf:supplier', predicate: 'http://schema.org/incidents', object: '"3"' },
];

async function seedOneKC(
  store: OxigraphStore,
  args: {
    author: string;
    number: bigint;
    rootEntity: string;
    triples: Array<{ subject: string; predicate: string; object: string }>;
  },
): Promise<void> {
  const kaId = (BigInt(args.author) << 96n) | args.number;
  const ual = `did:dkg:otp:20430/${args.author}/${args.number}`;
  const metaQuads: Quad[] = [
    { subject: ual, predicate: `${RDF}type`, object: `${DKG}KnowledgeCollection`, graph: META_GRAPH },
    { subject: ual, predicate: `${DKG}batchId`, object: `"${kaId}"^^<${XSD}integer>`, graph: META_GRAPH },
    { subject: `${ual}/1`, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: META_GRAPH },
    { subject: `${ual}/1`, predicate: `${DKG}partOf`, object: ual, graph: META_GRAPH },
    { subject: `${ual}/1`, predicate: `${DKG}rootEntity`, object: args.rootEntity, graph: META_GRAPH },
  ];
  await store.insert(metaQuads);
  await store.insert(args.triples.map((t) => ({ ...t, graph: DATA_GRAPH })));
  // The VM graph's CONTENT is irrelevant to gatherVerifiedFacts — it only
  // discovers KA ids from the graph NAME; extraction reads meta + data graphs.
  await store.insert([
    {
      subject: ual,
      predicate: `${DKG}promotedAt`,
      object: '"seed"',
      graph: `${CG_URI}/_verifiable_memory/${args.author}/${args.number}`,
    },
  ]);
}

async function seedKC(store: OxigraphStore): Promise<void> {
  await store.insert([
    { subject: CG_URI, predicate: CONTEXT_GRAPH_ON_CHAIN_ID, object: `"${CG_ID}"`, graph: ONTOLOGY_GRAPH },
  ]);
  await seedOneKC(store, {
    author: AUTHOR,
    number: KA_NUMBER,
    rootEntity: 'urn:gvf:supplier',
    triples: TRIPLES,
  });
}

/** The on-chain root the seeded KA truthfully commits to. */
async function anchoredRoot(store: OxigraphStore): Promise<{ root: Uint8Array; leafCount: number }> {
  const kc = await extractV10KCFromStore(store, CG_ID, KA_ID);
  const leaves = kc.triples.map((t) => keccak256(tripleContentV10(t.subject, t.predicate, t.object)));
  const { root, leafCount } = structuredKARootV10(leaves, kc.privateRoots);
  return { root, leafCount };
}

type ChainStub = {
  getLatestMerkleRoot: (kaId: bigint) => Promise<Uint8Array>;
  getMerkleLeafCount: (kaId: bigint) => Promise<number>;
  getLatestMerkleRootAuthor: (kaId: bigint) => Promise<string>;
  getEvmChainId: () => Promise<bigint>;
};

function agentWith(store: OxigraphStore, chain: ChainStub): DKGAgent {
  return {
    peerId: '12D3KooWGvfTester',
    store,
    chain,
    getContextGraphOnChainId: async (name: string) => (name === CG_NAME ? CG_ID.toString() : null),
  } as unknown as DKGAgent;
}

const gather = (agent: DKGAgent, cg: string, opts?: { cap?: number; maxTriples?: number }) =>
  DragMethods.prototype.gatherVerifiedFacts.call(agent, cg, opts);

describe('gatherVerifiedFacts — real-method completeness gate', () => {
  let store: OxigraphStore;
  let root: Uint8Array;
  let leafCount: number;
  let chain: ChainStub;

  beforeEach(async () => {
    store = new OxigraphStore();
    await seedKC(store);
    ({ root, leafCount } = await anchoredRoot(store));
    chain = {
      getLatestMerkleRoot: async (kaId: bigint) => {
        if (kaId !== KA_ID) throw new Error('not anchored');
        return root;
      },
      getMerkleLeafCount: async () => leafCount,
      getLatestMerkleRootAuthor: async () => AUTHOR,
      getEvmChainId: async () => CHAIN_ID,
    };
  });

  it('is complete over a fully anchored CG, every fact chain-verified', async () => {
    const res = await gather(agentWith(store, chain), CG_NAME);
    expect(res.complete).toBe(true);
    expect(res.truncated).toBe(false);
    expect(res.graphsSeen).toBe(1);
    expect(res.graphsSkipped).toBe(0);
    expect(res.facts.map((f) => f.triple.object).sort()).toEqual(
      TRIPLES.map((t) => t.object).sort(),
    );
    for (const f of res.facts) {
      expect(f.citation.checks.verified).toBe(true);
      expect(f.citation.onChain.author.toLowerCase()).toBe(AUTHOR.toLowerCase());
    }
  });

  it('drops complete when a discovered KA cannot be extracted locally (VM graph without meta)', async () => {
    const otherAuthor = '0x2222222222222222222222222222222222222222';
    await store.insert([
      {
        subject: 'urn:gvf:orphan',
        predicate: `${DKG}promotedAt`,
        object: '"seed"',
        graph: `${CG_URI}/_verifiable_memory/${otherAuthor}/1`,
      },
    ]);
    const res = await gather(agentWith(store, chain), CG_NAME);
    expect(res.complete).toBe(false);
    expect(res.graphsSkipped).toBe(1);
    // The anchored KA's facts still flow — refusal is the caller's decision.
    expect(res.facts).toHaveLength(TRIPLES.length);
  });

  it('drops complete when the chain read fails for a locally extractable KA (not anchored)', async () => {
    // Fully synced second KA — extraction succeeds, then the chain read throws
    // (the chain stub only anchors KA_ID). Pins that chain-read failures are
    // skipped, never swallowed into a locally-computed root.
    const otherAuthor = '0x2222222222222222222222222222222222222222';
    await seedOneKC(store, {
      author: otherAuthor,
      number: 1n,
      rootEntity: 'urn:gvf:other',
      triples: [{ subject: 'urn:gvf:other', predicate: 'http://schema.org/name', object: '"Other Corp"' }],
    });
    const res = await gather(agentWith(store, chain), CG_NAME);
    expect(res.complete).toBe(false);
    expect(res.graphsSkipped).toBe(1);
    expect(res.facts).toHaveLength(TRIPLES.length);
  });

  it('drops complete when a discovered VM graph name cannot be decoded (legacy vmId-keyed graph)', async () => {
    await store.insert([
      {
        subject: 'urn:gvf:legacy',
        predicate: `${DKG}promotedAt`,
        object: '"seed"',
        graph: `${CG_URI}/_verifiable_memory/legacy-vm-id`,
      },
    ]);
    const res = await gather(agentWith(store, chain), CG_NAME);
    expect(res.complete).toBe(false);
    expect(res.graphsSkipped).toBe(1);
  });

  it('silently omits sub-graph-scoped KAs: not discovered, complete stays true (documented follow-up)', async () => {
    // Real sub-graph VM layout puts the sub-graph name BEFORE the layer slug
    // (`{cg}/rules/_verifiable_memory/{author}/{n}`), which fails the root-scoped
    // vmPrefix STRSTARTS — the KA is never seen, so its facts are absent while
    // complete remains true. This is the known closed-world soundness gap the
    // method's docstring documents; when sub-graph-aware extraction lands and
    // these graphs become visible, this test fails loudly and must be updated.
    await store.insert([
      {
        subject: 'urn:gvf:subgraph',
        predicate: `${DKG}promotedAt`,
        object: '"seed"',
        graph: `${CG_URI}/rules/_verifiable_memory/${AUTHOR}/1`,
      },
    ]);
    const res = await gather(agentWith(store, chain), CG_NAME);
    expect(res.graphsSeen).toBe(1);
    expect(res.graphsSkipped).toBe(0);
    expect(res.complete).toBe(true);
    expect(res.facts).toHaveLength(TRIPLES.length);
  });

  it('drops complete when the chain root disagrees with the stored content (proof construction fails)', async () => {
    chain.getLatestMerkleRoot = async () => keccak256(new TextEncoder().encode('tampered'));
    const res = await gather(agentWith(store, chain), CG_NAME);
    expect(res.complete).toBe(false);
    expect(res.facts).toHaveLength(0);
    expect(res.graphsSkipped).toBeGreaterThan(0);
  });

  it('drops complete when the on-chain author is the zero address (trust gate: unverified citation)', async () => {
    // Root and leaf count agree, so citeTriple SUCCEEDS but the citation cannot
    // be author-verified (zero address, no seal) — verified:false. This is the
    // only path that exercises the `!citation.checks.verified` trust gate
    // itself, as opposed to the throw-paths above.
    chain.getLatestMerkleRootAuthor = async () => `0x${'0'.repeat(40)}`;
    const res = await gather(agentWith(store, chain), CG_NAME);
    expect(res.complete).toBe(false);
    expect(res.facts).toHaveLength(0);
    expect(res.graphsSkipped).toBeGreaterThan(0);
  });

  it('drops complete when the graph cap truncates discovery', async () => {
    const otherAuthor = '0x3333333333333333333333333333333333333333';
    await store.insert([
      {
        subject: 'urn:gvf:second',
        predicate: `${DKG}promotedAt`,
        object: '"seed"',
        graph: `${CG_URI}/_verifiable_memory/${otherAuthor}/2`,
      },
    ]);
    const res = await gather(agentWith(store, chain), CG_NAME, { cap: 1 });
    expect(res.truncated).toBe(true);
    expect(res.complete).toBe(false);
    expect(res.graphsSeen).toBe(1);
  });

  it('drops complete when maxTriples truncates the fact set', async () => {
    const res = await gather(agentWith(store, chain), CG_NAME, { maxTriples: 2 });
    expect(res.truncated).toBe(true);
    expect(res.complete).toBe(false);
    expect(res.facts).toHaveLength(2);
  });

  it('is vacuously complete over an empty CG and incomplete for an unknown one', async () => {
    const emptyStore = new OxigraphStore();
    await emptyStore.insert([
      { subject: CG_URI, predicate: CONTEXT_GRAPH_ON_CHAIN_ID, object: `"${CG_ID}"`, graph: ONTOLOGY_GRAPH },
    ]);
    const emptyRes = await gather(agentWith(emptyStore, chain), CG_NAME);
    expect(emptyRes.complete).toBe(true);
    expect(emptyRes.facts).toHaveLength(0);

    const unknownRes = await gather(agentWith(store, chain), 'no-such-cg');
    expect(unknownRes.complete).toBe(false);
    expect(unknownRes.facts).toHaveLength(0);
  });
});
