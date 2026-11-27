import { describe, expect, it } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import type { QueryOptions } from '../src/query-engine.js';

const ROOT = 'did:dkg:context-graph:planned-routes';
const QUERY = 'SELECT ?name WHERE { ?s <urn:name> ?name }';
describe('planned execution preserves legacy route precedence', () => {
  it.each([
    [{}, ['data']],
    [{ graphSuffix: '_shared_memory' }, ['shared']],
    [{ includeSharedMemory: true }, ['data', 'shared']],
    [{ includeWorkspace: true }, ['data', 'shared']],
    [{ includeSharedMemory: false, includeWorkspace: true }, ['data']],
    [{ includeSharedMemory: true, graphSuffix: '_shared_memory' }, ['data', 'shared']],
  ] as [QueryOptions, string[]][])('executes the selected graph families %j', async (options, expected) => {
    const store = new OxigraphStore();
    try {
      const graphs = [ROOT, `${ROOT}/_shared_memory`, `${ROOT}/code`, `${ROOT}/code/_shared_memory`];
      await store.insert(graphs.map((graph, i) => ({ graph, subject: `urn:item:${i}`, predicate: 'urn:name',
        object: JSON.stringify(`${i >= 2 ? 'code-' : ''}${i % 2 ? 'shared' : 'data'}`) })));
      // Exercise the fallback too: this wrapper deliberately exposes only listGraphs.
      const fallback = new Proxy(store, { get(target, key) {
        if (key === 'listGraphsByPrefix') return undefined;
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } }) as TripleStore;
      for (const candidate of [store, fallback]) {
        const engine = new DKGQueryEngine(candidate);
        for (const subGraphName of [undefined, 'code']) {
          const result = await engine.query(QUERY, { ...options, contextGraphId: 'planned-routes', subGraphName });
          expect(result.bindings.map(row => JSON.parse(row.name!)).sort()).toEqual(
            expected.map(name => `${subGraphName ? 'code-' : ''}${name}`).sort());
        }
      }
    } finally { await store.close(); }
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])
    ('combines ASK results from data=%s and shared-memory=%s', async (data, shared) => {
      const store = new OxigraphStore();
      try {
        const graph = 'did:dkg:context-graph:combined';
        for (const target of [...(data ? [graph] : []), ...(shared ? [`${graph}/_shared_memory`] : [])]) {
          await store.insert([{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: target }]);
        }
        const engine = new DKGQueryEngine(store);
        expect(await engine.query('ASK { <urn:s> <urn:p> <urn:o> }', { contextGraphId: 'combined', includeSharedMemory: true }))
          .toEqual({ bindings: [{ result: String(data || shared) }] });
      } finally { await store.close(); }
    });
});
