import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ASSERTION_NAMED_GRAPH_PREFIX, assertionLifecycleUri, contextGraphAssertionUri, contextGraphLayerUri,
  contextGraphVerifiableMemoryMetaUri, MemoryLayer, TrustLevel,
} from '@origintrail-official/dkg-core';
import { prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { BlazegraphStore, GraphSetIndexStore, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import {
  ExplicitGraphMembershipCheck, explicitGraphTargets, laneOverNamedGraphs, readStoredGraphs,
} from '../src/explicit-graph-membership.js';
import { prepareGraphScope } from '../src/sparql-graph-scope.js';
import { QueryMaterializationBudget } from '../src/query-store-read-context.js';
import type { QueryOptions } from '../src/query-engine.js';

// Runs on embedded Oxigraph; set BLAZEGRAPH_TEST_URL to run the same cases on a Blazegraph server.
const endpoint = process.env.BLAZEGRAPH_TEST_URL;
// A live server answers each request in milliseconds, not microseconds: give the per-caller sweeps room.
const SWEEP_TIMEOUT = endpoint ? 180_000 : 20_000;

function scope(source: string) {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error('Expected valid test input');
  return prepareGraphScope(prepared);
}

describe('explicitGraphTargets', () => {
  it.each([
    ['one GRAPH clause', 'SELECT * WHERE { GRAPH <urn:a> { ?s ?p ?o } }', ['urn:a']],
    ['clauses in OPTIONAL and UNION, once each', `SELECT * WHERE { GRAPH <urn:a> { ?s ?p ?o }
      OPTIONAL { GRAPH <urn:b> { ?s ?q ?r } } { GRAPH <urn:a> { ?s ?x ?y } } UNION { GRAPH <urn:c> { ?s ?x ?y } } }`,
    ['urn:a', 'urn:b', 'urn:c']],
    ['a prefixed graph name', 'PREFIX g: <urn:g:> ASK { GRAPH g:a { ?s ?p ?o } }', ['urn:g:a']],
    ['an aggregate', 'SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:a> { ?s ?p ?o } }', ['urn:a']],
    ['CONSTRUCT', 'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <urn:a> { ?s ?p ?o } }', ['urn:a']],
  ])('lists the graphs of %s', (_name, sparql, graphs) => {
    expect(explicitGraphTargets(scope(sparql))).toEqual(graphs);
  });

  it.each([
    ['no GRAPH clause', 'SELECT * WHERE { ?s ?p ?o }'],
    ['a graph variable', 'SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }'],
    ['a graph variable beside an IRI', 'SELECT * WHERE { GRAPH <urn:a> { ?s ?p ?o } GRAPH ?g { ?s ?q ?r } }'],
    ['a default-graph pattern', 'SELECT * WHERE { ?s ?p ?o . GRAPH <urn:a> { ?s ?q ?r } }'],
    ['a default-graph read in the projection', 'SELECT ?s (EXISTS { ?s ?p ?o } AS ?e) WHERE { GRAPH <urn:a> { ?s ?q ?r } }'],
    ['DESCRIBE', 'DESCRIBE ?s WHERE { GRAPH <urn:a> { ?s ?p ?o } }'],
  ])('is null for %s', (_name, sparql) => {
    expect(explicitGraphTargets(scope(sparql))).toBeNull();
  });
});

describe('readStoredGraphs and laneOverNamedGraphs', () => {
  const quadIn = (graph: string): Quad => ({ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph });

  it('finds the named graphs the store holds, by lookup, in batches', async () => {
    const store = new OxigraphStore();
    const held = Array.from({ length: 300 }, (_, index) => `urn:held:${index}`);
    await store.insert(held.map(quadIn));
    const query = vi.spyOn(store, 'query');
    const stored = await readStoredGraphs(store, [...held, 'urn:absent:1', 'urn:absent:2']);
    expect(stored.sort()).toEqual([...held].sort());
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every(([sparql]) => !sparql.includes('STRSTARTS'))).toBe(true);
    expect((await readStoredGraphs(store, held.slice(0, 3), graph => graph !== 'urn:held:1')).sort()).toEqual(['urn:held:0', 'urn:held:2']);
    expect(await readStoredGraphs(store, [])).toEqual([]);
    await store.close();
  });

  it('refuses a lookup answer that is not a SELECT result', async () => {
    await expect(readStoredGraphs({ query: async () => ({ type: 'boolean' as const, value: true }) }, ['urn:a']))
      .rejects.toThrow('graph lookup expected SELECT bindings');
  });

  it('lists the named graphs the store holds under a prefix, looking each up once', async () => {
    const store = new OxigraphStore();
    await store.insert(['urn:a/1', 'urn:a/12', 'urn:b/1'].map(quadIn));
    const query = vi.spyOn(store, 'query');
    const reads = { query: (sparql: string) => store.query(sparql), listGraphsByPrefix: async () => [] };
    const lane = laneOverNamedGraphs(['urn:a/1', 'urn:a/12', 'urn:a/2', 'urn:b/1', 'urn:c/1'], reads, graph => graph !== 'urn:b/1');
    expect(await lane.listGraphsByPrefix('urn:a/')).toEqual(['urn:a/1', 'urn:a/12']);
    expect(await lane.listGraphsByPrefix('urn:a/1')).toEqual(['urn:a/1', 'urn:a/12']);
    expect(await lane.listGraphsByPrefix('urn:b/')).toEqual([]);
    expect(lane.query).toBe(reads.query);
    // urn:a/* once, urn:b/1 once; urn:c/1 falls under no listed prefix and is never looked up.
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some(([sparql]) => sparql.includes('urn:c/1'))).toBe(false);
    await store.close();
  });
});

