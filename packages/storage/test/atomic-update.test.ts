// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangelogStore, GraphSetIndexStore, OxigraphStore, OxigraphWorkerStore,
  SharedMemoryLiteralBlobStore, SparqlHttpStore, UnsupportedTripleStoreCapabilityError,
  createTripleStore, type TripleStore } from '../src/index.js';

const GRAPH = 'urn:atomic:metadata';
const insert = `INSERT DATA { GRAPH <${GRAPH}> { <urn:a> <urn:p> "new" . <urn:b> <urn:p> "new" } }`;
const replace = `DELETE WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } }; ${insert}`;
const stores: TripleStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });

describe('explicit whole-request atomic UPDATE capability', () => {
  it.each(['embedded', 'worker'] as const)('rolls back the complete %s transaction on a later statement execution failure', async backend => {
    const store = backend === 'embedded' ? new OxigraphStore() : new OxigraphWorkerStore(); stores.push(store);
    await store.insert([{ subject: 'urn:old', predicate: 'urn:p', object: '"old"', graph: GRAPH }]);
    const snapshot = () => store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } } ORDER BY ?s`);
    const before = await snapshot();
    // Valid UPDATE grammar; LOAD fails during execution after DELETE/INSERT are evaluated.
    await expect(store.atomicUpdate(`${replace}; LOAD <file:///nonexistent-atomic-update-20261004>`)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await store.atomicUpdate(replace);
    expect(await store.countQuads(GRAPH)).toBe(2);
  });

  it('refuses uncertified HTTP endpoints before making a request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const store = new SparqlHttpStore({ queryEndpoint: 'http://example.test/sparql' }); stores.push(store);
    await expect(store.atomicUpdate(replace)).rejects.toMatchObject({ capability: 'atomicUpdate', outcome: 'not_started' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['atomic-update', 'atomic-readback'] as const)('sends one request for an explicitly %s HTTP endpoint', async consistencyProfile => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const store = new SparqlHttpStore({ queryEndpoint: 'http://example.test/sparql', consistencyProfile }); stores.push(store);
    await store.atomicUpdate(replace);
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0]?.[1]?.body).toBe(replace);
  });

  it('preserves explicit acknowledgement durability in direct and factory construction', async () => {
    const direct = new SparqlHttpStore({ queryEndpoint: 'http://example.test/sparql', writesDurableOnAcknowledgement: true }); stores.push(direct);
    const factory = await createTripleStore({ backend: 'sparql-http', options: { queryEndpoint: 'http://example.test/sparql', writesDurableOnAcknowledgement: true } }); stores.push(factory);
    expect(direct.commitment?.durability).toBe('restart-durable'); expect(factory.commitment?.durability).toBe('restart-durable');
    expect(() => new SparqlHttpStore({ queryEndpoint: 'http://example.test/sparql', writesDurableOnAcknowledgement: 'true' as unknown as boolean })).toThrow('must be boolean');
    expect(() => new SparqlHttpStore({ queryEndpoint: 'http://example.test/sparql', consistencyProfile: 'unsupported' as never })).toThrow('consistencyProfile must be');
  });

  it('preserves transaction rollback through production decorators', async () => {
    const base = new OxigraphStore();
    const blobs = new SharedMemoryLiteralBlobStore(base, { blobDir: '/tmp/dkg-atomic-unused-blobs', thresholdBytes: 65_536 });
    const indexed = new GraphSetIndexStore(blobs), store = new ChangelogStore(indexed); stores.push(store);
    await store.atomicUpdate(insert, { touchedGraphs: [GRAPH] });
    expect(await store.hasGraph(GRAPH)).toBe(true);
    await expect(store.atomicUpdate(`DELETE WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } }; LOAD <file:///nonexistent-atomic-update-20261004>`, { touchedGraphs: [GRAPH] })).rejects.toThrow();
    expect(await store.countQuads(GRAPH)).toBe(2); expect(await store.hasGraph(GRAPH)).toBe(true);
  });

  it.each(['changelog', 'graph-index', 'literal-blob'] as const)('refuses a generic-update-only backend before mutation through %s', async decorator => {
    const base = new OxigraphStore(); stores.push(base);
    Object.defineProperty(base, 'atomicUpdate', { value: undefined });
    const update = vi.spyOn(base, 'update');
    const store = decorator === 'changelog' ? new ChangelogStore(base) : decorator === 'graph-index'
      ? new GraphSetIndexStore(base) : new SharedMemoryLiteralBlobStore(base, { blobDir: '/tmp/dkg-atomic-unused-blobs', thresholdBytes: 65_536 });
    await expect(store.atomicUpdate(insert)).rejects.toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
    await expect(store.atomicUpdate(insert)).rejects.toMatchObject({ capability: 'atomicUpdate', outcome: 'not_started' });
    expect(update).not.toHaveBeenCalled();
    expect(await base.countQuads()).toBe(0);
  });
});
