import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, assertionLifecycleUri, contextGraphMetaUri, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';

const CG = 'wm-integrity';
const NAME = 'draft';
const AGENT = `0x${'11'.repeat(20)}`;
const DKG = 'http://dkg.io/ontology/';

async function fixture() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store, chain: new MockChainAdapter(), eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  await publisher.assertionCreate(CG, NAME, AGENT);
  return { store, publisher };
}

describe('Working Memory lifecycle integrity', () => {
  it.each([
    ['state', 'promoted'],
    ['memoryLayer', 'SWM'],
  ])('rejects duplicate %s rows as store damage without mutating the draft', async (predicate, value) => {
    const { store, publisher } = await fixture();
    await store.insert([{
      subject: assertionLifecycleUri(CG, AGENT, NAME), predicate: `${DKG}${predicate}`,
      object: `"${value}"`, graph: contextGraphMetaUri(CG),
    }]);
    await expect(publisher.assertionWrite(CG, NAME, AGENT, [{
      subject: 'urn:test:entity', predicate: 'http://schema.org/name', object: '"Rejected"',
    }])).rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_CORRUPT' });
    await expect(publisher.assertionDiscard(CG, NAME, AGENT)).rejects.toMatchObject({
      code: 'KA_WM_LIFECYCLE_CORRUPT',
    });
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([]);
    const rows = await store.query(`SELECT ?o WHERE { GRAPH <${contextGraphMetaUri(CG)}> {
      <${assertionLifecycleUri(CG, AGENT, NAME)}> <${DKG}${predicate}> ?o
    } }`);
    expect(rows.type === 'bindings' && rows.bindings).toHaveLength(2);
  });

  it.each(['state', 'layer'])('rejects a non-bindings %s query as store damage', async (variable) => {
    const { store, publisher } = await fixture();
    const query = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (sparql, ...args) => {
      if (sparql.includes(`SELECT ?${variable} WHERE`)) return { type: 'boolean', value: false };
      return query(sparql, ...args);
    });
    await expect(publisher.assertionDiscard(CG, NAME, AGENT)).rejects.toMatchObject({
      code: 'KA_WM_LIFECYCLE_CORRUPT',
    });
  });

  it('keeps a missing lifecycle row as a caller precondition', async () => {
    const { store, publisher } = await fixture();
    await store.deleteByPattern({
      subject: assertionLifecycleUri(CG, AGENT, NAME), predicate: `${DKG}state`,
      graph: contextGraphMetaUri(CG),
    });
    await expect(publisher.assertionDiscard(CG, NAME, AGENT)).rejects.toMatchObject({
      code: 'KA_WM_LIFECYCLE_REQUIRED',
    });
  });
});
