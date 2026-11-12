// @vitest-environment happy-dom
//
// The entity provenance card and identity banner read the SAME receipt model
// as the VM header and graph anchors: one interpretation of publish evidence,
// a per-entity adapter on top (`receiptForEntity`). The store is seeded by the
// real writers and read through the node's scoped query engine.
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  buildAssertionPublishReceiptQuads,
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '../../storage/dist/index.js';
import { DKGQueryEngine } from '../../query/src/index.js';
import { generateAssertionCreatedMetadata, generateConfirmedFullMetadata } from '../../publisher/src/metadata.js';
import { summariseVmReceipts } from '../src/ui/hooks/useVmReceiptSummary.js';
import { buildVmFacts, vmSubjectsOf } from '../src/ui/views/project/vm-facts.js';
import { loadVmReceiptsWith, useVmReceiptsResource, VmReceiptsProvider, type VmReceipt } from '../src/ui/hooks/useVmReceipts.js';
import {
  buildShareQuery,
  entityReceiptOf,
  receiptForEntity,
  receiptForShareSource,
  useEntityOnChainReceipt,
  type EntityOnChainReceipt,
} from '../src/ui/hooks/useEntityOnChainReceipt.js';

const ADDR = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const NAME = 'note';
const FINALIZED = '2026-06-12T00:00:00.000Z';
const bytes = (n: number) => new Uint8Array(32).fill(n);

/** A legacy root-scoped seal plus one publish receipt, and the lifecycle record. */
async function seedNamed(store: OxigraphStore, cg: string, opts: { sub?: string; member: string; ual: string; agent: string; tx: string; kaNumber: bigint }) {
  const meta = contextGraphMetaUri(cg);
  const asrt = contextGraphAssertionUri(cg, ADDR, NAME, opts.sub);
  await store.insert(buildAssertionSealQuads({
    assertionUri: asrt, metaGraph: meta, merkleRoot: bytes(1), authorAddress: ADDR, authorAttestationR: bytes(2), authorAttestationVS: bytes(3),
    authorSchemeVersion: 1, chainId: 31337n, kav10Address: '0x' + 'cc'.repeat(20), reservedKaId: opts.kaNumber, finalizedAtIso: FINALIZED,
    rootEntities: [opts.member],
  }));
  await store.insert(buildAssertionPublishReceiptQuads({ assertionUri: asrt, metaGraph: meta, txHash: opts.tx, blockNumber: 42n }));
  const lifecycle = generateAssertionCreatedMetadata(
    { contextGraphId: cg, agentAddress: ADDR, assertionName: NAME, subGraphName: opts.sub, timestamp: new Date(FINALIZED), kaNumber: opts.kaNumber, reservedUal: opts.ual } as any,
    { provenanceEvents: false },
  ).map(q => (q.predicate === 'http://www.w3.org/ns/prov#wasAttributedTo' ? { ...q, object: opts.agent } : q));
  await store.insert(lifecycle);
  return asrt;
}

/** An older direct publish: confirmed collection metadata only, no named receipt. */
async function seedDirectPublish(store: OxigraphStore, cg: string, ual: string, roots: string[], tx: string) {
  await store.insert(generateConfirmedFullMetadata(
    { contextGraphId: cg, ual, merkleRoot: bytes(4), publisherPeerId: 'peer', authorAddress: ADDR, timestamp: new Date(FINALIZED) } as any,
    roots.map((rootEntity, i) => ({ tokenId: BigInt(i + 1), rootEntity, privateTripleCount: 0 })) as any,
    { txHash: tx, blockNumber: 50, blockTimestamp: 0, publisherAddress: ADDR, batchId: 77n, chainId: 'hardhat:31337' } as any,
  ));
}

/** VM facts for entities that are all subjects of VM triples. */
const vmFacts = (entities: Array<{ uri: string }>, summary: Parameters<typeof buildVmFacts>[1]) =>
  buildVmFacts(entities as any, summary, { loading: false, error: null }, vmSubjectsOf(entities.map(e => ({ subject: e.uri }))));

async function load(store: OxigraphStore, cg: string): Promise<VmReceipt[]> {
  const engine = new DKGQueryEngine(store);
  const { receipts } = await loadVmReceiptsWith(cg, async (sparql, options) => (await engine.query(sparql, options)).bindings as any);
  return receipts;
}

