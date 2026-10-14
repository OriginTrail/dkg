import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore, ChangelogStore, GraphSetIndexStore, StoreResponseTooLargeError, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QUERY_CATALOG_MAX_RESPONSE_BYTES } from '../src/query-store-read-context.js';
import { readScopedContentGraphCatalog } from '../src/scoped-content-graph-catalog.js';

const ID = 'dynamic-admission';
const ROOT = `did:dkg:context-graph:${ID}`;
const NAME = 'http://schema.org/name';
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OPTIONS = { contextGraphId: ID, includeContextGraphPartitions: true };
const QUERY = `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${NAME}> ?name } }`;

describe('fresh dynamic scoped query admission', () => {
  it.each([[true, false], [false, false], [true, true], [false, true]])('groups only a complete fresh catalog (visibility=%s, decorated=%s)', async (visible, decorated) => {
    const adapter = new OxigraphStore();
    let owned = false;
    const admission = vi.fn(async (work: () => Promise<unknown>) => {
      owned = true;
      try { return await work(); } finally { owned = false; }
    });
    const reads: boolean[] = [];
    const wrapped = new Proxy(adapter, { get(target, key) {
      if (key === 'withQueryReadAdmission') return admission;
      if (key === 'graphEnumerationVisibility' && !visible) return undefined;
      const value = Reflect.get(target, key, target);
      if (key === 'listGraphsByPrefix' && owned) throw new Error('Owned plan entered shared enumeration');
      if (key === 'query') return (...args: Parameters<TripleStore['query']>) => {
        reads.push(owned); return target.query(...args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const store = decorated ? new ChangelogStore(new GraphSetIndexStore(wrapped)) : wrapped;
    const graph = `${ROOT}/_verifiable_memory/a/1`;
    try {
      await adapter.insert([{ graph, subject: 'urn:item', predicate: NAME, object: '"visible"' }]);
      const engine = new DKGQueryEngine(store);
      expect((await engine.query(QUERY, OPTIONS)).bindings).toHaveLength(1);
      await adapter.dropGraph(graph);
      expect((await engine.query(QUERY, OPTIONS)).bindings).toEqual([]);
      expect(admission).toHaveBeenCalledTimes(visible ? 2 : 0);
      expect(reads.length).toBeGreaterThanOrEqual(4);
      expect(reads.every(value => value === visible)).toBe(true);
      // Explicit/view/private routes may await shared decorator refreshes.
      admission.mockClear();
      await engine.query(QUERY, { ...OPTIONS, includePrivate: true });
      expect(admission).not.toHaveBeenCalled();
    } finally { await adapter.close(); }
  });
  it('shares a context inventory across sibling scopes without sharing their authorization', async () => {
    const store = new OxigraphStore();
    const code = `${ROOT}/code/_verifiable_memory/a/1`, decisions = `${ROOT}/decisions/_verifiable_memory/a/1`;
    try {
      await store.insert([code, decisions].map(graph => ({ graph, subject: 'urn:item', predicate: NAME, object: '"value"' })));
      const query = vi.spyOn(store, 'query');
      const engine = new DKGQueryEngine(store);
      expect((await engine.query(QUERY, { ...OPTIONS, subGraphName: 'code' })).bindings.map(row => row.g)).toEqual([code]);
      expect((await engine.query(QUERY, { ...OPTIONS, subGraphName: 'decisions' })).bindings.map(row => row.g)).toEqual([decisions]);
      expect(query).toHaveBeenCalledTimes(3); // One context catalog, two authorized caller reads.
      await store.dropGraph(code);
      expect((await engine.query(QUERY, { ...OPTIONS, subGraphName: 'code' })).bindings).toEqual([]);
      expect(query).toHaveBeenCalledTimes(5); // The write invalidates the shared context inventory.
    } finally { await store.close(); }
  });
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
      const query = vi.spyOn(store, 'query'), list = vi.spyOn(store, 'listGraphsByPrefix');
      const result = await new DKGQueryEngine(store).query(QUERY, OPTIONS);
      expect(result.bindings).toEqual([{ g: publicGraph, name: '"value"' }]);
      if (kind === 'unknown') {
        expect(list).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0]![0]).not.toContain('GRAPH ?graph');
        expect(query.mock.calls[0]![0]).toContain('?assertionGraph');
      }
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

it.each([true, false])('keeps catalog bytes separate from caller result limits (owned=%s)', async owned => {
  const adapter = new OxigraphStore(), controller = new AbortController();
  const options = { ...OPTIONS, signal: controller.signal, priority: 'background' as const,
    source: 'catalog-budget-test', maxResponseBytes: 1024 };
  const calls: Array<{ bytes: number; options: Parameters<TripleStore['query']>[1] }> = [];
  const store = new Proxy(adapter, { get(target, key) {
    if (key === 'withQueryReadAdmission') return owned ? async (work: () => Promise<unknown>) => work() : undefined;
    if (key === 'query') return async (sparql: string, readOptions: Parameters<TripleStore['query']>[1]) => {
      const result = await target.query(sparql, readOptions);
      const bytes = Buffer.byteLength(JSON.stringify(result));
      calls.push({ bytes, options: readOptions });
      if (readOptions?.maxResponseBytes !== undefined && bytes > readOptions.maxResponseBytes)
        throw new StoreResponseTooLargeError(readOptions.maxResponseBytes, bytes);
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    await adapter.insert(Array.from({ length: 32 }, (_, n) => ({ graph: `${ROOT}/_verifiable_memory/large-catalog/${n}`,
      subject: `urn:item:${n}`, predicate: NAME, object: '"visible"' })));
    const engine = new DKGQueryEngine(store);
    expect((await engine.query('SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }', options)).bindings)
      .toEqual([{ n: '"32"^^<http://www.w3.org/2001/XMLSchema#integer>' }]);
    expect(calls[0]!.bytes).toBeGreaterThan(1024);
    expect(calls[0]!.options).toMatchObject({ priority: options.priority, source: options.source });
    expect(calls[0]!.options?.signal).toBe(owned ? controller.signal : undefined);
    expect(calls[0]!.options?.maxResponseBytes).toBe(QUERY_CATALOG_MAX_RESPONSE_BYTES);
    expect(calls.at(-1)!.options?.maxResponseBytes).toBe(1024);
    await expect(engine.query(QUERY, options)).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
  } finally { await adapter.close(); }
});
