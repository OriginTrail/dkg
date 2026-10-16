import { describe, it, expect, vi } from 'vitest';
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
    const query = store.query.bind(store);
    const callerQuery = vi.spyOn(store, 'query').mockImplementation((sparql, options) => {
      // Private discovery uses query(), not listGraphs(). Only the caller's
      // name query may enter this otherwise unavailable read lane.
      if (!sparql.includes(`<${SCHEMA_NAME}>`)) throw new Error('metadata lane occupied');
      return query(sparql, options);
    });
    const result = await engine.query(
      `SELECT ?name WHERE { GRAPH <${graph}> { ?s <${SCHEMA_NAME}> ?name } }`,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true, ...options },
    );
    expect(result.bindings).toEqual([{ name: '"scoped"' }]);
    expect(callerQuery).toHaveBeenCalledTimes(1);
    await store.close();
  });

  it.each(['includeSharedMemory', 'includeWorkspace'] as const)('bypasses occupied discovery in the combined %s route', async option => {
    const store = new OxigraphStore();
    try {
      await store.insert([{ subject: 'urn:item', predicate: SCHEMA_NAME, object: '"scoped"', graph: META }]);
      store.listGraphs = async () => { throw new Error('catalog lane occupied'); };
      const query = store.query.bind(store);
      const caller = vi.spyOn(store, 'query').mockImplementation((sparql, options) => {
        if (!sparql.includes(`<${SCHEMA_NAME}>`)) throw new Error('metadata lane occupied');
        return query(sparql, options);
      });
      const result = await new DKGQueryEngine(store).query(
        `SELECT ?name WHERE { GRAPH <${META}> { ?s <${SCHEMA_NAME}> ?name } }`,
        { contextGraphId: CONTEXT_GRAPH, [option]: true },
      );
      expect(result.bindings).toEqual([{ name: '"scoped"' }]);
      expect(caller).toHaveBeenCalledTimes(2);
    } finally { await store.close(); }
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