describe('receipt per entity, from the shared model', () => {
  it("keeps each sub-graph's UAL, agent and transaction when the same name and member exist in two sub-graphs", async () => {
    const CG = 'entity-scope';
    const SHARED = 'urn:member:shared';
    const store = new OxigraphStore();
    try {
      const demo = await seedNamed(store, CG, { sub: 'demo', member: SHARED, ual: `did:dkg:hardhat:31337/${ADDR}/7`, agent: `did:dkg:agent:${ADDR}`, tx: '0x' + 'ab'.repeat(32), kaNumber: 7n });
      const other = await seedNamed(store, CG, { sub: 'other', member: SHARED, ual: `did:dkg:hardhat:31337/${ADDR}/99`, agent: `did:dkg:agent:${OTHER}`, tx: '0x' + 'cd'.repeat(32), kaNumber: 99n });
      const receipts = await load(store, CG);
      const byAssertion = new Map(receipts.map(r => [r.assertion, r]));
      expect(byAssertion.get(demo)).toMatchObject({ subGraph: 'demo', ual: `did:dkg:hardhat:31337/${ADDR}/7`, tx: '0x' + 'ab'.repeat(32), signers: [`did:dkg:agent:${ADDR}`], blockNumber: '42' });
      expect(byAssertion.get(other)).toMatchObject({ subGraph: 'other', ual: `did:dkg:hardhat:31337/${ADDR}/99`, tx: '0x' + 'cd'.repeat(32), signers: [`did:dkg:agent:${OTHER}`] });
      // An entity under one assertion's URI resolves to that sub-graph, never the sibling.
      expect(receiptForEntity(receipts, `${demo}/entity/1`)?.assertion).toBe(demo);
      expect(receiptForEntity(receipts, `${other}/entity/1`)?.assertion).toBe(other);
      // A shared member resolves to one of them, with that receipt's own fields, the same way every time.
      const shared = receiptForEntity(receipts, SHARED)!;
      expect(receiptForEntity([...receipts].reverse(), SHARED)).toBe(shared);
      expect(entityReceiptOf(shared)).toMatchObject({ status: 'verified', ual: shared.ual, txHash: shared.tx, author: ADDR });
      expect(receiptForEntity(receipts, 'urn:member:unknown')).toBeNull();
    } finally { await store.close(); }
  });

  it('resolves UAL and agent through the lifecycle record under a wallet-scoped graph id containing "/"', async () => {
    const SLASH_CG = '0x00000000000000000000000000000000000000cc/experimental-music';
    const store = new OxigraphStore();
    try {
      const root = await seedNamed(store, SLASH_CG, { member: 'urn:member:root', ual: `did:dkg:hardhat:31337/${ADDR}/5`, agent: `did:dkg:agent:${ADDR}`, tx: '0x' + '11'.repeat(32), kaNumber: 5n });
      const sub = await seedNamed(store, SLASH_CG, { sub: 'demo', member: 'urn:member:sub', ual: `did:dkg:hardhat:31337/${ADDR}/6`, agent: `did:dkg:agent:${OTHER}`, tx: '0x' + '22'.repeat(32), kaNumber: 6n });
      const receipts = await load(store, SLASH_CG);
      expect(entityReceiptOf(receiptForEntity(receipts, 'urn:member:root')!)).toMatchObject({ ual: `did:dkg:hardhat:31337/${ADDR}/5`, agent: `did:dkg:agent:${ADDR}`, finalizedAt: FINALIZED });
      expect(receiptForEntity(receipts, 'urn:member:root')?.assertion).toBe(root);
      expect(entityReceiptOf(receiptForEntity(receipts, 'urn:member:sub')!)).toMatchObject({ ual: `did:dkg:hardhat:31337/${ADDR}/6`, agent: `did:dkg:agent:${OTHER}` });
      expect(receiptForEntity(receipts, 'urn:member:sub')?.assertion).toBe(sub);
    } finally { await store.close(); }
  });

  it('anchors assets of an older direct publish, from the collection record and its member rows', async () => {
    const CG = 'entity-direct';
    const store = new OxigraphStore();
    try {
      await seedDirectPublish(store, CG, `did:dkg:hardhat:31337/${ADDR}/3`, ['urn:note:1'], '0x' + '33'.repeat(32));
      // Multi-root: members also on <ual>/<n> dkg:partOf <ual> rows.
      await seedDirectPublish(store, CG, `did:dkg:hardhat:31337/${ADDR}/4`, ['urn:note:2', 'urn:note:3'], '0x' + '44'.repeat(32));
      const receipts = await load(store, CG);
      expect(receipts).toHaveLength(2);
      expect(entityReceiptOf(receiptForEntity(receipts, 'urn:note:1')!)).toMatchObject({
        status: 'verified', ual: `did:dkg:hardhat:31337/${ADDR}/3`, txHash: '0x' + '33'.repeat(32), kaId: '77', author: ADDR, finalizedAt: null,
      });
      expect(receiptForEntity(receipts, 'urn:note:3')).toMatchObject({ tx: '0x' + '44'.repeat(32), confirmation: 'transaction' });
      expect(receiptForEntity(receipts, 'urn:note:3')!.members.sort()).toEqual(['urn:note:2', 'urn:note:3']);
      // The VM header no longer calls them unanchored.
      const entity = (uri: string) => ({ uri, types: ['urn:t:Note'], properties: new Map(), connections: [] }) as any;
      const facts = vmFacts(['urn:note:1', 'urn:note:2', 'urn:note:3'].map(entity), summariseVmReceipts(receipts, true));
      expect(facts[0]).toMatchObject({ value: '3 / 3 anchored', tone: 'ok' });
    } finally { await store.close(); }
  });

  it('folds the collection record into the named receipt of the same publish', async () => {
    const CG = 'entity-both';
    const store = new OxigraphStore();
    try {
      const TX = '0x' + '55'.repeat(32);
      // Same publish: a named receipt (no lifecycle link) and the collection record with the same tx.
      const meta = contextGraphMetaUri(CG);
      const asrt = contextGraphAssertionUri(CG, ADDR, NAME);
      await store.insert(buildAssertionSealQuads({
        assertionUri: asrt, metaGraph: meta, merkleRoot: bytes(1), authorAddress: ADDR, authorAttestationR: bytes(2), authorAttestationVS: bytes(3),
        authorSchemeVersion: 1, chainId: 31337n, kav10Address: '0x' + 'cc'.repeat(20), reservedKaId: 8n, finalizedAtIso: FINALIZED, rootEntities: ['urn:note:9'],
      }));
      await store.insert(buildAssertionPublishReceiptQuads({ assertionUri: asrt, metaGraph: meta, txHash: TX, blockNumber: 60n }));
      await seedDirectPublish(store, CG, `did:dkg:hardhat:31337/${ADDR}/8`, ['urn:note:9'], TX);
      const receipts = await load(store, CG);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ assertion: asrt, ual: `did:dkg:hardhat:31337/${ADDR}/8`, tx: TX, members: ['urn:note:9'], finalizedAt: FINALIZED, batchId: '77' });
    } finally { await store.close(); }
  });

  it('links an old-store entity to its assertion through a share record, preferring the sub-graph it lives under', () => {
    const r = (assertion: string) => ({ assertion, tx: '0x1', confirmation: 'receipt', finalizedAt: null, members: [], signers: [] }) as VmReceipt;
    const rootA = r(`did:dkg:context-graph:cg/assertion/${ADDR}/note`);
    const subA = r(`did:dkg:context-graph:cg/demo/assertion/${ADDR}/note`);
    expect(receiptForShareSource([rootA, subA], `assertion/${ADDR}/note`, `${subA.assertion}/x`)).toBe(subA);
    expect(receiptForShareSource([subA, rootA], `assertion/${ADDR}/note`, `${rootA.assertion}/x`)).toBe(rootA);
    expect(receiptForShareSource([rootA], 'not-a-source', 'urn:x')).toBeNull();
    expect(buildShareQuery('cg', 'urn:entity:1')).toContain('dkg:entities <urn:entity:1>');
    expect(() => buildShareQuery('cg', 'urn:bad> }')).toThrow();
  });
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class StubEventSource { addEventListener() {} close() {} onerror: (() => void) | null = null; }

