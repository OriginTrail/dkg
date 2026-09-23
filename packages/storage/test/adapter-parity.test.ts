import { afterAll, beforeAll, expect, it } from 'vitest';
import { OxigraphStore, BlazegraphStore, SparqlHttpStore, type TripleStore } from '../src/index.js';
import { startOxigraphSparqlEndpoint, type OxigraphSparqlEndpoint } from './helpers/oxigraph-sparql-endpoint.js';
import { observeInvalidSparqlTerms } from './helpers/invalid-sparql-term-observer.js';

let endpoint: OxigraphSparqlEndpoint;
beforeAll(async () => { endpoint = await startOxigraphSparqlEndpoint(); });
afterAll(async () => { await endpoint.close(); });

// The HTTP fixture executes RDF operations in Oxigraph. This is an adapter
// protocol test; native Blazegraph conformance lives in test-systems/.
const STORES: Array<{ name: string; adapter: string; createStore: () => TripleStore }> = [
  { name: 'embedded', adapter: 'oxigraph', createStore: () => new OxigraphStore() },
  { name: 'sparql-http', adapter: 'sparql-http', createStore: () => new SparqlHttpStore({ queryEndpoint: endpoint.queryEndpoint, updateEndpoint: endpoint.updateEndpoint }) },
  { name: 'blazegraph-http', adapter: 'blazegraph', createStore: () => new BlazegraphStore(endpoint.queryEndpoint) },
];

it.each(STORES)('$name preserves real stored state across duplicate insert and scoped deletion', async ({ name, createStore }) => {
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

it.each(STORES)('$name logs a malformed graph IRI and escapes a line break in a subject prefix', async ({ name, adapter, createStore }) => {
  const observed = observeInvalidSparqlTerms();
  const store = createStore();
  const graph = `urn:parity:terms:${name}`;
  const malformed = `${graph}:x^y`;
  try {
    await store.insert([{ graph, subject: 'urn:one', predicate: 'urn:p', object: '"one"' }]);

    // Observe mode still strips the caret (x^y → xy) as before, but no longer silently.
    await expect(store.dropGraph(malformed)).resolves.toBeUndefined();
    expect(observed.counted).toEqual([{
      value: 1, adapter, operation: 'dropGraph', position: 'graph', kind: 'iri', enforcement: 'observe',
    }]);
    expect(observed.warnings).toEqual([expect.stringContaining(JSON.stringify(malformed))]);

    // Sent raw, the line break used to make the update unparseable.
    expect(await store.deleteBySubjectPrefix(graph, 'urn:o\nne')).toBe(0);
    expect(await store.countQuads(graph)).toBe(1);
    expect(observed.counted).toHaveLength(1);
  } finally {
    observed.restore();
    await store.close();
  }
});
