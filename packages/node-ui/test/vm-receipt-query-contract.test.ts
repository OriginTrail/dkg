/**
 * Contract: the VM receipt loader reads the records the writers store,
 * through the node's scoped query engine.
 *
 * The receipt summary (VM header facts) and graph anchors come from
 * `loadVmReceiptsWith`. Testing them on fabricated rows can't catch a query
 * whose predicates or graphs no writer emits, nor a graph the API's scoping
 * hides, so this runs the loader's REAL queries with its REAL options through
 * `DKGQueryEngine` over a store seeded by the REAL writers:
 *   - a legacy root-scoped seal (members on the seal),
 *   - a graph-scoped seal whose entity is not under the assertion URI,
 *   - a graph-scoped seal inside a registered sub-graph,
 *   - an assertion with no receipt, and a receipt in another context graph.
 */
import { describe, it, expect } from 'vitest';
import {
  MemoryLayer,
  buildAssertionPublishReceiptQuads,
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphLayerUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
// Cross-package relative imports, as in use-entity-onchain-receipt-query.test.ts:
// node-ui doesn't depend on these at runtime, but the contract must EXECUTE
// the queries the way the daemon does. Storage comes from its built entry,
// the copy the query engine itself loads (two copies can't share a store).
import { OxigraphStore } from '../../storage/dist/index.js';
import { DKGQueryEngine } from '../../query/src/index.js';
import { generateSubGraphRegistration } from '../../publisher/src/metadata.js';
import { loadVmReceiptsWith, MEMBER_ROW_LIMIT, type VmQueryRunner, type VmReceiptLoad } from '../src/ui/hooks/useVmReceipts.js';
import { hasReceipt, summariseVmReceipts } from '../src/ui/hooks/useVmReceiptSummary.js';
import { buildVmFacts } from '../src/ui/views/project/vm-facts.js';
import type { MemoryEntity } from '../src/ui/hooks/useMemoryEntities.js';

const CG = 'vm-receipt-contract';
const OTHER_CG = 'vm-receipt-contract-other';
const SUB = 'research';
const META = contextGraphMetaUri(CG);
const AUTHOR = '0x' + 'aa'.repeat(20);
const KAV10 = '0x' + 'cc'.repeat(20);
const FINALIZED = '2026-06-12T00:00:00.000Z';

const LEGACY_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'legacy-note');
const LEGACY_ENTITY = 'urn:contract:legacy:1';
const V2_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'graph-note');
const V2_KA_GRAPH = contextGraphLayerUri(CG, MemoryLayer.VerifiableMemory, AUTHOR, 7n);
const V2_ENTITY = 'urn:member-one:note'; // not under the assertion URI
const SUB_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'sub-note', SUB);
const SUB_KA_GRAPH = contextGraphLayerUri(CG, MemoryLayer.VerifiableMemory, AUTHOR, 8n, SUB);
const SUB_ENTITY = 'urn:note:1';
const UNRECEIPTED_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'draft');
const UNRECEIPTED_ENTITY = 'urn:contract:draft:1';

const bytes = (n: number) => new Uint8Array(32).fill(n);
const sealBase = (assertionUri: string, metaGraph: string, reservedKaId: bigint) => ({
  assertionUri,
  metaGraph,
  merkleRoot: bytes(1),
  authorAddress: AUTHOR,
  authorAttestationR: bytes(2),
  authorAttestationVS: bytes(3),
  authorSchemeVersion: 1,
  chainId: 31337n,
  kav10Address: KAV10,
  reservedKaId,
  finalizedAtIso: FINALIZED,
});
const graphScoped = (assertionUri: string, kaNumber: bigint) => buildAssertionSealQuads({
  ...sealBase(assertionUri, META, kaNumber),
  contentScopeVersion: 2,
  kaUal: `did:dkg:hardhat:31337/${AUTHOR}/${kaNumber}`,
  assertionVersion: 1,
  publicTripleCount: 2,
  privateTripleCount: 0,
});
const receipt = (assertionUri: string, metaGraph: string, tx: string) =>
  buildAssertionPublishReceiptQuads({ assertionUri, metaGraph, txHash: tx, blockNumber: 42n });
