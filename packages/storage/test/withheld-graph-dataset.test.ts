import { afterEach, describe, expect, it } from 'vitest';
import {
  BlazegraphStore, OxigraphStore, OxigraphWorkerStore, SparqlHttpStore, type Quad, type TripleStore,
} from '../src/index.js';
import { ATOMIC_GRAPH_REPLACE_STAGING_PREFIX } from '../src/atomic-graph-replace.js';

const ROOT = 'did:dkg:context-graph:marked';
const QUADS: Quad[] = [
  { subject: 'urn:s:meta', predicate: 'urn:p', object: '"meta"', graph: `${ROOT}/_meta` },
  { subject: 'urn:s:root', predicate: 'urn:p', object: '"root"', graph: ROOT },
  { subject: 'urn:s:sibling', predicate: 'urn:p', object: '"sibling"', graph: 'did:dkg:context-graph:marked-other/_meta' },
  { subject: 'urn:s:open', predicate: 'urn:p', object: '"open"', graph: 'did:dkg:context-graph:open' },
  { subject: 'urn:s:staging', predicate: 'urn:p', object: '"staging"', graph: `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}fixture` },
  { subject: 'urn:s:default', predicate: 'urn:p', object: '"default"', graph: '' },
];
const withheld = { withheldGraphRoots: [ROOT] };
const stores: TripleStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => {});
});

async function values(store: TripleStore, sparql: string, options?: { withheldGraphRoots: string[] }) {
  const result = await store.query(sparql, options);
  return result.type === 'bindings' ? result.bindings.map(row => row.o).sort() : [];
}

describe.each([
  ['embedded Oxigraph', () => new OxigraphStore()],
  ['Oxigraph worker', () => new OxigraphWorkerStore()],
] as const)('%s query with withheld graphs', (_name, create) => {
  it('runs over the default graph and the named graphs outside the withheld roots', async () => {
    const store = create();
    stores.push(store);
    await store.insert(QUADS);
    expect(await values(store, 'SELECT ?o WHERE { GRAPH ?g { ?s <urn:p> ?o } }'))
      .toEqual(['"meta"', '"open"', '"root"', '"sibling"', '"staging"']);
    // Operation-internal staging graphs stay out too: the dataset uses the visible enumeration.
    expect(await values(store, 'SELECT ?o WHERE { GRAPH ?g { ?s <urn:p> ?o } }', withheld)).toEqual(['"open"', '"sibling"']);
    // A subquery inside GRAPH reads only the dataset's graphs.
    expect(await values(store, 'SELECT ?o WHERE { GRAPH ?g { OPTIONAL { { SELECT ?o WHERE { ?s <urn:p> ?o } } } } }', withheld))
      .toEqual(['"open"', '"open"', '"sibling"', '"sibling"']);
    expect(await values(store, 'SELECT ?o WHERE { ?s <urn:p> ?o }', withheld)).toEqual(['"default"']);
    expect(await values(store, `SELECT ?o WHERE { GRAPH <${ROOT}/_meta> { ?s <urn:p> ?o } }`, withheld)).toEqual([]);
  });

  it('refuses an empty root', async () => {
    const store = create();
    stores.push(store);
    await expect(store.query('SELECT * WHERE { ?s ?p ?o }', { withheldGraphRoots: [''] })).rejects.toThrow('non-empty');
  });
});

describe('stores that cannot restrict a query dataset', () => {
  it.each([
    ['SparqlHttpStore', () => new SparqlHttpStore({ queryEndpoint: 'http://fixture.invalid/sparql' })],
    ['BlazegraphStore', () => new BlazegraphStore('http://fixture.invalid/sparql')],
  ] as const)('%s refuses a query that must withhold graphs before sending it', async (name, create) => {
    const store = create();
    await expect(store.query('SELECT * WHERE { ?s ?p ?o }', withheld)).rejects.toThrow(`${name} cannot withhold graphs from a query`);
  });
});
