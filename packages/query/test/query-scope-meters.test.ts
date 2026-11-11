import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextGraphLayerUri, MemoryLayer, TrustLevel } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import type { QueryOptions } from '../src/query-engine.js';
import { resolveQueryReadPlan } from '../src/query-read-plan.js';
import { classifyQueryScope, QUERY_SCOPE_LIMIT_CANDIDATES, QueryScopeMeter, sliceClass, type QueryScopeClass } from '../src/query-scope-meters.js';
import { prepareGraphScope } from '../src/sparql-graph-scope.js';

interface Point { metric: string; value: number; attributes: Record<string, unknown> }

const telemetry = vi.hoisted(() => ({ points: [] as Point[], failing: false }));

// Every instrument records into `telemetry.points` under its DkgMetrics field
// name. While `failing`, the query scope instruments throw.
vi.mock('@origintrail-official/dkg-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  const instrument = (metric: string) => {
    const note = (value: number, attributes: Record<string, unknown> = {}) => {
      if (telemetry.failing && metric.startsWith('queryScope')) throw new Error('telemetry is down');
      telemetry.points.push({ metric, value, attributes });
    };
    return { add: note, record: note };
  };
  const metrics = new Proxy({}, { get: (_target, key) => instrument(String(key)) });
  return { ...actual, getMetrics: () => metrics };
});

const REQUESTS = 'queryScopeRequestsTotal';
const SLICE = 'queryScopeSliceGraphs';
const STORE_MS = 'queryScopeStoreMs';
const OVER_LIMIT = 'queryScopeOverLimitTotal';
const METERS = [REQUESTS, SLICE, STORE_MS, OVER_LIMIT];

const CG = 'scope-meters';
const ROOT = `did:dkg:context-graph:${CG}`;
const AGENT = `0x${'1'.repeat(40)}`;
const NAME = 'http://schema.org/name';
const QUERY = `SELECT ?s ?name WHERE { ?s <${NAME}> ?name }`;
const layerGraph = (contextGraph: string, layer: MemoryLayer, n: number) => contextGraphLayerUri(contextGraph, layer, AGENT, n);
const quad = (graph: string, n: number): Quad => ({ graph, subject: `urn:item:${n}`, predicate: NAME, object: `"item ${n}"` });
const meters = () => telemetry.points.filter(({ metric }) => METERS.includes(metric));
const named = (metric: string) => telemetry.points.filter(point => point.metric === metric);

const vmGraphs = [1, 2, 3].map(n => layerGraph(CG, MemoryLayer.VerifiableMemory, n));
const swmGraphs = [1, 2].map(n => layerGraph(CG, MemoryLayer.SharedWorkingMemory, n));
const wmGraphs = [1, 2].map(n => layerGraph(CG, MemoryLayer.WorkingMemory, n));
const LARGE_CG = 'scope-meters-large';
const LARGE_SWM_GRAPHS = 2_050;

const cls = (overrides: Partial<QueryScopeClass>): QueryScopeClass => ({
  route: 'view', view: 'none', graph: 'none', min_trust: 'false', private: 'false', ...overrides,
});

function classify(sparql: string, options?: QueryOptions): QueryScopeClass {
  const prepared = prepareSparql(sparql);
  if (prepared.status !== 'valid') throw new Error(`malformed test query: ${sparql}`);
  const scope = prepareGraphScope(prepared);
  return classifyQueryScope(scope, resolveQueryReadPlan(scope, options, null), options);
}

let store: OxigraphStore;
let engine: DKGQueryEngine;

beforeAll(async () => {
  store = new OxigraphStore();
  await store.insert([
    quad(ROOT, 0),
    ...vmGraphs.map((graph, n) => quad(graph, 10 + n)),
    ...swmGraphs.map((graph, n) => quad(graph, 20 + n)),
    ...wmGraphs.map((graph, n) => quad(graph, 30 + n)),
    ...Array.from({ length: LARGE_SWM_GRAPHS }, (_, n) => quad(layerGraph(LARGE_CG, MemoryLayer.SharedWorkingMemory, n + 1), n)),
  ]);
  engine = new DKGQueryEngine(store);
});