const content = (entity: string, graph: string) => [
  { subject: entity, predicate: 'http://schema.org/name', object: '"Note"', graph },
  { subject: entity, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://schema.org/Note', graph },
];

async function seed(): Promise<OxigraphStore> {
  const store = new OxigraphStore();
  // Legacy root-scoped seal: members listed on the seal.
  await store.insert(buildAssertionSealQuads({ ...sealBase(LEGACY_ASRT, META, 6n), rootEntities: [LEGACY_ENTITY] }));
  await store.insert(receipt(LEGACY_ASRT, META, '0x' + '11'.repeat(32)));
  // Current graph-scoped seal at the root: no member rows; the content is the per-KA graph.
  await store.insert(graphScoped(V2_ASRT, 7n));
  await store.insert(receipt(V2_ASRT, META, '0x' + '22'.repeat(32)));
  await store.insert(content(V2_ENTITY, V2_KA_GRAPH));
  // Graph-scoped seal inside a registered sub-graph; seals and receipts stay in the root _meta.
  await store.insert(generateSubGraphRegistration({ contextGraphId: CG, subGraphName: SUB, createdBy: AUTHOR, timestamp: new Date(FINALIZED) }));
  await store.insert(graphScoped(SUB_ASRT, 8n));
  await store.insert(receipt(SUB_ASRT, META, '0x' + '44'.repeat(32)));
  await store.insert(content(SUB_ENTITY, SUB_KA_GRAPH));
  // A sealed assertion that was never published: no receipt.
  await store.insert(buildAssertionSealQuads({ ...sealBase(UNRECEIPTED_ASRT, META, 9n), rootEntities: [UNRECEIPTED_ENTITY] }));
  // A receipt in another context graph.
  const otherAsrt = contextGraphAssertionUri(OTHER_CG, AUTHOR, 'elsewhere');
  await store.insert(buildAssertionSealQuads({ ...sealBase(otherAsrt, contextGraphMetaUri(OTHER_CG), 10n), rootEntities: ['urn:contract:other:1'] }));
  await store.insert(receipt(otherAsrt, contextGraphMetaUri(OTHER_CG), '0x' + '33'.repeat(32)));
  return store;
}

/** The daemon's path: the loader's queries and options through the scoped engine. */
const scopedRunner = (store: OxigraphStore): VmQueryRunner => {
  const engine = new DKGQueryEngine(store);
  return async (sparql, options) => (await engine.query(sparql, options)).bindings as Array<Record<string, unknown>>;
};

async function load(): Promise<VmReceiptLoad> {
  const store = await seed();
  try { return await loadVmReceiptsWith(CG, scopedRunner(store)); } finally { await store.close(); }
}

const entity = (uri: string): MemoryEntity => ({ uri } as MemoryEntity);

describe('VM receipt loader against writer-shaped RDF through the scoped engine', () => {
  it('loads one receipt per published assertion in this context graph only', async () => {
    const { receipts, complete } = await load();
    expect(complete).toBe(true);
    expect(receipts.map(r => r.assertion).sort()).toEqual([LEGACY_ASRT, SUB_ASRT, V2_ASRT].sort());
    for (const r of receipts) expect(r.finalizedAt).toBe(FINALIZED);
  });

  it('reads members from the seal, the root per-KA graph and the sub-graph per-KA graph', async () => {
    const byAssertion = new Map((await load()).receipts.map(r => [r.assertion, r]));
    expect(byAssertion.get(LEGACY_ASRT)).toMatchObject({ members: [LEGACY_ENTITY] });
    expect(byAssertion.get(LEGACY_ASRT)?.kaGraph).toBeUndefined();
    expect(byAssertion.get(V2_ASRT)).toMatchObject({ kaGraph: V2_KA_GRAPH, members: [V2_ENTITY] });
    expect(byAssertion.get(SUB_ASRT)).toMatchObject({ subGraph: SUB, kaGraph: SUB_KA_GRAPH, members: [SUB_ENTITY] });
  });

  it('counts all three kinds as anchored and leaves the unreceipted entity out', async () => {
    const { receipts, complete } = await load();
    const summary = summariseVmReceipts(receipts, complete);
    for (const uri of [LEGACY_ENTITY, V2_ENTITY, SUB_ENTITY]) expect(hasReceipt(uri, summary), uri).toBe(true);
    expect(hasReceipt(UNRECEIPTED_ENTITY, summary)).toBe(false);
    expect(hasReceipt('urn:contract:other:1', summary)).toBe(false);
    const facts = buildVmFacts([LEGACY_ENTITY, V2_ENTITY, SUB_ENTITY, UNRECEIPTED_ENTITY].map(entity), summary, { loading: false, error: null });
    expect(facts.find(f => f.id === 'onchain')?.value).toBe('3 / 4 anchored');
  });

  it('marks the load incomplete when a capped read comes back full, and the facts stop claiming missing receipts', async () => {
    const store = await seed();
    try {
      const run = scopedRunner(store);
      // Simulate a membership read that hit its cap.
      const capped: VmQueryRunner = async (sparql, options) => {
        const rows = await run(sparql, options);
        return sparql.includes('VALUES ?g') ? [...rows, ...Array.from({ length: MEMBER_ROW_LIMIT }, () => ({}))] : rows;
      };
      const { receipts, complete } = await loadVmReceiptsWith(CG, capped);
      expect(complete).toBe(false);
      const facts = buildVmFacts([entity(UNRECEIPTED_ENTITY)], summariseVmReceipts(receipts, complete), { loading: false, error: null });
      const onchain = facts.find(f => f.id === 'onchain');
      expect(onchain).toMatchObject({ value: 'at least 0 / 1 anchored', tone: 'muted' });
    } finally { await store.close(); }
  });
});
