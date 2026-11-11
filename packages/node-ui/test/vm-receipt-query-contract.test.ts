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
 *   - an assertion with no receipt, and a receipt in another context graph,
 *   - republished assertions (with and without the UAL's current metadata),
 *   - a published assertion reopened, and one with an unpublished v2 finalized,
 *   - UAL-only confirmed metadata (transaction and finalized materialization).
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
import { generateAssertionCreatedMetadata, generateGraphKnowledgeAssetMetadata, generateSubGraphRegistration } from '../../publisher/src/metadata.js';
import { loadVmReceiptsWith, MEMBER_ROW_LIMIT, type VmQueryRunner, type VmReceiptLoad } from '../src/ui/hooks/useVmReceipts.js';
import { hasReceipt, summariseVmReceipts } from '../src/ui/hooks/useVmReceiptSummary.js';
import { buildVmFacts, vmSubjectsOf } from '../src/ui/views/project/vm-facts.js';
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
// Republished twice: receipts at blocks 42 and 43 on the same assertion, with
// hash order opposite to block order (the older hash sorts last), stored in
// both insertion orders. Nothing pairs a receipt's hash with its block.
const REPUB_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'republished');
const REPUB_ENTITY = 'urn:contract:repub:1';
const REPUB_REV_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'republished-reversed');
const REPUB_REV_ENTITY = 'urn:contract:repub:2';
const TX_OLD = '0x' + 'fe'.repeat(32);
const TX_NEW = '0x' + '01'.repeat(32);
// Republished graph-scoped KA whose confirmed UAL metadata names the current transaction.
const CURRENT_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'current-note');
const CURRENT_UAL = `did:dkg:hardhat:31337/${AUTHOR}/13`;
const CURRENT_KA_GRAPH = contextGraphLayerUri(CG, MemoryLayer.VerifiableMemory, AUTHOR, 13n);
const CURRENT_ENTITY = 'urn:contract:current:1';
const TX_CURRENT = '0x' + '88'.repeat(32);
// Published, then reopened for editing: the seal is cleared, the receipt stays.
const REOPENED_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'reopened-note');
const REOPENED_UAL = `did:dkg:hardhat:31337/${AUTHOR}/15`;
const REOPENED_KA_GRAPH = contextGraphLayerUri(CG, MemoryLayer.VerifiableMemory, AUTHOR, 15n);
const REOPENED_ENTITY = 'urn:contract:reopened:1';
const TX_REOPENED = '0x' + '99'.repeat(32);
// Published, reopened, and version 2 finalized but not published.
const DRAFT_ASRT = contextGraphAssertionUri(CG, AUTHOR, 'draft-v2-note');
const DRAFT_UAL = `did:dkg:hardhat:31337/${AUTHOR}/16`;
const DRAFT_KA_GRAPH = contextGraphLayerUri(CG, MemoryLayer.VerifiableMemory, AUTHOR, 16n);
const DRAFT_ENTITY = 'urn:contract:draft-v2:1';
const TX_DRAFT_V1 = '0x' + 'ab'.repeat(32);
const DRAFT_FINALIZED = '2026-07-01T00:00:00.000Z';
// Confirmed KA metadata on the UAL only (no named receipt): one that arrived
// through sync as a finalized materialization, one confirmed by transaction.
const SYNCED_UAL = `did:dkg:hardhat:31337/${AUTHOR}/11`;
const SYNCED_KA_GRAPH = contextGraphLayerUri(CG, MemoryLayer.VerifiableMemory, AUTHOR, 11n);
const SYNCED_ENTITY = 'urn:contract:synced:1';
const TXCONF_UAL = `did:dkg:hardhat:31337/${AUTHOR}/12`;
const TXCONF_KA_GRAPH = contextGraphLayerUri(CG, MemoryLayer.VerifiableMemory, AUTHOR, 12n);
const TXCONF_ENTITY = 'urn:contract:txconf:1';
const TX_CONF = '0x' + '77'.repeat(32);

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
const graphScoped = (assertionUri: string, kaNumber: bigint, version: { merkleRoot?: Uint8Array; assertionVersion?: number; finalizedAtIso?: string } = {}) => buildAssertionSealQuads({
  ...sealBase(assertionUri, META, kaNumber),
  ...(version.merkleRoot ? { merkleRoot: version.merkleRoot } : {}),
  ...(version.finalizedAtIso ? { finalizedAtIso: version.finalizedAtIso } : {}),
  contentScopeVersion: 2,
  kaUal: `did:dkg:hardhat:31337/${AUTHOR}/${kaNumber}`,
  assertionVersion: version.assertionVersion ?? 1,
  publicTripleCount: 2,
  privateTripleCount: 0,
});
const receipt = (assertionUri: string, metaGraph: string, tx: string, blockNumber = 42n) =>
  buildAssertionPublishReceiptQuads({ assertionUri, metaGraph, txHash: tx, blockNumber });
