// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { assertionLifecycleUri, contextGraphMetaUri, generateEd25519Keypair, TypedEventBus } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';

const cg = 'reserved-create';
const author = `0x${'11'.repeat(20)}`;
const name = 'asset';
async function fixture() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({ store, chain: new MockChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
  return { store, publisher, snapshot: () => store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o') };
}
const allocation = (number: bigint) => vi.fn(async () => ({ number, reservedUal: `did:dkg:31337/${author}/${number}` }));

describe('locked create reservation validation', () => {
  it('rejects a fresh allocator mismatch before writing metadata or content', async () => {
    const { publisher, snapshot } = await fixture();
    const before = await snapshot();
    await expect(publisher.assertionCreate(cg, name, author, undefined, {
      expectedKaNumber: 8n, allocateKaNumber: allocation(7n),
    })).rejects.toMatchObject({ code: 'KA_RESERVED_ID_MISMATCH' });
    expect(await snapshot()).toEqual(before);
  });

  it('preserves an existing zero slot and rejects another reservation before allocation', async () => {
    const { publisher, snapshot } = await fixture();
    const graph = await publisher.assertionCreate(cg, name, author, undefined, { allocateKaNumber: allocation(0n), expectedKaNumber: 0n });
    const before = await snapshot();
    const allocateKaNumber = allocation(1n);
    await expect(publisher.assertionCreate(cg, name, author, undefined, { allocateKaNumber, expectedKaNumber: 1n }))
      .rejects.toMatchObject({ code: 'KA_RESERVED_ID_MISMATCH' });
    expect(allocateKaNumber).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    await expect(publisher.assertionCreate(cg, name, author, undefined, { expectedKaNumber: 0n })).resolves.toBe(graph);
  });

  it.each(['missing', 'multiple', 'malformed', 'wrong-type'] as const)('preserves a %s persisted identity instead of replacing it', async (condition) => {
    const { publisher, store, snapshot } = await fixture();
    await publisher.assertionCreate(cg, name, author, undefined, { allocateKaNumber: allocation(7n) });
    const coordinate = { graph: contextGraphMetaUri(cg), subject: assertionLifecycleUri(cg, author, name), predicate: 'http://dkg.io/ontology/kaId' };
    if (condition !== 'multiple') await store.deleteByPattern(coordinate);
    if (condition !== 'missing') await store.insert([{ ...coordinate, object: condition === 'multiple' ? '"8"' : condition === 'malformed' ? '"invalid"' : '"7"@en' }]);
    const before = await snapshot();
    await expect(publisher.assertionCreate(cg, name, author, undefined, { expectedKaNumber: 7n }))
      .rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_CORRUPT' });
    expect(await snapshot()).toEqual(before);
  });

  it('fails closed when the identity read is not a binding result', async () => {
    const { publisher, store } = await fixture();
    vi.spyOn(store, 'query').mockResolvedValue({ type: 'boolean', value: false });
    const insert = vi.spyOn(store, 'insert');
    await expect(publisher.assertionCreate(cg, name, author, undefined, { expectedKaNumber: 7n }))
      .rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_CORRUPT' });
    expect(insert).not.toHaveBeenCalled();
  });
});
