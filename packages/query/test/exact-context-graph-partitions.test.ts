import { readNamedGraphStatisticsBatch, NAMED_GRAPH_STATS_BATCH_SIZE } from '../src/named-graph-statistics.js';
import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const ROOT = 'did:dkg:context-graph:large';
const WM = `${ROOT}/_working_memory/0xagent/1`;
const options = { contextGraphId: 'large', includeContextGraphPartitions: true };

describe('typed named-graph statistics', () => {
  it.each(['_private', '_meta', '_working_memory', 'assertion/bob/staging', 'docs/_private'])('rejects invalid subgraph %s before inventory or exact admission', async subGraphName => {
    const store = new OxigraphStore();
    try {
      const graph = `${ROOT}/${subGraphName}`;
      await store.insert([{ subject: 'urn:secret', predicate: 'urn:p', object: '"hidden"', graph }]);
      const engine = new DKGQueryEngine(store);
      const opts = { subGraphName, draftAccess: { kind: 'none' as const } };
      await expect(engine.listContextGraphQueryPartitionReads('large', opts)).rejects.toThrow(/Invalid sub-graph name/);
      await expect(engine.readContextGraphNamedGraphStats('large', opts)).rejects.toThrow(/Invalid sub-graph name/);
      await expect(readNamedGraphStatisticsBatch(store, 'large', [graph], opts)).rejects.toThrow(/Invalid sub-graph name/);
    } finally { await store.close(); }
  });

  it('authorizes each statistics batch from bounded live metadata without enumerating the CG again', async () => {
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
      await engine.listContextGraphQueryPartitionReads('large');
      enumerate.mockClear();
      submitted.length = 0;
      expect((await readNamedGraphStatisticsBatch(store, 'large', [WM], options))).toHaveLength(1);
      expect(enumerate).not.toHaveBeenCalled();
      expect(submitted.every(sparql => !/GRAPH\s+\?/i.test(sparql))).toBe(true);
      expect(submitted.filter(sparql => sparql.includes('assertionGraph')).every(sparql => sparql.replace(/\s+/g, " ").includes(`VALUES ?assertionGraph { <${WM}> }`))).toBe(true);

      // External stores cannot authorize later batches from a completed cache.
      await inner.deleteByPattern({ subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', graph: `${ROOT}/_meta` });
      await expect(readNamedGraphStatisticsBatch(store, 'large', [WM], options)).rejects.toThrow(/Scoped query violation/);
      expect(enumerate).not.toHaveBeenCalled();
    } finally { await inner.close(); }
  });

  it('checks registered subgraphs, assertion children, and canonical child-CG boundaries from candidate facts', async () => {
    const store = new OxigraphStore();
    const code = `${ROOT}/code`;
    const codeWm = `${code}/_working_memory/author/1`;
    const named = `${codeWm}/_named_graph/urn%3Adata`;
    const read = (_engine: DKGQueryEngine, graph: string) => readNamedGraphStatisticsBatch(store, 'large', [graph], options);
    try {
      await store.insert([
        { subject: code, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${ROOT}/_meta` },
        { subject: code, predicate: 'http://schema.org/name', object: '"code"', graph: `${ROOT}/_meta` },
        { subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', object: codeWm, graph: `${ROOT}/_meta` },
        ...[code, codeWm, named, `${ROOT}/unknown`, `${ROOT}/code/_private/1`, `${ROOT}/_verifiable_memory/staging/1`].map(graph => ({ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph })),
      ]);
      const engine = new DKGQueryEngine(store);
      for (const graph of [code, codeWm, named]) expect((await read(engine, graph))).toHaveLength(1);
      for (const graph of [`${ROOT}/unknown`, `${ROOT}/code/_private/1`, `${ROOT}/_verifiable_memory/staging/1`]) await expect(read(engine, graph)).rejects.toThrow(/Scoped query violation/);
      // A stray declaration in the parent's meta graph is not canonical.
      await store.insert([{ subject: code, predicate: 'https://dkg.network/ontology#registrationStatus', object: '"registered"', graph: `${ROOT}/_meta` }]);
      expect((await read(engine, code))).toHaveLength(1);
      await store.insert([{ subject: code, predicate: 'https://dkg.network/ontology#registrationStatus', object: '"registered"', graph: `${code}/_meta` }]);
      for (const graph of [code, codeWm, named]) await expect(read(engine, graph)).rejects.toThrow(/Scoped query violation/);
    } finally { await store.close(); }
  });

  it('retains named-subgraph and SWM-only routing without admitting private, rules, staging, or sibling graphs', async () => {
    const store = new OxigraphStore();
    const read = (_engine: DKGQueryEngine, graph: string, opts: object = {}) => readNamedGraphStatisticsBatch(store, (opts as { contextGraphId?: string }).contextGraphId ?? 'large', [graph], { ...options, ...opts });
    const code = `${ROOT}/code`;
    try {
      await store.insert([
        { subject: code, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${ROOT}/_meta` },
        { subject: code, predicate: 'http://schema.org/name', object: '"code"@en', graph: `${ROOT}/_meta` },
        ...[code, `${code}/_shared_memory/author/1`, `${ROOT}/_shared_memory/author/1`, `${ROOT}/_verifiable_memory/author/1`].map(graph => ({ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph })),
      ]);
      const engine = new DKGQueryEngine(store);
      expect((await read(engine, code))).toHaveLength(1);
      expect((await read(engine, `${code}/_shared_memory/author/1`, { subGraphName: 'code', graphSuffix: '_shared_memory' }))).toHaveLength(1);
      for (const graph of [ROOT, `${ROOT}/_shared_memory/author/1`, `${ROOT}/_verifiable_memory/author/1`]) await expect(read(engine, graph, { subGraphName: 'code' })).rejects.toThrow(/Scoped query violation/);
      for (const graph of [`${ROOT}/_private/author/1`, `${ROOT}/_shared_memory/author/1/_private`, `${ROOT}/_rules/rule`, `${ROOT}/_shared_memory/staging/1`]) await expect(read(engine, graph, { graphSuffix: '_shared_memory' })).rejects.toThrow(/Scoped query violation/);
      await expect(read(engine, `${ROOT}/_private`, { includePrivate: true })).rejects.toThrow(/only admit public/);
    } finally { await store.close(); }
  });

  it('judges staging below the CG root, so a subgraph or CG ID segment named staging stays readable', async () => {
    const store = new OxigraphStore();
    const read = (_engine: DKGQueryEngine, graph: string, opts: object) => readNamedGraphStatisticsBatch(store, (opts as { contextGraphId?: string }).contextGraphId ?? 'large', [graph], { ...options, ...opts });
    const sub = `${ROOT}/staging`;
    const walletId = '0x1111111111111111111111111111111111111111/staging';
    const wallet = `did:dkg:context-graph:${walletId}`;
    const layers = (base: string) => ['_working_memory', '_shared_memory', '_verifiable_memory'].map(layer => `${base}/${layer}/0xagent/1`);
    const staged = (base: string) => [`${base}/_shared_memory/staging/0123456789abcdef`, `${base}/_verifiable_memory/staging/1`];
    const cases = [
      { id: 'large', opts: {}, readable: [sub, ...layers(sub)], forbidden: [...staged(ROOT), ...staged(sub)] },
      { id: 'large', opts: { subGraphName: 'staging' }, readable: [sub, ...layers(sub)], forbidden: staged(sub) },
      { id: walletId, opts: { includeSharedMemory: true }, readable: [`${wallet}/_shared_memory`, ...layers(wallet)], forbidden: staged(wallet) },
    ];
    try {
      await store.insert([
        { subject: sub, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${ROOT}/_meta` },
        { subject: sub, predicate: 'http://schema.org/name', object: '"staging"', graph: `${ROOT}/_meta` },
        { subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', object: layers(sub)[0], graph: `${ROOT}/_meta` },
        { subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', object: layers(wallet)[0], graph: `${wallet}/_meta` },
        ...[sub, `${wallet}/_shared_memory`, ...layers(sub), ...layers(wallet), ...staged(ROOT), ...staged(sub), ...staged(wallet)]
          .map(graph => ({ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph })),
      ]);
      const engine = new DKGQueryEngine(store);
      for (const { id, opts, readable, forbidden } of cases) {
        // Exact admission must accept every inventory graph the dashboard then reads.
        const inventory = (await engine.listContextGraphQueryPartitionReads(id, opts)).map(partition => partition.graph);
        expect(inventory).toEqual(expect.arrayContaining(readable));
        for (const graph of readable) expect((await read(engine, graph, { ...opts, contextGraphId: id }))).toHaveLength(1);
        for (const graph of forbidden) {
          expect(inventory).not.toContain(graph);
          await expect(read(engine, graph, { ...opts, contextGraphId: id })).rejects.toThrow(/Scoped query violation/);
        }
      }
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
        if (sparql.startsWith('SELECT ?g (COUNT')) await store.deleteByPattern({ subject: 'urn:assertion', graph: `${ROOT}/_meta` });
        return result;
      });
      await expect(readNamedGraphStatisticsBatch(store, 'large', [WM], options)).rejects.toThrow(/admission changed/);
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
        if (sparql.startsWith('SELECT ?g (COUNT')) await store.insert([{ subject: 'urn:other', predicate: 'urn:p', object: '"new"', graph: `${ROOT}/_verifiable_memory/other/1` }]);
        return result;
      });
      expect((await readNamedGraphStatisticsBatch(store, 'large', [WM], { ...options, signal: controller.signal }))).toHaveLength(1);
      expect(spy.mock.calls.every(([, opts]) => opts?.signal === controller.signal)).toBe(true);
    } finally { await store.close(); }
  });
});


it('owns eight-graph aggregate batches and excludes unscoped content', async () => {
  const store = new OxigraphStore();
  try {
    const graphs = Array.from({ length: NAMED_GRAPH_STATS_BATCH_SIZE + 1 }, (_, i) => `${ROOT}/_verifiable_memory/a/${i}`);
    await store.insert(graphs.flatMap(graph => [1, 2, 3].map(i => ({ graph, subject: `urn:s:${i % 2}`, predicate: `urn:p:${i}`, object: '"v"' }))));
    await store.insert([{ graph: '', subject: 'urn:secret', predicate: 'urn:p', object: '"hidden"' }]);
    const spy = vi.spyOn(store, 'query');
    const stats = await new DKGQueryEngine(store).readContextGraphNamedGraphStats('large');
    expect(stats).toHaveLength(graphs.length);
    expect(stats.every(row => row.entityCount === 2 && row.tripleCount === 3)).toBe(true);
    const aggregates = spy.mock.calls.map(([query]) => query).filter(query => query.startsWith('SELECT ?g (COUNT'));
    expect(aggregates).toHaveLength(2);
    for (const query of aggregates) {
      expect([...query.matchAll(/GRAPH </g)].length).toBeLessThanOrEqual(8);
      expect(query).not.toMatch(/GRAPH\s+\?|\bVALUES\b/);
    }
    await expect(readNamedGraphStatisticsBatch(store, 'large', graphs)).rejects.toThrow('eight graphs');
  } finally { await store.close(); }
});