const confirmedKa = (ual: string, assertionGraph: string, kaNumber: bigint, state: Parameters<typeof generateGraphKnowledgeAssetMetadata>[1], merkleRoot = bytes(Number(kaNumber))) =>
  generateGraphKnowledgeAssetMetadata({
    contextGraphId: CG, ual, merkleRoot, publisherPeerId: 'peer-contract', accessPolicy: 'public', allowedPeers: [],
    timestamp: new Date(FINALIZED), assertionVersion: 1, authorAddress: AUTHOR, publicTripleCount: 2, privateTripleCount: 0, assertionGraph,
  } as any, state);
const txConfirmation = (txHash: string, kaNumber: bigint): Parameters<typeof generateGraphKnowledgeAssetMetadata>[1] => ({
  status: 'confirmed',
  confirmation: { kind: 'transaction', provenance: { txHash, blockNumber: 44, blockTimestamp: 0, publisherAddress: AUTHOR, batchId: kaNumber, chainId: 'hardhat:31337' } },
});
/** The assertion's lifecycle record, with its durable reserved UAL. */
const lifecycle = (name: string, kaNumber: bigint, reservedUal: string) => generateAssertionCreatedMetadata(
  { contextGraphId: CG, agentAddress: AUTHOR, assertionName: name, timestamp: new Date(FINALIZED), kaNumber, reservedUal } as any,
  { provenanceEvents: false },
);
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
  // Republished: two receipts for one assertion, newest first here and oldest first below.
  await store.insert(buildAssertionSealQuads({ ...sealBase(REPUB_ASRT, META, 10n), rootEntities: [REPUB_ENTITY] }));
  await store.insert(receipt(REPUB_ASRT, META, TX_NEW, 43n));
  await store.insert(receipt(REPUB_ASRT, META, TX_OLD, 42n));
  await store.insert(buildAssertionSealQuads({ ...sealBase(REPUB_REV_ASRT, META, 14n), rootEntities: [REPUB_REV_ENTITY] }));
  await store.insert(receipt(REPUB_REV_ASRT, META, TX_OLD, 42n));
  await store.insert(receipt(REPUB_REV_ASRT, META, TX_NEW, 43n));
  // Republished graph-scoped KA: two named receipts, and the UAL's metadata for the current version.
  // Its active seal is the confirmed version (same merkle root as the UAL's metadata).
  await store.insert(graphScoped(CURRENT_ASRT, 13n));
  await store.insert(receipt(CURRENT_ASRT, META, TX_OLD, 42n));
  await store.insert(receipt(CURRENT_ASRT, META, TX_NEW, 43n));
  await store.insert(confirmedKa(CURRENT_UAL, CURRENT_KA_GRAPH, 13n, txConfirmation(TX_CURRENT, 13n), bytes(1)));
  await store.insert(content(CURRENT_ENTITY, CURRENT_KA_GRAPH));
  // Published, then reopened: the publisher clears the active seal; the receipt and lifecycle stay.
  const reopenedSeal = graphScoped(REOPENED_ASRT, 15n);
  await store.insert(lifecycle('reopened-note', 15n, REOPENED_UAL));
  await store.insert(reopenedSeal);
  await store.insert(receipt(REOPENED_ASRT, META, TX_REOPENED, 45n));
  await store.insert(confirmedKa(REOPENED_UAL, REOPENED_KA_GRAPH, 15n, txConfirmation(TX_REOPENED, 15n), bytes(1)));
  await store.insert(content(REOPENED_ENTITY, REOPENED_KA_GRAPH));
  await store.delete(reopenedSeal);
  // Published v1, reopened, v2 finalized (new root, later time) but not published.
  const draftV1Seal = graphScoped(DRAFT_ASRT, 16n);
  await store.insert(lifecycle('draft-v2-note', 16n, DRAFT_UAL));
  await store.insert(draftV1Seal);
  await store.insert(receipt(DRAFT_ASRT, META, TX_DRAFT_V1, 46n));
  await store.insert(confirmedKa(DRAFT_UAL, DRAFT_KA_GRAPH, 16n, txConfirmation(TX_DRAFT_V1, 16n), bytes(1)));
  await store.insert(content(DRAFT_ENTITY, DRAFT_KA_GRAPH));
  await store.delete(draftV1Seal);
  await store.insert(graphScoped(DRAFT_ASRT, 16n, { merkleRoot: bytes(9), assertionVersion: 2, finalizedAtIso: DRAFT_FINALIZED }));
  // Synced through finalized materialization: confirmed KA metadata, no transaction hash.
  await store.insert(confirmedKa(SYNCED_UAL, SYNCED_KA_GRAPH, 11n, {
    status: 'confirmed',
    confirmation: { kind: 'finalized-materialization', provenance: { batchId: 11n, materializedVersion: { blockNumber: 40, txIndex: 0 } } },
  }));
  await store.insert(content(SYNCED_ENTITY, SYNCED_KA_GRAPH));
  // Confirmed by transaction, recorded on the UAL (no named receipt).
  await store.insert(confirmedKa(TXCONF_UAL, TXCONF_KA_GRAPH, 12n, {
    status: 'confirmed',
    confirmation: { kind: 'transaction', provenance: { txHash: TX_CONF, blockNumber: 41, blockTimestamp: 0, publisherAddress: AUTHOR, batchId: 12n, chainId: 'hardhat:31337' } },
  }));
  await store.insert(content(TXCONF_ENTITY, TXCONF_KA_GRAPH));
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

