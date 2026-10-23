import { afterEach, expect, it, vi } from 'vitest';
import { BlazegraphStore } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());
it.each([
  'INSERT DATA { GRAPH <urn:g> { <urn:s> <urn:p> "v"; <urn:q> "semi;colon" } }',
  'DELETE { GRAPH <urn:g> { <urn:s> <urn:p> ?old } } INSERT { GRAPH <urn:g> { <urn:s> <urn:p> "new" } } WHERE { OPTIONAL { GRAPH <urn:g> { <urn:s> <urn:p> ?old } } }',
  'PREFIX ex: <urn:ex:> INSERT DATA { GRAPH ex:g { ex:s ex:p <urn:semi;colon> } } # trailing ; comment',
])('admits one native operation: %s', async sparql => {
  const fetch = vi.fn(async () => new Response('complete')); vi.stubGlobal('fetch', fetch);
  const store = new BlazegraphStore('http://blaze.test/sparql');
  await store.atomicUpdate!(sparql);
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]).toMatchObject([expect.anything(), { body: sparql }]);
});
it.each([
  'INSERT DATA {}; DELETE WHERE { ?s ?p ?o }',
  String.raw`INSERT DATA {} \u003B DELETE WHERE { ?s ?p ?o }`,
  'INSERT DATA {}; # hidden separator\n INSERT DATA {}',
  'INSERT DATA { <urn:s> <urn:p> "unterminated }',
  'INSERT DATA { GRAPH <urn:g> { <urn:s> <urn:p> "v" }',
  'SELECT * WHERE { ?s ?p ?o }',
])('refuses unsupported or incomplete input before HTTP: %s', async sparql => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const store = new BlazegraphStore('http://blaze.test/sparql');
  await expect(store.atomicUpdate!(sparql)).rejects.toMatchObject({ name: 'UnsupportedTripleStoreCapabilityError', capability: 'atomicUpdate', outcome: 'not_started' });
  expect(fetch).not.toHaveBeenCalled();
});
it('propagates native execution failures without retrying another write path', async () => {
  const failure = new Error('native mutation failed'), fetch = vi.fn(async () => { throw failure; }); vi.stubGlobal('fetch', fetch);
  const store = new BlazegraphStore('http://blaze.test/sparql');
  await expect(store.atomicUpdate!('INSERT DATA {}')).rejects.toBe(failure); expect(fetch).toHaveBeenCalledOnce();
});
