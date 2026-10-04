// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { isPublishedAssertionOwner, readPublishedAssertionOperation } from '../src/published-assertion-owner.js';

const GRAPH = 'urn:owner-meta', LIFECYCLE = 'urn:named-assertion', DKG = 'http://dkg.io/ontology/';
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });
const row = (subject: string, predicate: string, object: string): Quad => ({ subject, predicate, object, graph: GRAPH });
const event = (id: string, operation: string, time: string | null): Quad[] => [
  row(id, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${DKG}AssertionPromoted`),
  row(id, 'http://www.w3.org/ns/prov#used', LIFECYCLE),
  row(id, `${DKG}shareOperationId`, JSON.stringify(operation)),
  ...(time === null ? [] : [row(id, 'http://www.w3.org/ns/prov#startedAtTime', `"${time}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`)]),
];
async function fixture(extra: Quad[] = [], layer = 'SWM') {
  const store = new OxigraphStore(); stores.push(store);
  await store.insert([...extra, row(LIFECYCLE, `${DKG}memoryLayer`, JSON.stringify(layer))]);
  return store;
}
const latest = () => event('urn:event:B', 'B', '2026-10-04T12:00:00Z');

describe('canonical retained publication ownership', () => {
  it('uses the latest retained promotion, preserving the captured operation over older history', async () => {
    const store = await fixture([...event('urn:event:A', 'A', '2026-10-04T11:00:00Z'), ...latest()]);
    expect(await readPublishedAssertionOperation(store, GRAPH, LIFECYCLE)).toBe('B');
    expect(await isPublishedAssertionOwner(store, GRAPH, LIFECYCLE, 'B')).toBe(true);
    expect(await isPublishedAssertionOwner(store, GRAPH, LIFECYCLE, 'A')).toBe(false);
    expect(await isPublishedAssertionOwner(store, GRAPH, LIFECYCLE, null)).toBe(false);
  });
  it('prefers the explicit current row over retained prior events and parses RDF string syntax', async () => {
    const store = await fixture([...latest(), row(LIFECYCLE, `${DKG}shareOperationId`, '"C"^^<http://www.w3.org/2001/XMLSchema#string>')]);
    expect(await readPublishedAssertionOperation(store, GRAPH, LIFECYCLE)).toBe('C');
  });
  it.each(['""', 'urn:operation', '"B"@en'])('refuses a malformed explicit operation %s without falling back', async object => {
    const store = await fixture([...latest(), row(LIFECYCLE, `${DKG}shareOperationId`, object)]);
    expect(await readPublishedAssertionOperation(store, GRAPH, LIFECYCLE)).toBeUndefined();
    expect(await isPublishedAssertionOwner(store, GRAPH, LIFECYCLE, 'B')).toBe(false);
  });
  it('refuses conflicting current rows even when a retained promotion matches', async () => {
    const store = await fixture([...latest(), ...['B', 'C'].map(op => row(LIFECYCLE, `${DKG}shareOperationId`, JSON.stringify(op)))]);
    expect(await isPublishedAssertionOwner(store, GRAPH, LIFECYCLE, 'B')).toBe(false);
  });
  it.each(['operation', 'time', 'missing time', 'invalid time'])('refuses a corrupt retained promotion: %s', async corruption => {
    const rows = latest();
    if (corruption === 'operation') rows.push(row('urn:event:B', `${DKG}shareOperationId`, '"C"'));
    if (corruption === 'time') rows.push(row('urn:event:B', 'http://www.w3.org/ns/prov#startedAtTime', '"2026-10-04T13:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>'));
    const input = corruption === 'missing time' ? event('urn:event:B', 'B', null)
      : corruption === 'invalid time' ? event('urn:event:B', 'B', 'not-a-date') : rows;
    const store = await fixture(input);
    expect(await readPublishedAssertionOperation(store, GRAPH, LIFECYCLE)).toBeUndefined();
    expect(await isPublishedAssertionOwner(store, GRAPH, LIFECYCLE, 'B')).toBe(false);
  });
  it('keeps true legacy absence explicit and rejects an omitted consumption identity', async () => {
    const store = await fixture();
    expect(await readPublishedAssertionOperation(store, GRAPH, LIFECYCLE)).toBeNull();
    expect(await isPublishedAssertionOwner(store, GRAPH, LIFECYCLE, null)).toBe(true);
    expect(await isPublishedAssertionOwner(store, GRAPH, LIFECYCLE, undefined as any)).toBe(false);
  });
  it('withdraws retained event ownership when the named assertion is reopened into WM', async () => {
    const store = await fixture(latest(), 'WM');
    expect(await isPublishedAssertionOwner(store, GRAPH, LIFECYCLE, 'B')).toBe(false);
    const legacy = await fixture([], 'WM');
    expect(await isPublishedAssertionOwner(legacy, GRAPH, LIFECYCLE, null)).toBe(false);
  });
  it.each(['missing', 'conflicting'])('requires coherent layer proof (%s)', async mode => {
    const store = await fixture(latest());
    if (mode === 'missing') await store.deleteByPattern({ graph: GRAPH, subject: LIFECYCLE, predicate: `${DKG}memoryLayer` });
    else await store.insert([row(LIFECYCLE, `${DKG}memoryLayer`, '"WM"')]);
    expect(await isPublishedAssertionOwner(store, GRAPH, LIFECYCLE, 'B')).toBe(false);
  });
  it.each(['SELECT ?operation', 'SELECT DISTINCT ?event', 'SELECT ?layer'])('withholds ownership when acquisition is unavailable at %s', async prefix => {
    const store = await fixture(latest()), query = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation((sparql, options) => sparql.startsWith(prefix)
      ? Promise.resolve({ type: 'boolean' as const, value: false }) : query(sparql, options));
    expect(await isPublishedAssertionOwner(store, GRAPH, LIFECYCLE, 'B')).toBe(false);
  });
});