afterAll(async () => { await store.close(); });

beforeEach(() => {
  telemetry.points.length = 0;
  telemetry.failing = false;
});

describe('query scope classes', () => {
  it('labels a query by route, view and graph form, and never by a graph name', () => {
    expect(classify(QUERY, { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.Endorsed }))
      .toEqual(cls({ view: 'vm', min_trust: 'true' }));
    expect(classify(QUERY, { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified }))
      .toEqual(cls({ view: 'vm', min_trust: 'true' }));
    // The floor needs no trust rewrite, and other views ignore the option.
    expect(classify(QUERY, { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.SelfAttested }))
      .toEqual(cls({ view: 'vm' }));
    expect(classify(QUERY, { contextGraphId: CG, view: 'working-memory', agentAddress: AGENT, minTrust: TrustLevel.Endorsed }))
      .toEqual(cls({ view: 'wm' }));
    expect(classify('SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }', { contextGraphId: CG, view: 'shared-working-memory' }))
      .toEqual(cls({ view: 'swm', graph: 'variable' }));
    expect(classify(`SELECT ?s WHERE { GRAPH <${ROOT}> { ?s ?p ?o } }`, { contextGraphId: CG, includePrivate: true }))
      .toEqual(cls({ route: 'legacy', graph: 'explicit', private: 'true' }));
    expect(classify(`SELECT ?s WHERE { GRAPH <${ROOT}> { ?s ?p ?o } GRAPH ?g { ?s ?p ?o } }`, { contextGraphId: CG }))
      .toEqual(cls({ route: 'legacy', graph: 'variable' }));
    // Private partitions are read only on the legacy route.
    expect(classify(QUERY, { contextGraphId: CG, view: 'verifiable-memory', includePrivate: true }))
      .toEqual(cls({ view: 'vm' }));
    expect(classify(QUERY)).toEqual(cls({ route: 'unscoped' }));
    // A view the engine does not know keeps a fixed label, whatever its name.
    expect(classify(QUERY, { contextGraphId: CG, view: 'constructor' as never })).toEqual(cls({ view: 'other' }));
  });

  it('classes a slice by the smallest bound it fits under', () => {
    expect(QUERY_SCOPE_LIMIT_CANDIDATES).toEqual([1_000, 2_000, 5_000, 10_000, 20_000]);
    expect([0, 100, 101, 1_000, 1_001, 20_000, 20_001].map(sliceClass))
      .toEqual(['le_100', 'le_100', 'le_1000', 'le_1000', 'le_2000', 'le_20000', 'gt_20000']);
  });
});

describe('the meter of one query', () => {
  const graphs = (count: number, from = 0) => Array.from({ length: count }, (_, n) => `urn:graph:${from + n}`);

  it('times only the reads of its caller lane, and records once when the answer fails', async () => {
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const answer = async (ms: number) => { clock += ms; return { type: 'bindings' as const, bindings: [] }; };
    const catalog = { query: () => answer(1_000), listGraphsByPrefix: async () => [] };
    const meter = new QueryScopeMeter(cls({ view: 'vm' }));
    const reads = meter.observe({ query: () => answer(30), listGraphsByPrefix: async () => [], catalog });
    try {
      await reads.catalog.query('internal');
      await reads.query('caller');
      meter.route(graphs(4));
      await expect(meter.settle(Promise.reject(new Error('no answer')))).rejects.toThrow('no answer');
    } finally { now.mockRestore(); }
    expect(meters()).toEqual([
      { metric: REQUESTS, value: 1, attributes: cls({ view: 'vm' }) },
      { metric: SLICE, value: 4, attributes: { route: 'view', graph: 'none' } },
      { metric: STORE_MS, value: 30, attributes: { route: 'view', graph: 'none', slice: 'le_100' } },
    ]);
  });

  it('counts the distinct graphs of every list it routes, and each candidate limit they exceed', async () => {
    const meter = new QueryScopeMeter(cls({ route: 'legacy', graph: 'variable' }));
    const shared = graphs(600);
    meter.route(shared);
    meter.route(shared);
    meter.route(graphs(1_000, 401));
    await meter.settle(Promise.resolve(null));
    expect(named(SLICE)).toEqual([{ metric: SLICE, value: 1_401, attributes: { route: 'legacy', graph: 'variable' } }]);
    expect(named(OVER_LIMIT)).toEqual([
      { metric: OVER_LIMIT, value: 1, attributes: { route: 'legacy', graph: 'variable', limit: '1000' } },
    ]);
    // No read reached the store.
    expect(named(STORE_MS)).toEqual([]);

    telemetry.points.length = 0;
    const atLimit = new QueryScopeMeter(cls({}));
    atLimit.route(graphs(1_000));
    await atLimit.settle(Promise.resolve(null));
    expect(named(OVER_LIMIT)).toEqual([]);
  });
});

