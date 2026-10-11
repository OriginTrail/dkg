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

  it('reuses one decoded lifecycle record when reopening a reserved draft', async () => {
    const { publisher, store } = await fixture();
    const graph = await publisher.assertionCreate(cg, name, author, undefined, { allocateKaNumber: allocation(7n), expectedKaNumber: 7n });
    const query = vi.spyOn(store, 'query');
    await expect(publisher.assertionCreate(cg, name, author, undefined, { expectedKaNumber: 7n })).resolves.toBe(graph);
    const identityReads = query.mock.calls.filter(([q]) => q.includes('SELECT ?p ?o') && q.includes(assertionLifecycleUri(cg, author, name)));
    expect(identityReads).toHaveLength(1);
  });

  it('keeps the explicit legacy numeric policy for creates without a reservation', async () => {
    const { publisher, store } = await fixture();
    const graph = await publisher.assertionCreate(cg, name, author, undefined, { allocateKaNumber: allocation(7n) });
    const coordinate = { graph: contextGraphMetaUri(cg), subject: assertionLifecycleUri(cg, author, name), predicate: 'http://dkg.io/ontology/kaId' };
    await store.deleteByPattern(coordinate);
    await store.insert([{ ...coordinate, object: '"legacy-slot-7"' }]);
    await expect(publisher.assertionCreate(cg, name, author)).resolves.toBe(graph);
    await expect(publisher.wmGraphUri(cg, author, name)).resolves.toBe(graph);
  });

  it.each(['missing', 'multiple', 'malformed', 'wrong-type', 'too-large'] as const)('preserves a %s persisted identity instead of replacing it', async (condition) => {
    const { publisher, store, snapshot } = await fixture();
    await publisher.assertionCreate(cg, name, author, undefined, { allocateKaNumber: allocation(7n) });
    const coordinate = { graph: contextGraphMetaUri(cg), subject: assertionLifecycleUri(cg, author, name), predicate: 'http://dkg.io/ontology/kaId' };
    if (condition !== 'multiple') await store.deleteByPattern(coordinate);
    if (condition !== 'missing') await store.insert([{ ...coordinate, object: condition === 'multiple' ? '"8"' : condition === 'malformed' ? '"invalid"' : condition === 'too-large' ? '"79228162514264337593543950336"' : '"7"@en' }]);
    const before = await snapshot();
    await expect(publisher.assertionCreate(cg, name, author, undefined, { expectedKaNumber: 7n }))
      .rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_CORRUPT' });
    expect(await snapshot()).toEqual(before);
  });

  it.each([{ type: 'boolean' as const, value: false }, { type: 'bindings' as const, bindings: [{ p: 'urn:missing-object' }] }])('fails closed on unreadable identity records: %j', async (result) => {
    const { publisher, store } = await fixture();
    vi.spyOn(store, 'query').mockResolvedValue(result);
    const insert = vi.spyOn(store, 'insert');
    await expect(publisher.assertionCreate(cg, name, author, undefined, { expectedKaNumber: 7n }))
      .rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_CORRUPT' });
    expect(insert).not.toHaveBeenCalled();
  });
});
