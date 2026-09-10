import { afterAll, beforeAll, expect, it } from 'vitest';
import { OxigraphStore, BlazegraphStore, SparqlHttpStore, type TripleStore } from '../src/index.js';
import { startOxigraphSparqlEndpoint, type OxigraphSparqlEndpoint } from './helpers/oxigraph-sparql-endpoint.js';

let endpoint: OxigraphSparqlEndpoint;
beforeAll(async () => { endpoint = await startOxigraphSparqlEndpoint(); });
afterAll(async () => { await endpoint.close(); });

// The HTTP fixture executes RDF operations in Oxigraph. This is an adapter
// protocol test; native Blazegraph conformance lives in test-systems/.
it.each<{ name: string; createStore: () => TripleStore }>([
  { name: 'embedded', createStore: () => new OxigraphStore() },
  { name: 'sparql-http', createStore: () => new SparqlHttpStore({ queryEndpoint: endpoint.queryEndpoint, updateEndpoint: endpoint.updateEndpoint }) },
  { name: 'blazegraph-http', createStore: () => new BlazegraphStore(endpoint.queryEndpoint) },
])('$name preserves real stored state across duplicate insert and scoped deletion', async ({ name, createStore }) => {
  const store = createStore();
  const graph = `urn:parity:${name}`;
  const other = `${graph}:private`;
  const quads = [
    { graph, subject: 'urn:one', predicate: 'urn:p', object: '"one"' },
    { graph, subject: 'urn:two', predicate: 'urn:p', object: '"two"' },
    { graph: other, subject: 'urn:one', predicate: 'urn:p', object: '"private"' },
  ];
  try {
    await store.insert(quads); await store.insert(quads);
    expect(await store.countQuads(graph)).toBe(2);
    expect(await store.deleteByPattern({ graph, subject: 'urn:one' })).toBe(1);
    expect(await store.countQuads(graph)).toBe(1);
    expect(await store.countQuads(other)).toBe(1);
    expect(await store.deleteByPattern({ graph, subject: 'urn:one' })).toBe(0);
    const result = await store.query(`SELECT ?s ?o WHERE { GRAPH <${graph}> { ?s <urn:p> ?o } }`);
    expect(result).toMatchObject({ type: 'bindings', bindings: [{ s: 'urn:two', o: '"two"' }] });
  } finally { await store.close(); }
});
