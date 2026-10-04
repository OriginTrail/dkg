import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
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

  it('authorizes each exact batch from bounded live metadata without enumerating the CG again', async () => {
    const inner = new OxigraphStore();
    const submitted: string[] = [];
    const enumerate = vi.fn();
    const store = new Proxy(inner, { get(target, key) {
      if (key === 'writeRevisionCoverage') return 'process-local';
      if (key === 'query') return (sparql: string, opts: object) => {
        submitted.push(sparql);
        return target.query(sparql, opts);
      };
      if ((key === 'listGraphs' || key === 'listGraphsByPrefix') && typeof target[key] === 'function') return (...args: unknown[]) => {
        enumerate();
        return (target[key] as (...args: unknown[]) => unknown).apply(target, args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as TripleStore;
    try {
      await inner.insert([
        { subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', object: WM, graph: `${ROOT}/_meta` },
        { subject: 'urn:wm', predicate: 'urn:p', object: '"visible"', graph: WM },
        ...Array.from({ length: 80 }, (_, n) => ({ subject: `urn:vm:${n}`, predicate: 'urn:p', object: '"visible"', graph: `${ROOT}/_verifiable_memory/author/${n}` })),
      ]);
      const engine = new DKGQueryEngine(store);
      await engine.listContextGraphQueryPartitions('large');
      enumerate.mockClear();
      submitted.length = 0;
      const query = `SELECT ?s WHERE { GRAPH <${WM}> { ?s ?p ?o } }`;
      expect((await engine.query(query, options)).bindings).toHaveLength(1);
      expect(enumerate).not.toHaveBeenCalled();
      expect(submitted.every(sparql => !/GRAPH\s+\?/i.test(sparql))).toBe(true);
      expect(submitted.filter(sparql => sparql.includes('assertionGraph')).every(sparql => sparql.includes(`VALUES ?graph { <${WM}> }`))).toBe(true);

      // External stores cannot authorize later batches from a completed cache.
      await inner.deleteByPattern({ subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', graph: `${ROOT}/_meta` });
      await expect(engine.query(query, options)).rejects.toThrow(/Scoped query violation/);
      expect(enumerate).not.toHaveBeenCalled();
    } finally { await inner.close(); }
  });

  it('checks registered subgraphs, assertion children, and canonical child-CG boundaries from candidate facts', async () => {
    const store = new OxigraphStore();
    const code = `${ROOT}/code`;
    const codeWm = `${code}/_working_memory/author/1`;
    const named = `${codeWm}/_named_graph/urn%3Adata`;
    const read = (engine: DKGQueryEngine, graph: string) => engine.query(`SELECT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } }`, options);
    try {
      await store.insert([
        { subject: code, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${ROOT}/_meta` },
        { subject: code, predicate: 'http://schema.org/name', object: '"code"', graph: `${ROOT}/_meta` },
        { subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', object: codeWm, graph: `${ROOT}/_meta` },
        ...[code, codeWm, named, `${ROOT}/unknown`, `${ROOT}/code/_private/1`, `${ROOT}/_verifiable_memory/staging/1`].map(graph => ({ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph })),
      ]);
      const engine = new DKGQueryEngine(store);
      for (const graph of [code, codeWm, named]) expect((await read(engine, graph)).bindings).toHaveLength(1);
      for (const graph of [`${ROOT}/unknown`, `${ROOT}/code/_private/1`, `${ROOT}/_verifiable_memory/staging/1`]) await expect(read(engine, graph)).rejects.toThrow(/Scoped query violation/);
      // A stray declaration in the parent's meta graph is not canonical.
      await store.insert([{ subject: code, predicate: 'https://dkg.network/ontology#registrationStatus', object: '"registered"', graph: `${ROOT}/_meta` }]);
      expect((await read(engine, code)).bindings).toHaveLength(1);
      await store.insert([{ subject: code, predicate: 'https://dkg.network/ontology#registrationStatus', object: '"registered"', graph: `${code}/_meta` }]);
      for (const graph of [code, codeWm, named]) await expect(read(engine, graph)).rejects.toThrow(/Scoped query violation/);
    } finally { await store.close(); }
  });

  it('retains named-subgraph and SWM-only routing without admitting private, rules, staging, or sibling graphs', async () => {
    const store = new OxigraphStore();
    const read = (engine: DKGQueryEngine, graph: string, opts: object = {}) => engine.query(`SELECT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } }`, { ...options, ...opts });
    const code = `${ROOT}/code`;
    try {
      await store.insert([
        { subject: code, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${ROOT}/_meta` },
        { subject: code, predicate: 'http://schema.org/name', object: '"code"@en', graph: `${ROOT}/_meta` },
        ...[code, `${code}/_shared_memory/author/1`, `${ROOT}/_shared_memory/author/1`, `${ROOT}/_verifiable_memory/author/1`].map(graph => ({ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph })),
      ]);
      const engine = new DKGQueryEngine(store);
      expect((await read(engine, code)).bindings).toHaveLength(1);
      expect((await read(engine, `${code}/_shared_memory/author/1`, { subGraphName: 'code', graphSuffix: '_shared_memory' })).bindings).toHaveLength(1);
      for (const graph of [ROOT, `${ROOT}/_shared_memory/author/1`, `${ROOT}/_verifiable_memory/author/1`]) await expect(read(engine, graph, { subGraphName: 'code' })).rejects.toThrow(/Scoped query violation/);
      for (const graph of [`${ROOT}/_private/author/1`, `${ROOT}/_shared_memory/author/1/_private`, `${ROOT}/_rules/rule`, `${ROOT}/_shared_memory/staging/1`]) await expect(read(engine, graph, { graphSuffix: '_shared_memory' })).rejects.toThrow(/Scoped query violation/);
      await expect(read(engine, `${ROOT}/_private`, { includePrivate: true })).rejects.toThrow(/only admit public/);
    } finally { await store.close(); }
  });

  it('withholds a materialized result when candidate admission metadata changes during the store read', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        { subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', object: WM, graph: `${ROOT}/_meta` },
        { subject: 'urn:wm', predicate: 'urn:p', object: '"visible"', graph: WM },
      ]);
      const original = store.query.bind(store);
      vi.spyOn(store, 'query').mockImplementation(async (sparql, opts) => {
        const result = await original(sparql, opts);
        if (sparql.startsWith('SELECT ?s WHERE')) await store.deleteByPattern({ subject: 'urn:assertion', graph: `${ROOT}/_meta` });
        return result;
      });
      await expect(new DKGQueryEngine(store).query(`SELECT ?s WHERE { GRAPH <${WM}> { ?s ?p ?o } }`, options)).rejects.toThrow(/admission changed/);
    } finally { await store.close(); }
  });

  it('keeps an exact read usable during unrelated content writes and passes cancellation to candidate metadata', async () => {
    const store = new OxigraphStore();
    const controller = new AbortController();
    try {
      await store.insert([
        { subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', object: WM, graph: `${ROOT}/_meta` },
        { subject: 'urn:wm', predicate: 'urn:p', object: '"visible"', graph: WM },
      ]);
      const original = store.query.bind(store);
      const spy = vi.spyOn(store, 'query').mockImplementation(async (sparql, opts) => {
        const result = await original(sparql, opts);
        if (sparql.startsWith('SELECT ?s WHERE')) await store.insert([{ subject: 'urn:other', predicate: 'urn:p', object: '"new"', graph: `${ROOT}/_verifiable_memory/other/1` }]);
        return result;
      });
      expect((await new DKGQueryEngine(store).query(`SELECT ?s WHERE { GRAPH <${WM}> { ?s ?p ?o } }`, { ...options, signal: controller.signal })).bindings).toHaveLength(1);
      expect(spy.mock.calls.every(([, opts]) => opts?.signal === controller.signal)).toBe(true);
    } finally { await store.close(); }
  });
});
