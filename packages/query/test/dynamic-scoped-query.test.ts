import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore, ChangelogStore, GraphSetIndexStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { readScopedContentGraphCatalog } from '../src/scoped-content-graph-catalog.js';

const ID = 'dynamic-admission';
const ROOT = `did:dkg:context-graph:${ID}`;
const NAME = 'http://schema.org/name';
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OPTIONS = { contextGraphId: ID, includeContextGraphPartitions: true };
const QUERY = `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${NAME}> ?name } }`;

describe('fresh dynamic scoped query admission', () => {
  it.each(['changelog', 'index-outside', 'index-inside', 'unknown'] as const)('keeps reserved VM partitions invisible through %s enumeration', async kind => {
    const base = new OxigraphStore(), hidden = `${ROOT}/_verifiable_memory/a/1`, publicGraph = `${ROOT}/_verifiable_memory/a/2`;
    await base.insert([hidden, publicGraph].map(graph => ({ graph, subject: 'urn:item', predicate: NAME, object: '"value"' })));
    const inner = kind === 'index-inside' ? new GraphSetIndexStore(base) : base;
    const changelog = new ChangelogStore(inner, { reservedGraphs: [hidden] });
    let store: TripleStore = kind === 'index-outside' ? new GraphSetIndexStore(changelog) : changelog;
    if (kind === 'unknown') store = new Proxy(store, { get(target, key) {
      if (key === 'graphEnumerationVisibility') return undefined;
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      // Raw query remains deliberately unfiltered; enumeration owns visibility.
      expect((await base.query(`SELECT ?s WHERE { GRAPH <${hidden}> { ?s ?p ?o } }`)).type).toBe('bindings');
      expect(await store.listGraphs()).not.toContain(hidden);
      const result = await new DKGQueryEngine(store).query(QUERY, OPTIONS);
      expect(result.bindings).toEqual([{ g: publicGraph, name: '"value"' }]);
    } finally { await store.close(); }
  });
  it('uses one fresh inventory for combined VM and SWM variable routes', async () => {
    const store = new OxigraphStore(), graphs = [`${ROOT}/_verifiable_memory/a/1`, `${ROOT}/_shared_memory/a/1`];
    try {
      await store.insert(graphs.map(graph => ({ graph, subject: 'urn:item', predicate: NAME, object: '"value"' })));
      const query = vi.spyOn(store, 'query'), list = vi.spyOn(store, 'listGraphs');
      const result = await new DKGQueryEngine(store).query(QUERY, { ...OPTIONS, includeSharedMemory: true });
      expect(result.bindings.map(row => row.g).sort()).toEqual(graphs.sort());
      // One catalog and the unchanged two caller executions for the combined route.
      expect(query).toHaveBeenCalledTimes(3); expect(list).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it.each(['"code"', '"code"^^<http://www.w3.org/2001/XMLSchema#string>', '"code"@en'])('shares registration handling with view discovery: %s', async name => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        { graph: `${ROOT}/_meta`, subject: 'urn:sub', predicate: TYPE, object: 'http://dkg.io/ontology/SubGraph' },
        { graph: `${ROOT}/_meta`, subject: 'urn:sub', predicate: NAME, object: name },
        { graph: `${ROOT}/code/_verifiable_memory/a/1`, subject: 'urn:content', predicate: NAME, object: '"registered"' },
      ]);
      expect((await readScopedContentGraphCatalog(ID, store.query.bind(store))).subGraphs).toEqual(new Set(['code']));
      const result = await new DKGQueryEngine(store).query(`SELECT ?name WHERE { ?s <${NAME}> ?name }`,
        { contextGraphId: ID, view: 'verifiable-memory' });
      expect(result.bindings).toContainEqual({ name: '"registered"' });
    } finally { await store.close(); }
  });

  it('enumerates each non-empty graph and excludes registered empty graphs', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([ROOT, `${ROOT}/_verifiable_memory/a/1`].map(graph =>
        ({ subject: 'urn:s', predicate: NAME, object: '"value"', graph })));
      await store.update(`CREATE GRAPH <${ROOT}/_verifiable_memory/empty/1>`);
      const catalog = await readScopedContentGraphCatalog(ID, store.query.bind(store));
      expect([...catalog.graphs].sort()).toEqual([ROOT, `${ROOT}/_verifiable_memory/a/1`].sort());
    } finally { await store.close(); }
  });

  it('loads authority and graph inventory together before executing the caller query', async () => {
    const store = new OxigraphStore();
    await store.insert([
      { subject: 'urn:item', predicate: NAME, object: '"visible"', graph: `${ROOT}/_verifiable_memory/a/1` },
    ]);
    const admissions: string[] = [];
    const rawStore = new Proxy(store, {
      get(target, key) {
        // No generation source: every request must obtain fresh authority.
        if (key === 'getWriteRevision' || key === 'writeRevisionCoverage') return undefined;
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (['query', 'listGraphs', 'hasGraph'].includes(String(key))) admissions.push(String(key));
          return value.apply(target, args);
        };
      },
    });
    const engine = new DKGQueryEngine(rawStore);
    for (let i = 0; i < 2; i++) {
      admissions.length = 0;
      expect((await engine.query(QUERY, OPTIONS)).bindings).toEqual([
        { g: `${ROOT}/_verifiable_memory/a/1`, name: '"visible"' },
      ]);
      expect(admissions).toEqual(['query', 'query']);
    }
    await store.close();
  });

  it('retains child, private, staging and unregistered partition fences', async () => {
    const store = new OxigraphStore();
    const graphs = [
      ROOT, `${ROOT}/_verifiable_memory/a/1`, `${ROOT}/_private/a/1`,
      `${ROOT}/_verifiable_memory/staging/a/1`, `${ROOT}/unregistered`,
      `${ROOT}/code`, `${ROOT}/code/_verifiable_memory/a/1`,
    ];
    await store.insert([
      ...graphs.map((graph) => ({ subject: 'urn:item', predicate: NAME, object: '"value"', graph })),
      { subject: 'urn:sub', predicate: TYPE, object: '<http://dkg.io/ontology/SubGraph>', graph: `${ROOT}/_meta` },
      { subject: 'urn:sub', predicate: NAME, object: '"code"', graph: `${ROOT}/_meta` },
      { subject: `${ROOT}/code`, predicate: TYPE, object: '<https://dkg.network/ontology#ContextGraph>', graph: `${ROOT}/code/_meta` },
    ]);
    const result = await new DKGQueryEngine(store).query(QUERY, OPTIONS);
    expect(result.bindings.map((row) => row.g).filter((g) => g !== `${ROOT}/_meta`).sort())
      .toEqual([ROOT, `${ROOT}/_verifiable_memory/a/1`].sort());
    await store.close();
  });
});
