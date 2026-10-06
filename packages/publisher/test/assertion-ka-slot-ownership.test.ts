import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, contextGraphMetaUri, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';

const CG = 'reserved-slot-ownership';
const AUTHOR = '0xa32f1cc125401b55911678847426759094055b2d';
const allocation = { allocateKaNumber: async () => ({ number: 7n, reservedUal: `did:dkg:none/${AUTHOR}/7` }) };

async function publisher(store = new OxigraphStore()) {
  return new DKGPublisher({ store, chain: new MockChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
}

async function registerSubgraph(store: OxigraphStore, name: string) {
  const subject = `did:dkg:context-graph:${CG}/${name}`;
  await store.insert([
    { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: contextGraphMetaUri(CG) },
    { subject, predicate: 'http://schema.org/name', object: `"${name}"`, graph: contextGraphMetaUri(CG) },
    { subject, predicate: 'http://dkg.io/ontology/createdBy', object: 'did:dkg:agent:test-agent', graph: contextGraphMetaUri(CG) },
  ]);
}

describe('persistent KA slot ownership', () => {
  it('rejects another name without changing the owning draft and allows an owner retry/reopen', async () => {
    const store = new OxigraphStore();
    const p = await publisher(store);
    const graph = await p.assertionCreate(CG, 'owner', AUTHOR, undefined, allocation);
    await p.assertionWrite(CG, 'owner', AUTHOR, [{ subject: 'urn:owner', predicate: 'urn:value', object: '"retained"' }]);
    const before = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${contextGraphMetaUri(CG)}> { ?s ?p ?o } }`);
    await expect(p.assertionCreate(CG, 'other', AUTHOR, undefined, allocation))
      .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
    expect(await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${contextGraphMetaUri(CG)}> { ?s ?p ?o } }`)).toEqual(before);
    expect(await p.assertionCreate(CG, 'owner', AUTHOR, undefined, allocation)).toBe(graph);
    await p.assertionDiscard(CG, 'owner', AUTHOR);
    expect(await p.assertionCreate(CG, 'owner', AUTHOR, undefined, allocation)).toBe(graph);
    await expect(p.assertionCreate(CG, 'other', AUTHOR, undefined, allocation))
      .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
  });

  it('serializes simultaneous claims across publishers sharing the same store', async () => {
    const store = new OxigraphStore();
    const [a, b] = await Promise.all([publisher(store), publisher(store)]);
    const results = await Promise.allSettled([
      a.assertionCreate(CG, 'a', AUTHOR, undefined, allocation),
      b.assertionCreate(CG, 'b', AUTHOR, undefined, allocation),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'KA_SLOT_ALREADY_CLAIMED' }) }),
    ]);
    expect(a.writeLocks.size).toBe(0);
  });

  it('checks durable ownership after creating a new publisher and normalizes address casing', async () => {
    const store = new OxigraphStore();
    await (await publisher(store)).assertionCreate(CG, 'owner', AUTHOR, undefined, allocation);
    await expect((await publisher(store)).assertionCreate(CG, 'other', '0xA32f1cc125401B55911678847426759094055B2d', undefined, allocation))
      .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
  });

  it('keeps root author and address-shaped subgraph coordinates distinct', async () => {
    const store = new OxigraphStore();
    const p = await publisher(store);
    const otherAuthor = `0x${'bb'.repeat(20)}`;
    await registerSubgraph(store, AUTHOR);
    const nested = await p.assertionCreate(CG, 'nested', otherAuthor, AUTHOR, allocation);
    const root = await p.assertionCreate(CG, 'root', AUTHOR, undefined, allocation);
    expect(root).not.toBe(nested);
    await expect(p.assertionCreate(CG, 'another-root', AUTHOR, undefined, allocation))
      .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
    await expect(p.assertionCreate(CG, 'another-nested', otherAuthor, AUTHOR, allocation))
      .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
  });

  it('preserves case-sensitive subgraph names for the same author and KA number', async () => {
    const store = new OxigraphStore();
    const p = await publisher(store);
    for (const subgraph of ['Team', 'team']) await registerSubgraph(store, subgraph);
    const upper = await p.assertionCreate(CG, 'upper', AUTHOR, 'Team', allocation);
    const lower = await p.assertionCreate(CG, 'lower', AUTHOR, 'team', allocation);
    expect(upper).not.toBe(lower);
    await expect(p.assertionCreate(CG, 'other', AUTHOR, 'team', allocation))
      .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
  });

  it('fails closed when the ownership query cannot return bindings', async () => {
    const store = new OxigraphStore();
    const p = await publisher(store);
    const query = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation((sparql, ...args) => sparql.includes('SELECT ?owner WHERE')
      ? Promise.resolve({ type: 'boolean', value: false }) : query(sparql, ...args));
    await expect(p.assertionCreate(CG, 'owner', AUTHOR, undefined, allocation))
      .rejects.toMatchObject({ code: 'KA_SLOT_OWNERSHIP_UNAVAILABLE' });
    expect(await store.countQuads(contextGraphMetaUri(CG))).toBe(0);
  });
});
