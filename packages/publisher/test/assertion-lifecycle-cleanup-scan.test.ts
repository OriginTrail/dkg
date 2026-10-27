import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { assertionLifecycleUri, contextGraphMetaUri, generateEd25519Keypair, TypedEventBus } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';

const CG = 'cleanup-scan';
const AUTHOR = '0xa32f1cc125401b55911678847426759094055b2d';
const META = contextGraphMetaUri(CG);
const ROOT = assertionLifecycleUri(CG, AUTHOR, 'asset');

describe('assertion lifecycle cleanup', () => {
  it.each([false, true])('removes even unlinked stale subjects, preserves other assets and KA identity (existing=%s)', async (existing) => {
    const store = new OxigraphStore();
    const publisher = new DKGPublisher({ store, chain: new MockChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
    const allocation = { allocateKaNumber: vi.fn(async () => ({ number: 7n, reservedUal: `did:dkg:none/${AUTHOR}/7` })) };
    if (existing) await publisher.assertionCreate(CG, 'asset', AUTHOR, undefined, allocation);
    const stale = [`${ROOT}/event/stale`, `${ROOT}/legacy/unlinked`];
    const untouched = [`${ROOT}-other/event/stale`, `${ROOT}ish`, 'urn:unrelated'];
    await store.insert([...stale, ...untouched].flatMap(subject => Array.from({ length: 12 }, (_, i) => ({
      subject, predicate: `urn:property:${i}`, object: '"retained-or-removed"', graph: META,
    }))));
    // The same subject in a different graph is outside the cleanup's authority.
    await store.insert([{ subject: stale[0], predicate: 'urn:property:0', object: '"other-graph"', graph: 'urn:other-meta' }]);
    const query = vi.spyOn(store, 'query');
    await publisher.assertionCreate(CG, 'asset', AUTHOR, undefined, allocation);
    expect(allocation.allocateKaNumber).toHaveBeenCalledTimes(1);
    for (const subject of stale) expect(await store.query(`ASK { GRAPH <${META}> { <${subject}> ?p ?o } }`)).toEqual({ type: 'boolean', value: false });
    const remaining = await store.query(`SELECT ?s WHERE { GRAPH <${META}> { ?s <urn:property:0> ?o } }`);
    expect(remaining.type).toBe('bindings');
    if (remaining.type === 'bindings') expect(remaining.bindings.map(row => row.s).sort()).toEqual([...untouched].sort());
    expect(await store.query('ASK { GRAPH <urn:other-meta> { ?s ?p ?o } }')).toEqual({ type: 'boolean', value: true });
    expect(await store.query(`ASK { GRAPH <${META}> { <${ROOT}> <http://dkg.io/ontology/kaId> ?id } }`)).toEqual({ type: 'boolean', value: true });
    const cleanup = query.mock.calls.find(([sparql]) => sparql.includes('STRSTARTS(STR(?s),') && sparql.includes(ROOT));
    expect(cleanup).toBeDefined();
    // A bare DISTINCT subject subquery admits the store's subject-index scan.
    // Filtering inside that subquery would require visiting every statement.
    expect(cleanup![0]).toMatch(/\{\s*SELECT DISTINCT \?s WHERE \{ GRAPH <[^>]+> \{ \?s \?p \?o \} \}\s*\}\s*FILTER/);
    expect(cleanup![0]).not.toMatch(/LIMIT|OFFSET/);
    expect(cleanup![1]?.source).toBe('publisher.assertionCreate.staleLifecycleSubjects');
    await store.close();
  });
});