describe('ExplicitGraphMembershipCheck', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts the graphs both ways judged alike', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = new ExplicitGraphMembershipCheck();
    await check.compare('test route', ['urn:a', 'urn:b'], ['urn:a', 'urn:c'], async () => ['urn:a']);
    expect(check.snapshot()).toEqual({ checked: 2, disagreed: 0, failed: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts and logs a disagreement in either direction, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = new ExplicitGraphMembershipCheck();
    await check.compare('test route', ['urn:a', 'urn:b'], ['urn:a'], async () => ['urn:b']);
    expect(check.snapshot()).toEqual({ checked: 2, disagreed: 2, failed: 0 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('disagrees with the enumeration on the test route: <urn:a> enumerated=true member=false');
    expect(warn.mock.calls[1][0]).toContain('<urn:b> enumerated=false member=true (2 of 2 graphs so far)');
  });

  it('counts a check that cannot run without failing the query', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = new ExplicitGraphMembershipCheck();
    await check.compare('test route', ['urn:a'], ['urn:a'], async () => { throw new Error('store unavailable'); });
    await check.compare('test route', ['urn:a'], ['urn:a'], async () => { throw 'plain'; });
    expect(check.snapshot()).toEqual({ checked: 0, disagreed: 0, failed: 2 });
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      expect.stringContaining('failed on the test route (1 so far): store unavailable'),
      expect.stringContaining('failed on the test route (2 so far): plain'),
    ]);
  });

  it('logs the first twenty disagreements, then at each power of two', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = new ExplicitGraphMembershipCheck();
    const graphs = Array.from({ length: 33 }, (_, index) => `urn:g:${index}`);
    await check.compare('test route', graphs, graphs, async () => []);
    expect(check.snapshot().disagreed).toBe(33);
    expect(warn).toHaveBeenCalledTimes(21);
    expect(warn.mock.calls[20][0]).toContain('(32 of 32 graphs so far)');
  });
});

