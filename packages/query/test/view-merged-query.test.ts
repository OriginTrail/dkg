import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, TrustLevel, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import {
  BlazegraphStore, CURRENT_READ_GRAPH_VERSIONS, OxigraphStore, sparqlEngineOf, workingMemoryIdentityRule,
  type Quad, type ReadGraphState, type ReadGraphStateRow, type TripleStore,
} from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import type { QueryOptions } from '../src/query-engine.js';
import { ScopedQueryViolationError } from '../src/scoped-query-error.js';
import { SemanticsUnsupportedError, ViewNotReadyError, type ViewReadGraphs } from '../src/view-dataset-plan.js';
import { VIEW_SEMANTICS_DELTA_SOURCE, ViewSemanticsDeltaSampler } from '../src/view-semantics-delta.js';

// CI's tornado-blazegraph lane runs this file on a live server; elsewhere it runs on Oxigraph.
const endpoint = process.env.BLAZEGRAPH_TEST_URL;
if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !endpoint) throw new Error('Blazegraph CI endpoint is required');

const id = `view-merged-${randomUUID()}`;
const ROOT = `did:dkg:context-graph:${id}`;
const G1 = `${ROOT}/_verifiable_memory/0xaa/1`;
const G2 = `${ROOT}/_verifiable_memory/0xaa/2`;
const OTHER = `did:dkg:context-graph:${id}-other/_verifiable_memory/0xbb/1`;
const READ = readGraphIri({ scope: readScope(id), layer: MemoryLayer.VerifiableMemory });
const DEFAULT_AGENT = '0x00000000000000000000000000000000000000a1';
const PEER_ID = '12D3KooWViewMergedPeer';
const WM_READ = readGraphIri({ scope: readScope(id), layer: MemoryLayer.WorkingMemory, agentAddress: DEFAULT_AGENT });
const OTHER_AGENT = '0x00000000000000000000000000000000000000b2';
const OTHER_WM_READ = readGraphIri({ scope: readScope(id), layer: MemoryLayer.WorkingMemory, agentAddress: OTHER_AGENT });
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const quad = (subject: string, predicate: string, object: string, graph: string): Quad => ({ subject, predicate, object, graph });
// A product typed in one asset and priced in another; a triple that both assets hold.
// Paths through two predicates, one in each asset.
const PATHS = [
  quad('urn:s1', 'urn:a', 'urn:m1', G1), quad('urn:m1', 'urn:b', 'urn:e1', G1), quad('urn:s2', 'urn:b', 'urn:e2', G2),
];
const ASSETS = [
  quad('urn:p1', RDF_TYPE, 'urn:Product', G1), quad('urn:shared', 'urn:in', 'urn:cg', G1),
  quad('urn:p1', 'urn:price', '"5"', G2), quad('urn:shared', 'urn:in', 'urn:cg', G2),
  ...PATHS,
];
// The read graphs hold the merge of their members.
const READ_GRAPHS = [
  quad('urn:p1', RDF_TYPE, 'urn:Product', READ), quad('urn:p1', 'urn:price', '"5"', READ), quad('urn:shared', 'urn:in', 'urn:cg', READ),
  ...PATHS.map(row => ({ ...row, graph: READ })),
  quad('urn:draft', 'urn:note', '"mine"', WM_READ),
  quad('urn:other-draft', 'urn:note', '"theirs"', OTHER_WM_READ),
];
const ELSEWHERE = [quad('urn:p1', 'urn:price', '"999"', OTHER)];

class FakeReadGraphs implements ViewReadGraphs {
  readonly rows = new Map<string, ReadGraphStateRow>();
  readonly identity = workingMemoryIdentityRule({ defaultAgentAddress: DEFAULT_AGENT, peerId: PEER_ID });
  defaultSemantics?: ViewReadGraphs['defaultSemantics'];
  withWriteLock?: ViewReadGraphs['withWriteLock'];
  serving = true;

  keeps(): boolean {
    return true;
  }

  serves(): boolean {
    return this.serving;
  }

  state(readGraph: string): ReadGraphStateRow | undefined {
    return this.rows.get(readGraph);
  }

  set(readGraph: string, state: ReadGraphState, generation: number): void {
    this.rows.set(readGraph, { readGraph, state, generation, ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion,
      builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion });
  }
}

