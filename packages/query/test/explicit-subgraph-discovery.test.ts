import { expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

it.each([false, true])('retains explicit sub-graph partitions without widening broad inventory (filtered=%s)', async filtered => {
  const inner = new OxigraphStore(), root = 'did:dkg:context-graph:explicit-subgraph';
  const store = filtered ? new Proxy(inner, { get(target, key) {
    if (key === 'graphEnumerationVisibility') return undefined;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) : inner;
  const graphs = ['code', 'sibling'].flatMap(sub => [
    `${root}/${sub}/_shared_memory/agent/1`, `${root}/${sub}/_verifiable_memory/agent/1`,
    `${root}/${sub}/assertion/agent-a/draft`, `${root}/${sub}/assertion/agent-a/draft/_named_graph/details`,
  ]);
  const query = 'SELECT ?g ?s WHERE { GRAPH ?g { ?s <urn:p> ?o } }';
  const options = { contextGraphId: 'explicit-subgraph', includeContextGraphPartitions: true };
  try {
    await inner.insert([
      ...graphs.map((graph, i) => ({ graph, subject: `urn:item:${i}`, predicate: 'urn:p', object: '"visible"' })),
      ...['code', 'sibling'].map(sub => ({ graph: `${root}/_meta`, subject: `urn:assertion:${sub}`,
        predicate: 'http://dkg.io/ontology/assertionGraph', object: `${root}/${sub}/assertion/agent-a/draft` })),
      { graph: `${root}/code/_private`, subject: 'urn:secret', predicate: 'urn:p', object: '"private"' },
    ]);
    const engine = new DKGQueryEngine(store);
    expect((await engine.query(query, options)).bindings).toEqual([]);
    expect((await engine.query(query, { ...options, subGraphName: 'code' })).bindings.map(row => row.g).sort())
      .toEqual(graphs.filter(graph => graph.startsWith(`${root}/code/`)).sort());
    // Explicit selection is per request, never cached as broad registration.
    expect((await engine.query(query, options)).bindings).toEqual([]);
    await inner.insert([{ graph: `${root}/code/_meta`, subject: `${root}/code`,
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#ContextGraph' }]);
    expect((await engine.query(query, { ...options, subGraphName: 'code' })).bindings).toEqual([]);
  } finally { await inner.close(); }
});