describe('useEntityOnChainReceipt', () => {
  let root: Root;
  let container: HTMLDivElement;
  let originalFetch: typeof globalThis.fetch | undefined;
  const A = `did:dkg:context-graph:cg/assertion/${ADDR}/note`;
  beforeEach(() => {
    vi.stubGlobal('EventSource', StubEventSource);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = globalThis.fetch;
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    if (originalFetch) globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });
  /** Receipts read answers `receiptRows`; the share query answers `shareRows`. */
  const respond = (receiptRows: unknown[], shareRows: unknown[] = []) => {
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      const sparql = String(JSON.parse(String(init?.body ?? '{}')).sparql ?? '');
      const bindings = sparql.includes('ShareTransition') ? shareRows : receiptRows;
      return new Response(JSON.stringify({ result: { bindings } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
  };
  async function render(entity: string | null, enabled = true): Promise<EntityOnChainReceipt> {
    let seen!: EntityOnChainReceipt;
    function Card() { seen = useEntityOnChainReceipt('cg', entity, enabled); return null; }
    function Owner() { return React.createElement(VmReceiptsProvider, { value: useVmReceiptsResource('cg') }, React.createElement(Card)); }
    await act(async () => { root.render(React.createElement(Owner)); });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return seen;
  }

  it('reads the entity receipt from the shared graph load', async () => {
    respond([{ asrt: A, tx: '0x9f', block: '"42"', sealRoot: '"aa"', member: 'urn:x:a', agent: `did:dkg:agent:${ADDR}`, finalizedAt: `"${FINALIZED}"` }]);
    expect(await render('urn:x:a')).toMatchObject({ status: 'verified', txHash: '0x9f', blockNumber: '42', author: ADDR, finalizedAt: FINALIZED, agent: `did:dkg:agent:${ADDR}` });
    // Only the graph-wide receipt read ran: no per-entity receipt query.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('falls back to an old-store share record for which assertion, and reports off-chain without one', async () => {
    respond([{ asrt: A, tx: '0x9f', sealRoot: '"aa"' }], [{ source: `"assertion/${ADDR}/note"`, agent: 'did:dkg:agent:0xshare' }]);
    expect(await render('urn:x:legacy')).toMatchObject({ status: 'verified', txHash: '0x9f', author: ADDR });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    respond([{ asrt: A, tx: '0x9f', sealRoot: '"aa"' }], []);
    expect(await render('urn:x:draft')).toMatchObject({ status: 'offchain', txHash: null });
  });

  it('is idle when disabled or without an entity, and reports read errors distinctly', async () => {
    respond([]);
    expect((await render(null)).status).toBe('idle');
    expect((await render('urn:x:a', false)).status).toBe('idle');
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as any;
    expect((await render('urn:x:a')).status).toBe('error');
  });
});
