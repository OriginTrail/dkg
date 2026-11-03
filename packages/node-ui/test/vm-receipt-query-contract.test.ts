/**
 * Contract: the VM receipt queries bind the records the writers store.
 *
 * The receipt summary (VM header facts) and graph anchors are derived from
 * `buildVmReceiptQuery` + `buildKaGraphMemberQuery`. Testing them on
 * fabricated rows can't catch a query whose predicates or graphs no writer
 * emits, so this runs the REAL queries against a REAL store seeded by the
 * REAL writers — a legacy root-scoped seal, a current graph-scoped seal whose
 * entity is not under the assertion URI, an assertion with no receipt, and a
 * receipt in another context graph — and carries the bindings through the
 * parser into the summary and the VM facts.
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
// Cross-package relative import, as in use-entity-onchain-receipt-query.test.ts:
// node-ui doesn't depend on dkg-storage at runtime, but the contract must
// EXECUTE the queries.
import { OxigraphStore } from '../../storage/src/index.js';
import {
  addKaGraphMembers,
  buildKaGraphMemberQuery,
  buildVmReceiptQuery,
  parseVmReceiptRows,
  type VmReceipt,
} from '../src/ui/hooks/useVmReceipts.js';
import { hasReceipt, summariseVmReceipts } from '../src/ui/hooks/useVmReceiptSummary.js';
import { buildVmFacts } from '../src/ui/views/project/vm-facts.js';
import type { MemoryEntity } from '../src/ui/hooks/useMemoryEntities.js';

const CG = 'vm-receipt-contract';
const OTHER_CG = 'vm-receipt-contract-other';
const META = contextGraphMetaUri(CG);
const AUTHOR = '0x' + 'aa'.repeat(20);
const KAV10 = '0x' + 'cc'.repeat(20);
const FINALIZED = '2026-06-12T00:00:00.000Z';

const LEGACY_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'legacy-note');
const LEGACY_ENTITY = 'urn:contract:legacy:1';
const V2_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'graph-note');
const V2_KA_NUMBER = 7n;
const V2_UAL = `did:dkg:hardhat:31337/${AUTHOR}/${V2_KA_NUMBER}`;
const V2_KA_GRAPH = contextGraphLayerUri(CG, MemoryLayer.VerifiableMemory, AUTHOR, V2_KA_NUMBER);
const V2_ENTITY = 'urn:member-one:note'; // not under the assertion URI
const UNRECEIPTED_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'draft');
const UNRECEIPTED_ENTITY = 'urn:contract:draft:1';

const bytes = (n: number) => new Uint8Array(32).fill(n);
const sealBase = (assertionUri: string, metaGraph: string) => ({
  assertionUri,
  metaGraph,
  merkleRoot: bytes(1),
  authorAddress: AUTHOR,
  authorAttestationR: bytes(2),
  authorAttestationVS: bytes(3),
  authorSchemeVersion: 1,
  chainId: 31337n,
  kav10Address: KAV10,
  reservedKaId: V2_KA_NUMBER,
  finalizedAtIso: FINALIZED,
});
const receipt = (assertionUri: string, metaGraph: string, tx: string) =>
  buildAssertionPublishReceiptQuads({ assertionUri, metaGraph, txHash: tx, blockNumber: 42n });

async function seed(): Promise<OxigraphStore> {
  const store = new OxigraphStore();
  // Legacy root-scoped seal: members listed on the seal.
  await store.insert(buildAssertionSealQuads({ ...sealBase(LEGACY_ASRT, META), rootEntities: [LEGACY_ENTITY] }));
  await store.insert(receipt(LEGACY_ASRT, META, '0x' + '11'.repeat(32)));
  // Current graph-scoped seal: no member rows; the content is the per-KA graph.
  await store.insert(buildAssertionSealQuads({
    ...sealBase(V2_ASRT, META),
    contentScopeVersion: 2,
    kaUal: V2_UAL,
    assertionVersion: 1,
    publicTripleCount: 2,
    privateTripleCount: 0,
  }));
  await store.insert(receipt(V2_ASRT, META, '0x' + '22'.repeat(32)));
  await store.insert([
    { subject: V2_ENTITY, predicate: 'http://schema.org/name', object: '"Note"', graph: V2_KA_GRAPH },
    { subject: V2_ENTITY, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://schema.org/Note', graph: V2_KA_GRAPH },
  ]);
  // A sealed assertion that was never published: no receipt.
  await store.insert(buildAssertionSealQuads({ ...sealBase(UNRECEIPTED_ASRT, META), rootEntities: [UNRECEIPTED_ENTITY] }));
  // A receipt in another context graph.
  const otherAsrt = contextGraphAssertionUri(OTHER_CG, AUTHOR, 'elsewhere');
  await store.insert(buildAssertionSealQuads({ ...sealBase(otherAsrt, contextGraphMetaUri(OTHER_CG)), rootEntities: ['urn:contract:other:1'] }));
  await store.insert(receipt(otherAsrt, contextGraphMetaUri(OTHER_CG), '0x' + '33'.repeat(32)));
  return store;
}

async function loadFrom(store: OxigraphStore): Promise<VmReceipt[]> {
  const res = await store.query(buildVmReceiptQuery(CG));
  const receipts = parseVmReceiptRows(res.type === 'bindings' ? res.bindings : [], CG);
  const kaGraphs = receipts.flatMap(r => (r.kaGraph ? [r.kaGraph] : []));
  const members = await store.query(buildKaGraphMemberQuery(kaGraphs));
  return addKaGraphMembers(receipts, members.type === 'bindings' ? members.bindings : []);
}

const entity = (uri: string): MemoryEntity => ({ uri } as MemoryEntity);

describe('VM receipt queries against writer-shaped RDF', () => {
  it('loads one receipt per published assertion in this context graph only', async () => {
    const receipts = await loadFrom(await seed());
    expect(receipts.map(r => r.assertion).sort()).toEqual([LEGACY_ASRT, V2_ASRT].sort());
    for (const r of receipts) expect(r.finalizedAt).toBe(FINALIZED);
  });

  it('reads legacy members from the seal and graph-scoped members from the per-KA graph', async () => {
    const receipts = await loadFrom(await seed());
    const byAssertion = new Map(receipts.map(r => [r.assertion, r]));
    expect(byAssertion.get(LEGACY_ASRT)).toMatchObject({ members: [LEGACY_ENTITY] });
    expect(byAssertion.get(LEGACY_ASRT)?.kaGraph).toBeUndefined();
    expect(byAssertion.get(V2_ASRT)).toMatchObject({ kaGraph: V2_KA_GRAPH, members: [V2_ENTITY] });
  });

  it('counts both kinds as anchored and leaves the unreceipted entity out', async () => {
    const summary = summariseVmReceipts(await loadFrom(await seed()));
    expect(hasReceipt(LEGACY_ENTITY, summary)).toBe(true);
    expect(hasReceipt(V2_ENTITY, summary)).toBe(true);
    expect(hasReceipt(UNRECEIPTED_ENTITY, summary)).toBe(false);
    expect(hasReceipt('urn:contract:other:1', summary)).toBe(false);
    const facts = buildVmFacts([entity(LEGACY_ENTITY), entity(V2_ENTITY), entity(UNRECEIPTED_ENTITY)], summary, { loading: false, error: null });
    expect(facts.find(f => f.id === 'onchain')?.value).toBe('2 / 3 anchored');
  });
});
