import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const CONTEXT_GRAPH = 'static-scope';
const GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
const META = `${GRAPH}/_meta`;
const SCHEMA_NAME = 'http://schema.org/name';

describe('static scoped query admission', () => {
  it.each([
    { graph: META, options: {} },
    { graph: GRAPH, options: {} },
    { graph: `${GRAPH}/_shared_memory_meta`, options: { graphSuffix: '_shared_memory' as const } },
    { graph: `${GRAPH}/_private`, options: { includePrivate: true } },
    { graph: `${GRAPH}/orders/_meta`, options: { subGraphName: 'orders' } },
  ])('reads a static explicit graph without unrelated catalog admissions: $graph', async ({ graph, options }) => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([{subject: 'urn:item', predicate: SCHEMA_NAME, object: '"scoped"', graph}]);
    // Catalog availability must not gate a read already authorized by the route.
    store.listGraphs = async () => { throw new Error('catalog lane occupied'); };
    const result = await engine.query(
      `SELECT ?name WHERE { GRAPH <${graph}> { ?s <${SCHEMA_NAME}> ?name } }`,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true, ...options },
    );
    expect(result.bindings).toEqual([{ name: '"scoped"' }]);
  });

  it.each([
    { graph: `${GRAPH}/_private`, options: {} },
    { graph: META, options: { graphSuffix: '_shared_memory' as const } },
    { graph: 'did:dkg:context-graph:other/_meta', options: {} },
    { graph: GRAPH, options: { subGraphName: 'orders' } },
  ])('keeps explicit graph authority closed for $graph', async ({ graph, options }) => {
    const store = new OxigraphStore();
    await store.insert([{ subject: 'urn:item', predicate: SCHEMA_NAME, object: '"secret"', graph }]);
    await expect(new DKGQueryEngine(store).query(
      `SELECT ?name WHERE { GRAPH <${graph}> { ?s <${SCHEMA_NAME}> ?name } }`,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true, ...options },
    )).rejects.toThrow('outside the allowed graph set');
  });
});