const VM: QueryOptions = { contextGraphId: id, view: 'verifiable-memory' };
const MERGED: QueryOptions = { ...VM, semantics: 'merged' };
const JOIN = 'SELECT ?p ?x WHERE { ?p a <urn:Product> . ?p <urn:price> ?x }';
const MIXED = 'SELECT ?g ?x WHERE { ?p a <urn:Product> . GRAPH ?g { ?p <urn:price> ?x } }';
const REPEATED = 'SELECT ?g ?s ?o WHERE { GRAPH ?g { ?s (<urn:a>|<urn:b>)+ ?o } }';
const REPEATED_ROWS = [
  { g: G1, s: 'urn:s1', o: 'urn:m1' }, { g: G1, s: 'urn:m1', o: 'urn:e1' }, { g: G1, s: 'urn:s1', o: 'urn:e1' },
  { g: G2, s: 'urn:s2', o: 'urn:e2' },
];
const sortedRows = (rows: readonly Record<string, string>[]) => rows.map(row => JSON.stringify(row)).sort();

describe(`view queries with semantics on ${endpoint ? 'Blazegraph' : 'Oxigraph'}`, () => {
  let store: TripleStore;
  let readGraphs: FakeReadGraphs;
  let engine: DKGQueryEngine;

  beforeAll(async () => {
    store = endpoint ? new BlazegraphStore(endpoint) : new OxigraphStore();
    await store.insert([...ASSETS, ...READ_GRAPHS, ...ELSEWHERE]);
  }, 60_000);

  afterAll(async () => {
    if (endpoint) {
      await store.update([G1, G2, OTHER, READ, WM_READ, OTHER_WM_READ].map(graph => `DROP SILENT GRAPH <${graph}>`).join('; '));
    }
    await store.close();
  }, 60_000);

  const fresh = () => {
    readGraphs = new FakeReadGraphs();
    readGraphs.set(READ, 'ready', 7);
    readGraphs.set(WM_READ, 'ready', 4);
    readGraphs.set(OTHER_WM_READ, 'ready', 2);
    engine = new DKGQueryEngine(store, { readGraphs });
  };

  afterEach(() => { vi.restoreAllMocks(); });

  it('joins across assets when merged, and keeps per-asset matching otherwise', async () => {
    fresh();
    const merged = await engine.query(JOIN, MERGED);
    expect(merged.bindings).toEqual([{ p: 'urn:p1', x: '"5"' }]);
    expect(merged.semantics).toBe('merged');
    for (const options of [VM, { ...VM, semantics: 'per-asset' as const }]) {
      // A per-asset answer is today's answer, without a mark.
      expect(await engine.query(JOIN, options)).toEqual({ bindings: [] });
    }
  });

  it('sees a pattern in another asset from FILTER NOT EXISTS, and counts a shared triple once', async () => {
    fresh();
    const unpriced = 'SELECT ?p WHERE { ?p a <urn:Product> FILTER NOT EXISTS { ?p <urn:price> ?x } }';
    expect((await engine.query(unpriced, MERGED)).bindings).toEqual([]);
    expect((await engine.query(unpriced, VM)).bindings).toEqual([{ p: 'urn:p1' }]);
    const count = await engine.query('SELECT (COUNT(*) AS ?n) WHERE { <urn:shared> <urn:in> ?o }', MERGED);
    expect(Number.parseInt(count.bindings[0]!.n!.replace(/^"(\d+)".*$/, '$1'), 10)).toBe(1);
  });

  it('sets the dataset of every query form', async () => {
    fresh();
    const ask = 'ASK { ?p a <urn:Product> . ?p <urn:price> ?x }';
    expect((await engine.query(ask, MERGED)).bindings).toEqual([{ result: 'true' }]);
    expect((await engine.query(ask, VM)).bindings).toEqual([{ result: 'false' }]);
    const constructed = await engine.query('CONSTRUCT { ?p <urn:costs> ?x } WHERE { ?p a <urn:Product> . ?p <urn:price> ?x }', MERGED);
    expect(constructed.quads?.map(q => [q.subject, q.predicate, q.object])).toEqual([['urn:p1', 'urn:costs', '"5"']]);
    const described = await engine.query('DESCRIBE <urn:p1>', MERGED);
    expect(described.quads?.map(q => q.predicate).sort()).toEqual([RDF_TYPE, 'urn:price'].sort());
    expect(described.semantics).toBe('merged');
  });

  it('combines DESCRIBE with GRAPH where the per-asset route does, and refuses it where that route does', async () => {
    fresh();
    for (const target of [`<${G1}>`, '?g']) {
      const describe = `DESCRIBE ?s WHERE { GRAPH ${target} { ?s a <urn:Product> } }`;
      if (endpoint) {
        for (const options of [MERGED, VM]) {
          await expect(engine.query(describe, options)).rejects.toThrow('DESCRIBE cannot be combined with a GRAPH clause on this store');
        }
        continue;
      }
      const merged = await engine.query(describe, MERGED);
      // The description comes from the read graph, and never from another context graph.
      expect(merged.quads?.map(q => [q.subject, q.predicate, q.object]).sort())
        .toEqual([['urn:p1', RDF_TYPE, 'urn:Product'], ['urn:p1', 'urn:price', '"5"']].sort());
      expect(merged.semantics).toBe('merged');
    }
  });

  it('reads only the read graph for a query without GRAPH', async () => {
    fresh();
    const sent = vi.spyOn(store, 'query');
    await engine.query(JOIN, MERGED);
    expect(sent).toHaveBeenCalledTimes(1);
    const sparql = sent.mock.calls[0]![0];
    expect(sparql).toContain(`FROM <${READ}>`);
    expect(sparql).not.toContain('FROM NAMED');
    expect(sparql).not.toContain(G1);
  });

  it('answers GRAPH portions from the asset graphs, beside patterns outside GRAPH', async () => {
    fresh();
    const sent = vi.spyOn(store, 'query');
    const mixed = await engine.query(MIXED, MERGED);
    expect(mixed.bindings).toEqual([{ g: G2, x: '"5"' }]);
    // The merged read is the one that carries the read graph as its default graph.
    const sparql = sent.mock.calls.map(([query]) => query).find(query => query.includes(`FROM <${READ}>`))!;
    expect(sparql).toContain(`FROM <${READ}>`);
    expect(sparql).toContain(`FROM NAMED <${G1}>`);
    expect(sparql).toContain(`FROM NAMED <${G2}>`);
    // On a store whose dataset does not bound a graph variable, the variable gets the graphs as VALUES.
    if (sparqlEngineOf(store) === 'oxigraph') expect(sparql).not.toContain('VALUES ?g');
    else expect(sparql).toContain('VALUES ?g');
    // The per-asset route still refuses the mix.
    await expect(engine.query(MIXED, VM)).rejects.toThrow(ScopedQueryViolationError);
  });

  it('keeps the graph of each match of a repeated path inside GRAPH, as per asset', async () => {
    fresh();
    const merged = await engine.query(REPEATED, MERGED);
    expect(sortedRows(merged.bindings)).toEqual(sortedRows(REPEATED_ROWS));
    expect(sortedRows(merged.bindings)).toEqual(sortedRows((await engine.query(REPEATED, VM)).bindings));
  });

  it('answers GRAPH portions that assign their graph, or hold no triple pattern of their own, as per asset', async () => {
    fresh();
    // One row per match, in the graph the block names.
    const assigned = [
      `SELECT ?g ?s WHERE { GRAPH ?g { BIND(<${G2}> AS ?g) ?s <urn:in> ?o } }`,
      `SELECT ?g ?s WHERE { GRAPH ?g { ?s <urn:in> ?o { SELECT (<${G1}> AS ?g) WHERE {} } } }`,
    ];
    expect((await engine.query(assigned[0]!, MERGED)).bindings).toEqual([{ g: G2, s: 'urn:shared' }]);
    expect((await engine.query(assigned[1]!, MERGED)).bindings).toEqual([{ g: G1, s: 'urn:shared' }]);
    const perAsset: QueryOptions = { ...VM, semantics: 'per-asset' };
    // On Oxigraph the view's root graph, which the store does not hold, adds no row, also to a block
    // that assigns its graph variable.
    if (!endpoint) {
      const counted = `SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { BIND(IRI("${G1}") AS ?g) } }`;
      for (const options of [MERGED, perAsset]) {
        const n = (await engine.query(counted, options)).bindings[0]!.n!;
        expect(Number.parseInt(n.replace(/^"(\d+)".*$/, '$1'), 10), options.semantics).toBe(1);
      }
    }
    for (const sparql of [
      ...assigned,
      'SELECT ?g ?x WHERE { GRAPH ?g { VALUES ?x { <urn:x:1> <urn:x:2> } } }',
      'SELECT ?g WHERE { GRAPH ?g {} }',
      'SELECT ?g ?s WHERE { GRAPH ?g { { SELECT ?s WHERE { ?s <urn:in> ?o } } } }',
    ]) {
      const merged = (await engine.query(sparql, MERGED)).bindings;
      // Blazegraph's answers to GRAPH blocks without a triple pattern differ from Oxigraph's; on both, merged equals per asset.
      if (!endpoint) expect(merged.length, sparql).toBeGreaterThan(0);
      expect(sortedRows(merged), sparql).toEqual(sortedRows((await engine.query(sparql, perAsset)).bindings));
    }
  });

  it('never shows the read graph, or another context graph, to a GRAPH portion', async () => {
    fresh();
    const graphs = await engine.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }', MERGED);
    expect(graphs.bindings.map(row => row.g).sort()).toEqual([G1, G2].sort());
    for (const graph of [READ, OTHER]) {
      await expect(engine.query(`SELECT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } }`, MERGED)).rejects.toThrow(ScopedQueryViolationError);
    }
  });

  it('constrains a graph variable on a store whose dataset does not bound it', async () => {
    if (endpoint) return;
    const facade = new Proxy(store, { get(target, key) {
      if (key === 'sparqlEngine') return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(sparqlEngineOf(facade)).toBeNull();
    fresh();
    const viaFacade = new DKGQueryEngine(facade, { readGraphs });
    const sent = vi.spyOn(store, 'query');
    // The query the store receives bounds the graph variable to the member graphs itself, so a store
    // that does not enforce its dataset still reads no other graph: the answers alone cannot show it.
    const boundGraphs = () => {
      const merged = sent.mock.calls.map(([query]) => query).filter(query => query.includes(`FROM <${READ}>`)).at(-1)!;
      return [...(merged.match(/VALUES \?g \{([^}]*)\}/)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]).sort();
    };
    // The view's member graphs: its context graph's root data graph and its asset graphs.
    const members = [ROOT, G1, G2].sort();
    expect((await viaFacade.query(MIXED, MERGED)).bindings).toEqual([{ g: G2, x: '"5"' }]);
    expect(boundGraphs()).toEqual(members);
    expect((await viaFacade.query('SELECT DISTINCT ?g WHERE { ?s <urn:price> ?x GRAPH ?g { ?s a <urn:Product> } }', MERGED)).bindings)
      .toEqual([{ g: G1 }]);
    expect(boundGraphs()).toEqual(members);
    // A repeated compound path gets constant graph targets, as on the per-asset route.
    expect(sortedRows((await viaFacade.query(REPEATED, MERGED)).bindings)).toEqual(sortedRows(REPEATED_ROWS));
    expect(sent.mock.calls.some(([query]) => query.includes(`GRAPH <${G1}> { VALUES ?g { <${G1}> }`))).toBe(true);
  });

  it('reads working memory from the read graph of the agent that owns the address', async () => {
    fresh();
    for (const agentAddress of [PEER_ID, DEFAULT_AGENT]) {
      const result = await engine.query('SELECT ?s ?n WHERE { ?s <urn:note> ?n }',
        { contextGraphId: id, view: 'working-memory', agentAddress, semantics: 'merged' });
      expect(result.bindings).toEqual([{ s: 'urn:draft', n: '"mine"' }]);
    }
    // Another agent reads its own read graph, and none of the default agent's drafts.
    const theirs = await engine.query('SELECT ?s ?n WHERE { ?s <urn:note> ?n }',
      { contextGraphId: id, view: 'working-memory', agentAddress: OTHER_AGENT, semantics: 'merged' });
    expect(theirs.bindings).toEqual([{ s: 'urn:other-draft', n: '"theirs"' }]);
  });

  it('answers 503 for a read graph that is not ready, before it reads the store', async () => {
    fresh();
    readGraphs.set(READ, 'dirty', 8);
    const sent = vi.spyOn(store, 'query');
    await expect(engine.query(JOIN, MERGED)).rejects.toBeInstanceOf(ViewNotReadyError);
    readGraphs.defaultSemantics = () => 'merged';
    await expect(engine.query(JOIN, VM)).rejects.toBeInstanceOf(ViewNotReadyError);
    expect(sent).not.toHaveBeenCalled();
    // Per asset, nothing changes.
    expect(await engine.query(JOIN, { ...VM, semantics: 'per-asset' })).toEqual({ bindings: [] });
  });

  it('drops an answer whose read graph changed while it ran, and plans once more', async () => {
    fresh();
    const query = store.query.bind(store);
    const [oldPrice, newPrice] = [quad('urn:p1', 'urn:price', '"5"', READ), quad('urn:p1', 'urn:price', '"6"', READ)];
    let changes = 1;
    const sent = vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
      const result = await query(sparql, options);
      if (changes > 0) {
        changes -= 1;
        // A rebuild replaces the read graph's contents and moves its generation while the query runs.
        await store.delete([oldPrice]);
        await store.insert([newPrice]);
        readGraphs.set(READ, 'ready', readGraphs.state(READ)!.generation + 1);
      }
      return result;
    });
    try {
      // Only the answer of the generation that is still current is released.
      const result = await engine.query(JOIN, MERGED);
      expect(result).toEqual({ bindings: [{ p: 'urn:p1', x: '"6"' }], semantics: 'merged' });
      expect(sent).toHaveBeenCalledTimes(2);
      // A read graph that changes again is not ready.
      changes = 2;
      await expect(engine.query(JOIN, MERGED)).rejects.toBeInstanceOf(ViewNotReadyError);
      expect(sent).toHaveBeenCalledTimes(4);
    } finally {
      sent.mockRestore();
      await store.delete([newPrice]);
      await store.insert([oldPrice]);
    }
  });

  it('drops an answer whose member graphs changed after they were listed, and plans once more', async () => {
    fresh();
    const G3 = `${ROOT}/_verifiable_memory/0xaa/3`;
    const added = [quad('urn:p3', RDF_TYPE, 'urn:Product', G3), quad('urn:p3', 'urn:price', '"7"', G3)];
    const maintained = added.map(row => ({ ...row, graph: READ }));
    let written = false;
    // A writer adds a member graph, and the read graph takes it in, right after the first listing.
    type Listing = (...args: unknown[]) => Promise<unknown>;
    const lister = store as unknown as Record<'readGraphInventory' | 'listGraphsByPrefix' | 'listGraphs', Listing | undefined>;
    // Discovery lists graphs through the first of these that the store has.
    const method = (['readGraphInventory', 'listGraphsByPrefix', 'listGraphs'] as const).find(name => lister[name])!;
    const list = lister[method]!.bind(store);
    vi.spyOn(lister as Record<typeof method, Listing>, method).mockImplementation(async (...args) => {
      const listed = await list(...args);
      if (!written) {
        written = true;
        await store.insert([...added, ...maintained]);
      }
      return listed;
    });
    try {
      const result = await engine.query(MIXED, MERGED);
      expect(sortedRows(result.bindings)).toEqual(sortedRows([{ g: G2, x: '"5"' }, { g: G3, x: '"7"' }]));
      expect(result.semantics).toBe('merged');
      expect(written).toBe(true);
    } finally {
      await store.delete([...added, ...maintained]);
    }
  });

  it('refuses merged where it does not apply, and answers a defaulted request per asset there', async () => {
    fresh();
    const endorsed = { ...VM, minTrust: TrustLevel.Endorsed };
    await expect(engine.query(JOIN, { ...endorsed, semantics: 'merged' })).rejects.toBeInstanceOf(SemanticsUnsupportedError);
    readGraphs.defaultSemantics = () => 'merged';
    const defaulted = await engine.query(JOIN, endorsed);
    expect(defaulted.semantics).toBeUndefined();
    expect((await engine.query(JOIN, VM)).semantics).toBe('merged');
  });

  it('refuses a malformed minTrust before it reads the store', async () => {
    fresh();
    const sent = vi.spyOn(store, 'query');
    await expect(engine.query(JOIN, { ...MERGED, minTrust: 'Endorsed' as never })).rejects.toThrow(/^Invalid minTrust/);
    readGraphs.defaultSemantics = () => 'merged';
    await expect(engine.query(JOIN, { ...VM, minTrust: Number.NaN })).rejects.toThrow(/^Invalid minTrust/);
    expect(sent).not.toHaveBeenCalled();
  });

  it('keeps queries without a view per asset or unscoped, and refuses merged there', async () => {
    fresh();
    await expect(engine.query(JOIN, { contextGraphId: id, semantics: 'merged' })).rejects.toBeInstanceOf(SemanticsUnsupportedError);
    await expect(engine.query('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1', { semantics: 'merged' }))
      .rejects.toBeInstanceOf(SemanticsUnsupportedError);
    expect((await engine.query(JOIN, { contextGraphId: id })).semantics).toBeUndefined();
    expect((await engine.query('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1')).semantics).toBeUndefined();
  });

  it('samples view queries that could be answered merged, and runs each both ways once', async () => {
    fresh();
    // Every store read of a sample runs while the read graph's write lock is held.
    const locked: string[] = [];
    let holding = false;
    readGraphs.withWriteLock = async <T>(readGraph: string, work: () => Promise<T>): Promise<T> => {
      locked.push(readGraph);
      holding = true;
      try {
        return await work();
      } finally {
        holding = false;
      }
    };
    const query = store.query.bind(store);
    const sampleReads: boolean[] = [];
    vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
      if (options?.source === VIEW_SEMANTICS_DELTA_SOURCE) sampleReads.push(holding);
      return query(sparql, options);
    });
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1 });
    const sampling = new DKGQueryEngine(store, { readGraphs, viewSemanticsDelta: sampler });
    const unpriced = 'SELECT ?p WHERE { ?p a <urn:Product> FILTER NOT EXISTS { ?p <urn:price> ?x } }';
    // The caller's signal ends with its answer; the sample reads with its own.
    const caller = new AbortController();
    await sampling.query(JOIN, { ...VM, signal: caller.signal });
    caller.abort();
    await sampling.query(unpriced, MERGED);
    // Merged does not apply here, so there is nothing to compare.
    await sampling.query(JOIN, { ...VM, minTrust: TrustLevel.Endorsed });
    // A query that generates values during evaluation is counted, not compared.
    await sampling.query('SELECT ?p (STRUUID() AS ?id) WHERE { ?p a <urn:Product> }', VM);
    await sampler.idle();
    expect(locked).toEqual([READ, READ]);
    expect(sampleReads.length).toBeGreaterThanOrEqual(4);
    expect(sampleReads.every(Boolean)).toBe(true);
    const [summary, ...others] = sampling.viewSemanticsDeltaReport([id]);
    expect(others).toEqual([]);
    expect(summary).toMatchObject({ contextGraphId: id, samples: 2, skipped: 0, uncomparable: 1,
      kinds: { 'none': 0, 'copies-removed': 0, 'rows-added': 1, 'rows-removed-or-changed': 1 } });
    expect(summary!.shapes.map(shape => [shape.view, shape.shape]).sort()).toEqual([
      ['verifiable-memory', 'SELECT ?p ?x WHERE { ?p a <…> . ?p <…> ?x }'],
      ['verifiable-memory', 'SELECT ?p WHERE { ?p a <…> FILTER NOT EXISTS { ?p <…> ?x } }'],
    ].sort());
    // Without read graphs there is no merged answer to compare with.
    const plain = new DKGQueryEngine(store, { viewSemanticsDelta: new ViewSemanticsDeltaSampler({ sampleRate: 1 }) });
    await plain.query(JOIN, VM);
    expect(plain.viewSemanticsDeltaReport()).toEqual([]);
    expect(new DKGQueryEngine(store).viewSemanticsDeltaReport()).toEqual([]);
  });

  it('samples queries from a read graph that requests are not answered from yet', async () => {
    fresh();
    readGraphs.serving = false;
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1 });
    const sampling = new DKGQueryEngine(store, { readGraphs, viewSemanticsDelta: sampler });
    await expect(sampling.query(JOIN, MERGED)).rejects.toBeInstanceOf(SemanticsUnsupportedError);
    expect(await sampling.query(JOIN, VM)).toEqual({ bindings: [] });
    await sampler.idle();
    expect(sampling.viewSemanticsDeltaReport([id])).toMatchObject([{ samples: 1, skipped: 0,
      kinds: { 'none': 0, 'copies-removed': 0, 'rows-added': 1, 'rows-removed-or-changed': 0 } }]);
    // A sample whose read graph changes while it runs is dropped, not planned again.
    const changingSampler = new ViewSemanticsDeltaSampler({ sampleRate: 1 });
    const changing = new DKGQueryEngine(store, { readGraphs, viewSemanticsDelta: changingSampler });
    await changing.query(JOIN, VM);
    readGraphs.set(READ, 'ready', 8);
    await changingSampler.idle();
    expect(changing.viewSemanticsDeltaReport([id])).toMatchObject([{ samples: 0, skipped: 1 }]);
  });

  it('answers merged requests as unsupported on a node that keeps no read graphs', async () => {
    const plain = new DKGQueryEngine(store);
    await expect(plain.query(JOIN, MERGED)).rejects.toBeInstanceOf(SemanticsUnsupportedError);
    expect((await plain.query(JOIN, VM)).semantics).toBeUndefined();
  });
});