// Each seeded entity is the subject of its content triples.
const entity = (uri: string): MemoryEntity => ({ uri, types: ['http://schema.org/Note'], properties: new Map(), connections: [] } as unknown as MemoryEntity);
/** VM facts for entities that are all subjects of VM triples. */
const vmFacts = (entities: Array<{ uri: string }>, summary: Parameters<typeof buildVmFacts>[1]) =>
  buildVmFacts(entities as any, summary, { loading: false, error: null }, vmSubjectsOf(entities.map(e => ({ subject: e.uri }))));

describe('VM receipt loader against writer-shaped RDF through the scoped engine', () => {
  it('loads one receipt per published assertion in this context graph only', async () => {
    const { receipts, complete } = await load();
    expect(complete).toBe(true);
    expect(receipts.map(r => r.assertion).sort()).toEqual([LEGACY_ASRT, SUB_ASRT, V2_ASRT, REPUB_ASRT, REPUB_REV_ASRT, CURRENT_ASRT, REOPENED_ASRT, DRAFT_ASRT, SYNCED_UAL, TXCONF_UAL].sort());
    // The finalize time is the seal time, and only of a seal known to be the
    // confirmed content: legacy seals, and a graph-scoped seal whose root is the
    // confirmed root. Graph-scoped seals with nothing to compare against, UAL-only
    // records (publish/sync time is another event), reopened and draft seals: unknown.
    const sealed = new Set([LEGACY_ASRT, REPUB_ASRT, REPUB_REV_ASRT, CURRENT_ASRT]);
    for (const r of receipts) expect(r.finalizedAt, r.assertion).toBe(sealed.has(r.assertion) ? FINALIZED : null);
  });

  it('reads members from the seal, the root per-KA graph and the sub-graph per-KA graph', async () => {
    const byAssertion = new Map((await load()).receipts.map(r => [r.assertion, r]));
    expect(byAssertion.get(LEGACY_ASRT)).toMatchObject({ members: [LEGACY_ENTITY] });
    expect(byAssertion.get(LEGACY_ASRT)?.kaGraph).toBeUndefined();
    expect(byAssertion.get(V2_ASRT)).toMatchObject({ kaGraph: V2_KA_GRAPH, members: [V2_ENTITY] });
    expect(byAssertion.get(SUB_ASRT)).toMatchObject({ subGraph: SUB, kaGraph: SUB_KA_GRAPH, members: [SUB_ENTITY] });
    // UAL-only records resolve membership through dkg:assertionGraph.
    expect(byAssertion.get(SYNCED_UAL)).toMatchObject({ ual: SYNCED_UAL, tx: null, confirmation: 'finalized-materialization', kaGraph: SYNCED_KA_GRAPH, members: [SYNCED_ENTITY] });
    expect(byAssertion.get(TXCONF_UAL)).toMatchObject({ ual: TXCONF_UAL, tx: TX_CONF, confirmation: 'transaction', kaGraph: TXCONF_KA_GRAPH, members: [TXCONF_ENTITY] });
  });

  it('names no transaction for a named assertion published more than once, in either insertion order', async () => {
    const { receipts } = await load();
    expect(receipts.find(r => r.assertion === REPUB_ASRT)).toMatchObject({ tx: null, confirmation: 'receipt', members: [REPUB_ENTITY] });
    expect(receipts.find(r => r.assertion === REPUB_REV_ASRT)).toMatchObject({ tx: null, confirmation: 'receipt', members: [REPUB_REV_ENTITY] });
  });

  it("takes the current transaction from the UAL's confirmed metadata over the named receipts", async () => {
    const { receipts } = await load();
    expect(receipts.filter(r => r.ual === CURRENT_UAL)).toHaveLength(1);
    expect(receipts.find(r => r.ual === CURRENT_UAL)).toMatchObject({
      assertion: CURRENT_ASRT, tx: TX_CURRENT, confirmation: 'transaction', kaGraph: CURRENT_KA_GRAPH, members: [CURRENT_ENTITY], finalizedAt: FINALIZED,
    });
  });

  it('keeps one record per KA through reopening and an unpublished finalize, without the draft seal', async () => {
    const { receipts } = await load();
    expect(receipts.filter(r => r.ual === REOPENED_UAL)).toHaveLength(1);
    expect(receipts.find(r => r.ual === REOPENED_UAL)).toMatchObject({
      assertion: REOPENED_ASRT, tx: TX_REOPENED, confirmation: 'transaction', finalizedAt: null, members: [REOPENED_ENTITY],
    });
    expect(receipts.filter(r => r.ual === DRAFT_UAL)).toHaveLength(1);
    expect(receipts.find(r => r.ual === DRAFT_UAL)).toMatchObject({
      assertion: DRAFT_ASRT, tx: TX_DRAFT_V1, confirmation: 'transaction', finalizedAt: null, members: [DRAFT_ENTITY],
    });
  });

  it('counts every confirmed kind as anchored and leaves the unreceipted entity out', async () => {
    const { receipts, complete } = await load();
    const summary = summariseVmReceipts(receipts, complete);
    for (const uri of [LEGACY_ENTITY, V2_ENTITY, SUB_ENTITY, REPUB_ENTITY, REPUB_REV_ENTITY, CURRENT_ENTITY, REOPENED_ENTITY, DRAFT_ENTITY, SYNCED_ENTITY, TXCONF_ENTITY]) expect(hasReceipt(uri, summary), uri).toBe(true);
    expect(hasReceipt(UNRECEIPTED_ENTITY, summary)).toBe(false);
    expect(hasReceipt('urn:contract:other:1', summary)).toBe(false);
    const facts = vmFacts([LEGACY_ENTITY, V2_ENTITY, SUB_ENTITY, REPUB_ENTITY, REPUB_REV_ENTITY, CURRENT_ENTITY, REOPENED_ENTITY, DRAFT_ENTITY, SYNCED_ENTITY, TXCONF_ENTITY, UNRECEIPTED_ENTITY].map(entity), summary);
    expect(facts.find(f => f.id === 'onchain')?.value).toBe('10 / 11 anchored');
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
      const facts = vmFacts([entity(UNRECEIPTED_ENTITY)], summariseVmReceipts(receipts, complete));
      const onchain = facts.find(f => f.id === 'onchain');
      expect(onchain).toMatchObject({ value: 'at least 0 / 1 anchored', tone: 'muted' });
    } finally { await store.close(); }
  });
});
