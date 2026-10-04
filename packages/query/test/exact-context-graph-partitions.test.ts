import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const ROOT = 'did:dkg:context-graph:large';
const WM = `${ROOT}/_working_memory/0xagent/1`;
const SWM = `${ROOT}/_shared_memory/0xagent/1`;
const VM = `${ROOT}/_verifiable_memory/0xagent/1`;
const options = { contextGraphId: 'large', includeContextGraphPartitions: true, exactContextGraphPartitions: true };

describe('exact context-graph partition reads', () => {
  it('uses the registered public partition policy and executes one concrete query without VALUES or fan-out', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        { subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', object: WM, graph: `${ROOT}/_meta` },
        ...[WM, SWM, VM].map(graph => ({ subject: `urn:${graph.split('/')[3]}`, predicate: 'urn:p', object: '"visible"', graph })),
        { subject: 'urn:secret', predicate: 'urn:p', object: '"secret"', graph: `${ROOT}/_private/1` },
        { subject: 'urn:unregistered', predicate: 'urn:p', object: '"hidden"', graph: `${ROOT}/_working_memory/0xother/2` },
      ]);
      const engine = new DKGQueryEngine(store);
      const graphs = await engine.listContextGraphQueryPartitions('large');
      expect(graphs).toEqual(expect.arrayContaining([WM, SWM, VM]));
      expect(graphs).not.toContain(`${ROOT}/_private/1`);
      expect(graphs).not.toContain(`${ROOT}/_working_memory/0xother/2`);
      const query = `SELECT ?s ?g WHERE { { GRAPH <${WM}> { ?s ?p ?o } BIND(<${WM}> AS ?g) } UNION { GRAPH <${SWM}> { ?s ?p ?o } BIND(<${SWM}> AS ?g) } }`;
      const spy = vi.spyOn(store, 'query');
      const result = await engine.query(query, options);
      expect(result.bindings).toHaveLength(2);
      const submitted = spy.mock.calls.filter(([sparql]) => sparql.includes('SELECT ?s ?g'));
      expect(submitted).toHaveLength(1);
      expect(submitted[0][0]).not.toMatch(/\bVALUES\b|GRAPH\s+\?/i);
      for (const graph of [`${ROOT}/_private/1`, `${ROOT}/_working_memory/0xother/2`, 'did:dkg:context-graph:other']) {
        await expect(engine.query(`SELECT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } }`, options)).rejects.toThrow(/Scoped query violation/);
      }
    } finally { await store.close(); }
  });

  it('rejects graphless, variable, mixed-default, and unscoped forms', async () => {
    const store = new OxigraphStore();
    try {
      const engine = new DKGQueryEngine(store);
      for (const sparql of [
        'SELECT ?s WHERE { ?s ?p ?o }',
        'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }',
        `SELECT ?s WHERE { { GRAPH <${ROOT}> { ?s ?p ?o } } UNION { ?s ?p ?o } }`,
      ]) await expect(engine.query(sparql, options)).rejects.toThrow(/Exact/);
      await expect(engine.query(`SELECT ?s WHERE { GRAPH <${ROOT}> { ?s ?p ?o } }`, { exactContextGraphPartitions: true })).rejects.toThrow(/Exact/);
    } finally { await store.close(); }
  });
});
