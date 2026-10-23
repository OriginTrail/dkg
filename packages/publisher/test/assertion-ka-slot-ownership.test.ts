import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, assertionLifecycleUri, contextGraphMetaUri, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { assertKaSlotOwnershipAvailable, withAssertionAllocation } from '../src/assertion-ka-slot-ownership.js';

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
  it.each([undefined, 'invalid', `did:dkg:none/0x${'bb'.repeat(20)}/8`])(
    'uses the ordinary fallback policy for a fresh allocation UAL %s', async reservedUal => {
      const store = new OxigraphStore(), p = await publisher(store);
      const graph = await p.assertionCreate(CG, 'fresh-owner', AUTHOR, undefined,
        { allocateKaNumber: async () => ({ number: 7n, reservedUal }) });
      expect(await p.wmGraphUri(CG, AUTHOR, 'fresh-owner')).toBe(graph);
      await p.assertionWrite(CG, 'fresh-owner', AUTHOR, [{ subject: 'urn:fresh', predicate: 'urn:value', object: '"retained"' }]);
      await expect(p.assertionCreate(CG, 'impostor', 'another-peer', undefined, allocation))
        .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
      expect((await p.assertionQuery(CG, 'fresh-owner', AUTHOR)).map(q => q.object)).toEqual(['"retained"']);
      await store.close();
    },
  );
  it('fences the explicit physical identity before entering the allocation mutation', async () => {
    const store = new OxigraphStore(), p = await publisher(store);
    await p.assertionCreate(CG, 'owner', 'owning-peer', undefined, allocation);
    const mutate = vi.fn(async () => 'unexpected mutation');
    await expect(withAssertionAllocation(store, { contextGraphId: CG, lifecycleOwner: 'different-peer', name: 'impostor' },
      { agentAddress: AUTHOR, number: 7n }, mutate)).rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
    expect(mutate).not.toHaveBeenCalled(); await store.close();
  });
  it.each(['missing-name', 'wrong-owner', 'conflicting-uals'])(
    'refuses ambiguous reservation identity before changing any graph: %s', async kind => {
      const store = new OxigraphStore(), p = await publisher(store), graph = contextGraphMetaUri(CG);
      const subject = assertionLifecycleUri(CG, AUTHOR, 'owner');
      await store.insert([
        { subject, graph, predicate: 'http://dkg.io/ontology/kaId', object: '"7"' },
        ...(kind === 'missing-name' ? [] : [{ subject, graph, predicate: 'http://dkg.io/ontology/assertionName', object: '"owner"' }]),
        { subject, graph, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo',
          object: `did:dkg:agent:${kind === 'wrong-owner' ? 'another-peer' : AUTHOR}` },
        { subject, graph, predicate: 'http://dkg.io/ontology/reservedUal', object: JSON.stringify(kind === 'conflicting-uals' ? `did:dkg:none/${AUTHOR}/7` : 'invalid') },
        ...(kind === 'conflicting-uals' ? [{ subject, graph, predicate: 'http://dkg.io/ontology/reservedUal', object: `"did:dkg:none/0x${'bb'.repeat(20)}/7"` }] : []),
      ]);
      const snapshot = await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
      await expect(p.assertionCreate(CG, 'impostor', AUTHOR, undefined, allocation))
        .rejects.toMatchObject({ code: 'KA_SLOT_OWNERSHIP_UNAVAILABLE' });
      expect(await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o')).toEqual(snapshot);
      await store.close();
    },
  );

  it('checks every candidate at the number after a different wallet is skipped', async () => {
    const store = new OxigraphStore(), p = await publisher(store), otherWallet = `0x${'bb'.repeat(20)}`;
    await p.assertionCreate(CG, 'other-wallet', 'peer-one', undefined,
      { allocateKaNumber: async () => ({ number: 7n, reservedUal: `did:dkg:none/${otherWallet}/7` }) });
    await p.assertionCreate(CG, 'actual-wallet', 'peer-two', undefined, allocation);
    await expect(p.assertionCreate(CG, 'impostor', 'peer-three', undefined, allocation))
      .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
    await store.close();
  });

  it.each(['invalid', `did:dkg:none/0x${'bb'.repeat(20)}/8`])(
    'protects the actual fallback graph when the retained UAL is unusable: %s', async retained => {
      const store = new OxigraphStore(), p = await publisher(store);
      const graph = await p.assertionCreate(CG, 'owner', AUTHOR, undefined, allocation);
      const subject = assertionLifecycleUri(CG, AUTHOR, 'owner'), meta = contextGraphMetaUri(CG);
      await store.deleteByPattern({ graph: meta, subject, predicate: 'http://dkg.io/ontology/reservedUal' });
      await store.insert([{ graph: meta, subject, predicate: 'http://dkg.io/ontology/reservedUal', object: JSON.stringify(retained) }]);
      await p.assertionWrite(CG, 'owner', AUTHOR, [{ subject: 'urn:owner', predicate: 'urn:value', object: '"keep"' }]);
      expect(await p.wmGraphUri(CG, AUTHOR, 'owner')).toBe(graph);
      await expect(p.assertionCreate(CG, 'impostor', AUTHOR, undefined, allocation))
        .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
      expect((await p.assertionQuery(CG, 'owner', AUTHOR)).map(q => q.object)).toEqual(['"keep"']);
      await store.close();
    },
  );

  it('does not confuse a malformed-UAL fallback with an unrelated wallet', async () => {
    const store = new OxigraphStore(), p = await publisher(store), otherWallet = `0x${'bb'.repeat(20)}`;
    await p.assertionCreate(CG, 'owner', AUTHOR, undefined, allocation);
    const subject = assertionLifecycleUri(CG, AUTHOR, 'owner'), graph = contextGraphMetaUri(CG);
    await store.deleteByPattern({ graph, subject, predicate: 'http://dkg.io/ontology/reservedUal' });
    await store.insert([{ graph, subject, predicate: 'http://dkg.io/ontology/reservedUal', object: JSON.stringify(`did:dkg:none/${otherWallet}/8`) }]);
    await expect(p.assertionCreate(CG, 'other', 'peer-other', undefined,
      { allocateKaNumber: async () => ({ number: 7n, reservedUal: `did:dkg:none/${otherWallet}/7` }) })).resolves.toBeTypeOf('string');
    await store.close();
  });

  it('keeps two wallet-authored assets under one peer owner in distinct writable graphs', async () => {
    const store = new OxigraphStore(), p = await publisher(store), peer = 'peer-owner';
    const otherWallet = `0x${'bb'.repeat(20)}`;
    const first = await p.assertionCreate(CG, 'wallet-one', peer, undefined, allocation);
    const second = await p.assertionCreate(CG, 'wallet-two', peer, undefined,
      { allocateKaNumber: async () => ({ number: 7n, reservedUal: `did:dkg:none/${otherWallet}/7` }) });
    expect(first).not.toBe(second);
    expect(await p.wmGraphUri(CG, peer, 'wallet-one')).toBe(first);
    expect(await p.wmGraphUri(CG, peer, 'wallet-two')).toBe(second);
    for (const [name, graph] of [['wallet-one', first], ['wallet-two', second]]) {
      expect(await store.query(`SELECT ?graph WHERE { GRAPH <${contextGraphMetaUri(CG)}> {
        <${assertionLifecycleUri(CG, peer, name)}> <http://dkg.io/ontology/assertionGraph> ?graph
      } }`)).toMatchObject({ bindings: [{ graph }] });
    }
    for (const name of ['wallet-one', 'wallet-two']) await p.assertionWrite(CG, name, peer,
      [{ subject: 'urn:owner', predicate: 'urn:value', object: JSON.stringify(name) }]);
    expect((await p.assertionQuery(CG, 'wallet-one', peer)).map(q => q.object)).toEqual(['"wallet-one"']);
    expect((await p.assertionQuery(CG, 'wallet-two', peer)).map(q => q.object)).toEqual(['"wallet-two"']);
    await store.close();
  });

  it('rejects two different lifecycle owners claiming the same wallet-authored physical slot', async () => {
    const store = new OxigraphStore(), p = await publisher(store);
    await p.assertionCreate(CG, 'first', 'peer-one', undefined, allocation);
    await expect(p.assertionCreate(CG, 'second', 'peer-two', undefined, allocation))
      .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
    await store.close();
  });

  it('serializes a shared physical slot across different peer owners and publisher instances', async () => {
    const store = new OxigraphStore(), [a, b] = await Promise.all([publisher(store), publisher(store)]);
    const result = await Promise.allSettled([
      a.assertionCreate(CG, 'first', 'peer-one', undefined, allocation),
      b.assertionCreate(CG, 'second', 'peer-two', undefined, allocation),
    ]);
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(value => value.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'KA_SLOT_ALREADY_CLAIMED' }) }),
    ]);
    expect(a.writeLocks.size).toBe(0); await store.close();
  });

  it('does not nest crossed lifecycle-owner and wallet allocation locks', async () => {
    const store = new OxigraphStore(), p = await publisher(store), otherWallet = `0x${'bb'.repeat(20)}`;
    const result = await Promise.all([
      p.assertionCreate(CG, 'cross-one', otherWallet, undefined, allocation),
      p.assertionCreate(CG, 'cross-two', AUTHOR, undefined,
        { allocateKaNumber: async () => ({ number: 7n, reservedUal: `did:dkg:none/${otherWallet}/7` }) }),
    ]);
    expect(result[0]).not.toBe(result[1]); expect(p.writeLocks.size).toBe(0); await store.close();
  }, 5_000);

  it.each([undefined, `"  did:dkg:none/${AUTHOR.toUpperCase().replace('0X', '0x')}/0007  "`, `"\u00a0did:dkg:none/${AUTHOR}/7\u00a0"`])(
    'protects legacy missing-UAL and normalized reserved-UAL records: %s', async reservedUal => {
      const store = new OxigraphStore(), p = await publisher(store), graph = contextGraphMetaUri(CG);
      const subject = assertionLifecycleUri(CG, reservedUal ? 'old-peer' : AUTHOR, 'owner');
      await store.insert([
        { subject, graph, predicate: 'http://dkg.io/ontology/kaId', object: '"7"' },
        { subject, graph, predicate: 'http://dkg.io/ontology/assertionName', object: '"owner"' },
        { subject, graph, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: reservedUal ? 'did:dkg:agent:old-peer' : `did:dkg:agent:${AUTHOR}` },
        ...(reservedUal ? [{ subject, graph, predicate: 'http://dkg.io/ontology/reservedUal', object: reservedUal }] : []),
      ]);
      await expect(p.assertionCreate(CG, 'new-peer', 'peer-two', undefined, allocation))
        .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
      await store.close();
    },
  );

  it('keeps different physical numbers under one wallet independent across peer owners', async () => {
    const store = new OxigraphStore(), p = await publisher(store);
    await p.assertionCreate(CG, 'first', 'peer-one', undefined, allocation);
    await expect(p.assertionCreate(CG, 'second', 'peer-two', undefined,
      { allocateKaNumber: async () => ({ number: 8n, reservedUal: `did:dkg:none/${AUTHOR}/8` }) })).resolves.toBeTypeOf('string');
    await store.close();
  });

  it('keeps case-sensitive legacy peer graph slots separate when no wallet UAL exists', async () => {
    const store = new OxigraphStore(), graph = contextGraphMetaUri(CG);
    const subject = assertionLifecycleUri(CG, 'PeerOwner', 'first');
    await store.insert([
      { subject, graph, predicate: 'http://dkg.io/ontology/kaId', object: '"7"' },
      { subject, graph, predicate: 'http://dkg.io/ontology/assertionName', object: '"first"' },
      { subject, graph, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: 'did:dkg:agent:PeerOwner' },
    ]);
    await expect(assertKaSlotOwnershipAvailable(store, { contextGraphId: CG, lifecycleOwner: 'PeerOwner', name: 'other' }, { agentAddress: 'PeerOwner', number: 7n }))
      .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
    await expect(assertKaSlotOwnershipAvailable(store, { contextGraphId: CG, lifecycleOwner: 'peerowner', name: 'other' }, { agentAddress: 'peerowner', number: 7n })).resolves.toBeUndefined();
    await store.close();
  });

  it('rejects another name without changing the owning draft and allows an owner retry/reopen', async () => {
    const store = new OxigraphStore();
    const p = await publisher(store);
    const graph = await p.assertionCreate(CG, 'owner', AUTHOR, undefined, allocation);
    await p.assertionWrite(CG, 'owner', AUTHOR, [{ subject: 'urn:owner', predicate: 'urn:value', object: '"retained"' }]);
    const before = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${contextGraphMetaUri(CG)}> { ?s ?p ?o } }`);
    const contentBefore = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    expect(contentBefore).toMatchObject({ type: 'quads', quads: expect.arrayContaining([expect.objectContaining({ object: '"retained"' })]) });
    await expect(p.assertionCreate(CG, 'other', AUTHOR, undefined, allocation))
      .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
    expect(await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${contextGraphMetaUri(CG)}> { ?s ?p ?o } }`)).toEqual(before);
    expect(await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`)).toEqual(contentBefore);
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
    vi.spyOn(store, 'query').mockImplementation((sparql, ...args) => args[0]?.source === 'publisher.assertion.slotOwnership'
      ? Promise.resolve({ type: 'boolean', value: false }) : query(sparql, ...args));
    await expect(p.assertionCreate(CG, 'owner', AUTHOR, undefined, allocation))
      .rejects.toMatchObject({ code: 'KA_SLOT_OWNERSHIP_UNAVAILABLE' });
    expect(await store.countQuads(contextGraphMetaUri(CG))).toBe(0);
  });
});