describe('the query engine', () => {
  it('meters each view by its slice, with store time for the caller read only', async () => {
    // [options, labels, graphs routed, rows]: the view's root graph counts in its slice.
    const cases: Array<[QueryOptions, QueryScopeClass, number, number]> = [
      [{ contextGraphId: CG, view: 'verifiable-memory' }, cls({ view: 'vm' }), 1 + vmGraphs.length, 1 + vmGraphs.length],
      [{ contextGraphId: CG, view: 'shared-working-memory' }, cls({ view: 'swm' }), 1 + swmGraphs.length, swmGraphs.length],
      [{ contextGraphId: CG, view: 'working-memory', agentAddress: AGENT }, cls({ view: 'wm' }), wmGraphs.length, wmGraphs.length],
    ];
    for (const [options, expected, sliceGraphs, rows] of cases) {
      telemetry.points.length = 0;
      expect((await engine.query(QUERY, options)).bindings).toHaveLength(rows);
      expect(named(REQUESTS)).toEqual([{ metric: REQUESTS, value: 1, attributes: expected }]);
      expect(named(SLICE)).toEqual([{ metric: SLICE, value: sliceGraphs, attributes: { route: 'view', graph: 'none' } }]);
      const [storeTime, ...more] = named(STORE_MS);
      expect(more).toEqual([]);
      expect(storeTime!.attributes).toEqual({ route: 'view', graph: 'none', slice: 'le_100' });
      expect(storeTime!.value).toBeGreaterThanOrEqual(0);
      expect(named(OVER_LIMIT)).toEqual([]);
    }
  });

  it('labels a read of explicit graphs apart, and counts the set its route authorizes', async () => {
    const answer = await engine.query(`SELECT ?name WHERE { GRAPH <${vmGraphs[0]}> { ?s <${NAME}> ?name } }`,
      { contextGraphId: CG, view: 'verifiable-memory' });
    expect(answer.bindings).toEqual([{ name: '"item 10"' }]);
    expect(named(REQUESTS)).toEqual([{ metric: REQUESTS, value: 1, attributes: cls({ view: 'vm', graph: 'explicit' }) }]);
    expect(named(SLICE)).toEqual([{ metric: SLICE, value: 1 + vmGraphs.length, attributes: { route: 'view', graph: 'explicit' } }]);
    expect(named(STORE_MS).map(({ attributes }) => attributes)).toEqual([{ route: 'view', graph: 'explicit', slice: 'le_100' }]);
  });

  it('meters the legacy route by the graphs it routes, across data and shared memory', async () => {
    await engine.query(QUERY, { contextGraphId: CG });
    expect(named(REQUESTS)).toEqual([{ metric: REQUESTS, value: 1, attributes: cls({ route: 'legacy' }) }]);
    expect(named(SLICE)).toEqual([{ metric: SLICE, value: 1 + vmGraphs.length, attributes: { route: 'legacy', graph: 'none' } }]);

    telemetry.points.length = 0;
    await engine.query(QUERY, { contextGraphId: CG, includeSharedMemory: true });
    expect(named(SLICE)).toEqual([{
      metric: SLICE, value: 1 + vmGraphs.length + swmGraphs.length, attributes: { route: 'legacy', graph: 'none' },
    }]);
    expect(named(STORE_MS)).toHaveLength(1);

    telemetry.points.length = 0;
    await engine.query('SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o } }', { contextGraphId: CG });
    const [slice] = named(SLICE);
    expect(slice).toMatchObject({ attributes: { route: 'legacy', graph: 'variable' } });
    expect(slice!.value).toBeGreaterThan(0);

    // A context graph with no content graph: the route reads its root graph alone.
    telemetry.points.length = 0;
    await engine.query(QUERY, { contextGraphId: 'scope-meters-empty' });
    expect(named(SLICE)).toEqual([{ metric: SLICE, value: 1, attributes: { route: 'legacy', graph: 'none' } }]);
  });

  it('counts an unscoped query and records no slice for it', async () => {
    await engine.query(QUERY);
    expect(meters()).toEqual([{ metric: REQUESTS, value: 1, attributes: cls({ route: 'unscoped' }) }]);
  });

  it('records an empty slice without store time when a view routes no graph', async () => {
    const answer = await engine.query(QUERY, { contextGraphId: 'scope-meters-empty', view: 'working-memory', agentAddress: AGENT });
    expect(answer.bindings).toEqual([]);
    expect(meters()).toEqual([
      { metric: REQUESTS, value: 1, attributes: cls({ view: 'wm' }) },
      { metric: SLICE, value: 0, attributes: { route: 'view', graph: 'none' } },
    ]);
  });

  it('counts a slice over each candidate limit it exceeds, and refuses nothing', async () => {
    const answer = await engine.query(QUERY, { contextGraphId: LARGE_CG, view: 'shared-working-memory' });
    expect(answer.bindings).toHaveLength(LARGE_SWM_GRAPHS);
    expect(named(SLICE)).toEqual([{ metric: SLICE, value: 1 + LARGE_SWM_GRAPHS, attributes: { route: 'view', graph: 'none' } }]);
    expect(named(STORE_MS).map(({ attributes }) => attributes)).toEqual([{ route: 'view', graph: 'none', slice: 'le_5000' }]);
    expect(named(OVER_LIMIT)).toEqual(['1000', '2000'].map(limit => ({
      metric: OVER_LIMIT, value: 1, attributes: { route: 'view', graph: 'none', limit },
    })));
    for (const { attributes } of meters()) {
      expect(JSON.stringify(attributes)).not.toMatch(/did:dkg|scope-meters/);
    }
  });

  it('records a query whose store read fails, and passes the failure on unchanged', async () => {
    const failure = new Error('the store went away');
    const marker = 'urn:scope-meters:caller';
    const failing = new Proxy(store, {
      get(target, key) {
        if (key === 'query') {
          return async (sparql: string, options: Parameters<TripleStore['query']>[1]) => {
            if (sparql.includes(marker)) throw failure;
            return target.query(sparql, options);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(new DKGQueryEngine(failing).query(`SELECT ?s WHERE { ?s <${marker}> ?o }`,
      { contextGraphId: CG, view: 'verifiable-memory' })).rejects.toBe(failure);
    expect(named(REQUESTS)).toHaveLength(1);
    expect(named(SLICE)).toEqual([{ metric: SLICE, value: 1 + vmGraphs.length, attributes: { route: 'view', graph: 'none' } }]);
    expect(named(STORE_MS)).toHaveLength(1);
  });

  it('answers as before when recording a meter fails', async () => {
    const expected = await engine.query(QUERY, { contextGraphId: CG, view: 'verifiable-memory' });
    telemetry.failing = true;
    telemetry.points.length = 0;
    expect(await engine.query(QUERY, { contextGraphId: CG, view: 'verifiable-memory' })).toEqual(expected);
    await expect(engine.query(`SELECT ?s WHERE { GRAPH <${ROOT}/_meta> { ?s ?p ?o } }`, { contextGraphId: CG }))
      .resolves.toMatchObject({ bindings: [] });
    expect(meters()).toEqual([]);
  });
});