const id = `explicit-graphs-${randomUUID()}`;
const ROOT = `did:dkg:context-graph:${id}`;
const OTHER_ID = `${id}-b`;
const OTHER = `did:dkg:context-graph:${OTHER_ID}`;
const SUB = 'team';
const AGENT = '0x1111111111111111111111111111111111111111';
const OTHER_AGENT = '0x2222222222222222222222222222222222222222';
const ALIAS = '12D3KooWExplicitGraphAlias';
const wm = (agent: string, number: number, cg = id, sub?: string) => contextGraphLayerUri(cg, MemoryLayer.WorkingMemory, agent, number, sub);
const DRAFT = contextGraphAssertionUri(id, AGENT, 'draft');

/** Graphs that hold one triple each, across both context graphs and every partition kind. */
const HELD = [
  ROOT, `${ROOT}/_meta`, `${ROOT}/_shared_memory_meta`, `${ROOT}/_private`, `${ROOT}/_rules`,
  `${ROOT}/_verifiable_memory/${AGENT}/1`, contextGraphVerifiableMemoryMetaUri(id, `${AGENT}/1`),
  `${ROOT}/_verifiable_memory/v1`, `${ROOT}/_verifiable_memory/staging/1`,
  `${ROOT}/_shared_memory`, `${ROOT}/_shared_memory/${AGENT}/1`, `${ROOT}/_shared_memory/staging/1`,
  wm(AGENT, 1), wm(OTHER_AGENT, 1), wm(ALIAS, 1), wm(AGENT, 7),
  DRAFT, `${DRAFT}${ASSERTION_NAMED_GRAPH_PREFIX}notes`, contextGraphAssertionUri(id, OTHER_AGENT, 'draft'),
  `${ROOT}/${SUB}`, `${ROOT}/${SUB}/_verifiable_memory/${AGENT}/2`, `${ROOT}/${SUB}/_shared_memory`,
  `${ROOT}/${SUB}/_shared_memory/${AGENT}/2`, `${ROOT}/${SUB}/_meta`, `${ROOT}/${SUB}/_private`, wm(AGENT, 2, id, SUB),
  `${ROOT}/loose`, `${ROOT}/loose/_verifiable_memory/${AGENT}/3`, `${ROOT}/loose/_shared_memory/${AGENT}/3`,
  `${ROOT}/child`, `${ROOT}/child/_verifiable_memory/${AGENT}/4`, `${ROOT}/child/_shared_memory/${AGENT}/4`, `${ROOT}/child/_meta`,
  `${ROOT}/context/42`, `${ROOT}/context/42/_private`,
  OTHER, `${OTHER}/_meta`, `${OTHER}/_private`, `${OTHER}/_verifiable_memory/${AGENT}/1`, `${OTHER}/_shared_memory/${AGENT}/1`,
  wm(AGENT, 1, OTHER_ID), `urn:graph:${id}:outside`,
];
/** Names of graphs the store does not hold, inside and outside each route's families. */
const ABSENT = [
  `${ROOT}/_verifiable_memory/${AGENT}/999`, `${ROOT}/_verifiable_memory/v2`, `${ROOT}/_shared_memory/${AGENT}/999`,
  wm(AGENT, 999), `${ROOT}/${SUB}/_verifiable_memory/${AGENT}/999`, `${ROOT}/context/999`,
  contextGraphAssertionUri(id, AGENT, 'missing'),
];
// `child` is registered both as a sub-graph and as a child context graph: the child's graphs stay out.
const REGISTRATIONS: Quad[] = [
  ...[SUB, 'child'].flatMap((name): Quad[] => [
    { subject: `${ROOT}/${name}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${ROOT}/_meta` },
    { subject: `${ROOT}/${name}`, predicate: 'http://schema.org/name', object: `"${name}"`, graph: `${ROOT}/_meta` },
  ]),
  { subject: assertionLifecycleUri(id, AGENT, 'numbered'), predicate: 'http://dkg.io/ontology/kaId', object: '"7"', graph: `${ROOT}/_meta` },
  { subject: `${ROOT}/child`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#ContextGraph', graph: `${ROOT}/child/_meta` },
];

const CALLERS: readonly (readonly [string, Omit<QueryOptions, 'contextGraphId'>])[] = [
  ['the verifiable-memory view', { view: 'verifiable-memory' }],
  ['the verifiable-memory view of a sub-graph', { view: 'verifiable-memory', subGraphName: SUB }],
  ['the verifiable-memory view of one graph', { view: 'verifiable-memory', verifiedGraph: 'v1' }],
  ['the verifiable-memory view with a trust floor', { view: 'verifiable-memory', minTrust: TrustLevel.Endorsed }],
  ['the shared-working-memory view', { view: 'shared-working-memory' }],
  ['the shared-working-memory view of a sub-graph', { view: 'shared-working-memory', subGraphName: SUB }],
  ['the working-memory view', { view: 'working-memory', agentAddress: AGENT }],
  ['the working-memory view with an alias', { view: 'working-memory', agentAddress: AGENT, agentAddressAliases: [ALIAS] }],
  ['the working-memory view of a sub-graph', { view: 'working-memory', agentAddress: AGENT, subGraphName: SUB }],
  ['a working-memory read by name', { view: 'working-memory', agentAddress: AGENT, assertionName: 'draft' }],
  ['a working-memory read by a numbered name', { view: 'working-memory', agentAddress: AGENT, assertionName: 'numbered' }],
  ['a working-memory read by a name with no graph', { view: 'working-memory', agentAddress: AGENT, assertionName: 'missing' }],
  ['the data route', {}],
  ['the data route of a sub-graph', { subGraphName: SUB }],
  ['the shared-memory route', { graphSuffix: '_shared_memory' }],
  ['data and shared memory together', { includeSharedMemory: true }],
  ['the data route with private data', { includePrivate: true }],
  ['a sub-graph route with private data', { includePrivate: true, subGraphName: SUB }],
];

interface Verdict { readonly route: string; readonly graph: string; readonly enumerated: boolean; readonly member: boolean }

/** Record both judgements of every compared graph, then let the check count them as usual. */
// Taken once, so a spy left by an earlier test is never mistaken for the real method.
const realCompare = ExplicitGraphMembershipCheck.prototype.compare;

function recordVerdicts(verdicts: Verdict[]) {
  return vi.spyOn(ExplicitGraphMembershipCheck.prototype, 'compare').mockImplementation(async function (
    this: ExplicitGraphMembershipCheck, route, graphs, enumerated, members,
  ) {
    const judged = new Set(await members());
    for (const graph of graphs) verdicts.push({ route, graph, enumerated: enumerated.includes(graph), member: judged.has(graph) });
    return realCompare.call(this, route, graphs, enumerated, async () => [...judged]);
  });
}

async function ask(engine: DKGQueryEngine, graph: string, options: QueryOptions) {
  try {
    const result = await engine.query(`SELECT ?s ?o WHERE { GRAPH <${graph}> { ?s <urn:p> ?o } }`, options);
    return result.bindings.length > 0 ? 'rows' : 'empty';
  } catch (error) {
    if (error instanceof Error && error.name === 'ScopedQueryViolationError') return 'refused';
    throw error;
  }
}

describe.each([
  ['the store', (inner: TripleStore) => inner],
  ['the graph catalog over the store', (inner: TripleStore) => new GraphSetIndexStore(inner)],
])('explicit graphs on %s: the membership check agrees with the enumeration', (_name, wrap) => {
  let store: TripleStore;
  let engine: DKGQueryEngine;
  const data: Quad[] = [...HELD.map((graph, index) => ({ subject: `urn:held:${index}`, predicate: 'urn:p', object: '"v"', graph })), ...REGISTRATIONS];

  beforeAll(async () => {
    store = wrap(endpoint ? new BlazegraphStore(endpoint, { timeout: 20_000 }) : new OxigraphStore());
    await store.insert(data);
    engine = new DKGQueryEngine(store);
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    if (endpoint) for (const graph of new Set(data.map(item => item.graph))) await store.dropGraph(graph).catch(() => {});
    await store.close().catch(() => {});
  });

  it.each(CALLERS)('for every graph of the fixture on %s', async (_caller, callerOptions) => {
    const options: QueryOptions = { contextGraphId: id, ...callerOptions };
    const verdicts: Verdict[] = [];
    const spy = recordVerdicts(verdicts);
    // The trust floor declines GRAPH clauses with a warning of its own.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = engine.explicitGraphMembershipCounts();
    const answers = new Map<string, string>();
    for (const graph of [...HELD, ...ABSENT]) answers.set(graph, await ask(engine, graph, options));
    const logged = warn.mock.calls.map(([line]) => String(line));
    spy.mockRestore();
    warn.mockRestore();

    expect(verdicts.filter(verdict => verdict.enumerated !== verdict.member)).toEqual([]);
    expect(verdicts.some(verdict => verdict.member) && verdicts.some(verdict => !verdict.member)).toBe(true);
    expect(logged.filter(line => line.includes('membership check'))).toEqual([]);
    const after = engine.explicitGraphMembershipCounts();
    expect(after.disagreed).toBe(before.disagreed);
    expect(after.failed).toBe(before.failed);
    expect(after.checked - before.checked).toBe(verdicts.length);
    // A graph judged a non-member never answers with a row.
    for (const { graph, member } of verdicts) {
      if (!member) expect(answers.get(graph), graph).not.toBe('rows');
    }
    expect(answers.get(`${OTHER}/_verifiable_memory/${AGENT}/1`)).not.toBe('rows');
    expect(answers.get(`${ROOT}/child/_verifiable_memory/${AGENT}/4`)).not.toBe('rows');
  }, SWEEP_TIMEOUT);

  it('judges graphs inside and outside a route, and absent graphs, the same way', async () => {
    const verdicts: Verdict[] = [];
    const spy = recordVerdicts(verdicts);
    for (const graph of [`${ROOT}/_verifiable_memory/${AGENT}/1`, `${ROOT}/_verifiable_memory/${AGENT}/999`,
      `${ROOT}/${SUB}/_verifiable_memory/${AGENT}/2`, `${ROOT}/child/_verifiable_memory/${AGENT}/4`, `${ROOT}/context/42`]) {
      await ask(engine, graph, { contextGraphId: id, view: 'verifiable-memory' });
    }
    spy.mockRestore();
    expect(verdicts.map(({ graph, member }) => [graph.slice(ROOT.length), member])).toEqual([
      [`/_verifiable_memory/${AGENT}/1`, true],
      [`/_verifiable_memory/${AGENT}/999`, false],
      [`/${SUB}/_verifiable_memory/${AGENT}/2`, true],
      [`/child/_verifiable_memory/${AGENT}/4`, false],
      ['/context/42', true],
    ]);
  });

  it('leaves queries the check does not cover alone', async () => {
    const before = engine.explicitGraphMembershipCounts();
    const view: QueryOptions = { contextGraphId: id, view: 'verifiable-memory' };
    await engine.query('SELECT ?s WHERE { GRAPH ?g { ?s <urn:p> ?o } }', view);
    // A default-graph pattern beside the GRAPH clause is answered; it reads no named graph alone.
    const mixed = await engine.query(`SELECT ?s WHERE { ?s <urn:p> ?o . GRAPH <${ROOT}> { ?s <urn:p> ?o } }`, view);
    expect(Array.isArray(mixed.bindings)).toBe(true);
    // A description with a GRAPH clause is answered on Oxigraph and refused, before any read, on Blazegraph.
    const described = engine.query(`DESCRIBE ?s WHERE { GRAPH <${ROOT}> { ?s <urn:p> ?o } }`, view);
    if (endpoint) await expect(described).rejects.toThrow('DESCRIBE cannot be combined with a GRAPH clause');
    else expect(Array.isArray((await described).quads)).toBe(true);
    // The route's own graphs are allowed without listing anything, so there is nothing to compare.
    await engine.query(`SELECT ?s WHERE { GRAPH <${ROOT}/_meta> { ?s <urn:p> ?o } }`, { contextGraphId: id });
    expect(engine.explicitGraphMembershipCounts()).toEqual(before);
  });
});

describe('the membership check never changes an answer', () => {
  const GRAPH = `${ROOT}/_verifiable_memory/${AGENT}/1`;
  const options: QueryOptions = { contextGraphId: id, view: 'verifiable-memory' };
  let inner: OxigraphStore;

  beforeAll(async () => {
    inner = new OxigraphStore();
    await inner.insert([{ subject: 'urn:held:1', predicate: 'urn:p', object: '"v"', graph: GRAPH }]);
  });
  afterAll(async () => { await inner.close(); });
  afterEach(() => vi.restoreAllMocks());

  /** The store as the engine sees it, with some of its members replaced. */
  const over = (replace: Record<string, unknown>) => new Proxy(inner, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(replace, property)) return replace[property as string];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as TripleStore;

  it('when its lookup fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new DKGQueryEngine(over({
      query: (sparql: string, queryOptions?: unknown) => sparql.includes('VALUES ?graph')
        ? Promise.reject(new Error('lookup unavailable')) : inner.query(sparql, queryOptions as never),
    }));
    const result = await engine.query(`SELECT ?s WHERE { GRAPH <${GRAPH}> { ?s <urn:p> ?o } }`, options);
    expect(result.bindings).toEqual([{ s: 'urn:held:1' }]);
    expect(engine.explicitGraphMembershipCounts()).toEqual({ checked: 0, disagreed: 0, failed: 1 });
  });

  it.each([
    ['the verifiable-memory view', options],
    ['the data route', { contextGraphId: id }],
  ] as const)('on %s, when the caller budget has no room to spare', async (_route, routeOptions) => {
    const engine = new DKGQueryEngine(inner);
    const sparql = `SELECT ?s WHERE { GRAPH <${GRAPH}> { ?s <urn:p> ?o } }`;
    const charged = async (check: boolean) => {
      const off = check ? undefined : vi.spyOn(ExplicitGraphMembershipCheck.prototype, 'compare').mockResolvedValue(undefined);
      const budget = new QueryMaterializationBudget(Number.MAX_SAFE_INTEGER);
      await engine.query(sparql, { ...routeOptions, materializationBudget: budget });
      off?.mockRestore();
      return (budget as unknown as { usedBytes: number }).usedBytes;
    };
    const alone = await charged(false);
    const before = engine.explicitGraphMembershipCounts().checked;
    expect(await charged(true)).toBe(alone);
    expect(engine.explicitGraphMembershipCounts().checked).toBe(before + 1);
    const result = await engine.query(sparql, { ...routeOptions, maxMaterializedBytes: alone });
    expect(result.bindings).toEqual([{ s: 'urn:held:1' }]);
  });

  it('reads the registry once per request, and the child fence after each listing', async () => {
    const sent: string[] = [];
    const engine = new DKGQueryEngine(over({
      query: (sparql: string, queryOptions?: unknown) => { sent.push(sparql); return inner.query(sparql, queryOptions as never); },
    }));
    const count = (marker: string) => sent.filter(sparql => sparql.includes(marker)).length;
    await engine.query(`SELECT ?s WHERE { GRAPH <${GRAPH}> { ?s <urn:p> ?o } }`, options);
    expect([count('ontology/SubGraph'), count('ontology#ContextGraph')]).toEqual([1, 2]);
    sent.length = 0;
    // No KA number is stamped here, so the named graph is outside the read; the check runs before the refusal.
    await expect(engine.query(`SELECT ?s WHERE { GRAPH <${wm(AGENT, 7)}> { ?s <urn:p> ?o } }`,
      { contextGraphId: id, view: 'working-memory', agentAddress: AGENT, assertionName: 'numbered' }))
      .rejects.toThrow('outside the allowed graph set');
    expect([count('ontology/kaId'), count('ontology#ContextGraph')]).toEqual([1, 2]);
    expect(engine.explicitGraphMembershipCounts()).toMatchObject({ checked: 2, disagreed: 0, failed: 0 });
  });

  it('when the caller has aborted before the check starts', async () => {
    let lookups = 0;
    const engine = new DKGQueryEngine(over({
      query: (sparql: string, queryOptions?: unknown) => {
        if (sparql.includes('VALUES ?graph')) lookups++;
        return inner.query(sparql, queryOptions as never);
      },
    }));
    const controller = new AbortController();
    // The caller aborts after discovery, just as the check starts.
    const compare = vi.spyOn(ExplicitGraphMembershipCheck.prototype, 'compare').mockImplementation(function (this: ExplicitGraphMembershipCheck, ...args) {
      controller.abort(new Error('caller stopped'));
      return realCompare.apply(this, args);
    });
    let compared = 0;
    try {
      await engine.query(`SELECT ?s WHERE { GRAPH <${GRAPH}> { ?s <urn:p> ?o } }`, { ...options, signal: controller.signal }).catch(() => undefined);
    } finally {
      compared = compare.mock.calls.length;
      compare.mockRestore();
    }
    expect(compared).toBe(1);
    expect(lookups).toBe(0);
    expect(engine.explicitGraphMembershipCounts()).toEqual({ checked: 0, disagreed: 0, failed: 0 });
  });

  it('when the caller aborts while the check waits on the store', async () => {
    let lookups = 0;
    let lookupSignal: AbortSignal | undefined;
    let lookupEnded = false;
    const engine = new DKGQueryEngine(over({
      query: (sparql: string, queryOptions?: { signal?: AbortSignal }) => {
        if (!sparql.includes('VALUES ?graph')) return inner.query(sparql, queryOptions as never);
        lookups++;
        lookupSignal = queryOptions?.signal;
        // A lookup that never answers on its own: only the caller's abort ends it.
        return new Promise((_, reject) => queryOptions?.signal?.addEventListener('abort', () => {
          lookupEnded = true;
          reject(new Error('aborted'));
        }, { once: true }));
      },
    }));
    const controller = new AbortController();
    const pending = engine.query(`SELECT ?s WHERE { GRAPH <${GRAPH}> { ?s <urn:p> ?o } }`, { ...options, signal: controller.signal });
    await vi.waitFor(() => expect(lookups).toBe(1));
    controller.abort();
    const outcome = await Promise.race([
      pending.then(() => 'settled', () => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('still waiting'), 2_000)),
    ]);
    expect(outcome).toBe('settled');
    // The abort reaches the lookup itself: it gets a signal, which the caller's abort ends.
    expect(lookupSignal?.aborted).toBe(true);
    expect(lookupEnded).toBe(true);
    expect(engine.explicitGraphMembershipCounts()).toEqual({ checked: 0, disagreed: 0, failed: 0 });
  });

  it('when it disagrees with the enumeration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new DKGQueryEngine(over({ graphEnumerationVisibility: (graph: string) => graph !== GRAPH }));
    const result = await engine.query(`SELECT ?s WHERE { GRAPH <${GRAPH}> { ?s <urn:p> ?o } }`, options);
    expect(result.bindings).toEqual([{ s: 'urn:held:1' }]);
    expect(engine.explicitGraphMembershipCounts()).toEqual({ checked: 1, disagreed: 1, failed: 0 });
    expect(warn.mock.calls[0][0]).toContain(`on the verifiable-memory view: <${GRAPH}> enumerated=true member=false`);
  });
});
