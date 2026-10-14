import { expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

it.each(['verifiable-memory', 'shared-working-memory', 'working-memory'] as const)(
  'fences a child registered during %s partition discovery', async view => {
    const inner = new OxigraphStore(), id = 'view-registration-race';
    const root = `did:dkg:context-graph:${id}`, child = `${root}/code`;
    const layer = view === 'verifiable-memory' ? '_verifiable_memory'
      : view === 'shared-working-memory' ? '_shared_memory' : '_working_memory';
    let registered = false;
    const store = new Proxy(inner, { get(target, key) {
      if (key === 'listGraphsByPrefix') return async (prefix: string) => {
        if (!registered && prefix.startsWith(`${child}/`)) {
          registered = true;
          await target.insert([
            { graph: `${child}/_meta`, subject: child,
              predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#ContextGraph' },
            { graph: `${child}/${layer}/agent-a/1`, subject: 'urn:child-secret', predicate: 'urn:p', object: '"secret"' },
          ]);
        }
        return (await target.listGraphs()).filter(graph => graph.startsWith(prefix));
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await inner.insert([
        { graph: `${root}/_meta`, subject: child, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph' },
        { graph: `${root}/_meta`, subject: child, predicate: 'http://schema.org/name', object: '"code"' },
        { graph: `${root}/${layer}/agent-a/1`, subject: 'urn:parent', predicate: 'urn:p', object: '"visible"' },
      ]);
      const result = await new DKGQueryEngine(store).query('SELECT ?s WHERE { ?s <urn:p> ?o }',
        { contextGraphId: id, view, agentAddress: 'agent-a' });
      expect(registered).toBe(true);
      expect(result.bindings).toEqual([{ s: 'urn:parent' }]);
    } finally { await inner.close(); }
  },
);
