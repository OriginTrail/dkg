import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contextGraphLayerUri, MemoryLayer, TRUST_LEVEL_PREDICATE, TrustLevel } from '@origintrail-official/dkg-core';
import { BlazegraphStore, OxigraphStore, SparqlHttpStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QueryHandler } from '../src/query-handler.js';
import type { QueryOptions, QueryResult } from '../src/query-engine.js';

// CI's tornado-blazegraph lane runs this file on a live server; elsewhere it runs on Oxigraph.
const endpoint = process.env.BLAZEGRAPH_TEST_URL;
if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !endpoint) throw new Error('Blazegraph CI endpoint is required');

const id = `graph-list-${randomUUID()}`;
const ROOT = `did:dkg:context-graph:${id}`;
const SUB = 'team';
const OTHER = `did:dkg:context-graph:${id}-unlisted`;
const SOLO_ID = `${id}-solo`;
const SOLO = `did:dkg:context-graph:${SOLO_ID}`;
const TRUST_ID = `${id}-trust`;
const TRUST_GRAPHS = [`did:dkg:context-graph:${TRUST_ID}`, `did:dkg:context-graph:${TRUST_ID}/_verifiable_memory/a/1`];
const AGENT = '0x1111111111111111111111111111111111111111';
const UNLISTED_GRAPHS = [`${OTHER}/_verifiable_memory/b/1`, `urn:unlisted-graph:${id}`];
const [L, A, B, NOTE] = ['urn:p:link', 'urn:p:a', 'urn:p:b', 'urn:p:note'];
const quad = (subject: string, predicate: string, object: string, graph: string): Quad => (
  { subject, predicate, object, graph }
);

// Two hops over L, and four alternating hops over A and B.
const chains = (prefix: string, graph: string): Quad[] => [
  quad(`${prefix}:1`, L, `${prefix}:2`, graph), quad(`${prefix}:2`, L, `${prefix}:3`, graph),
  quad(`${prefix}:s`, A, `${prefix}:m1`, graph), quad(`${prefix}:m1`, B, `${prefix}:m2`, graph),
  quad(`${prefix}:m2`, A, `${prefix}:m3`, graph), quad(`${prefix}:m3`, B, `${prefix}:m4`, graph),
];

interface Route {
  readonly name: string;
  readonly options: QueryOptions;
  /** Each graph on the route's list, with the prefix of the terms it holds. */
  readonly graphs: readonly (readonly [graph: string, prefix: string])[];
  /** Some of the route's graphs are read through constant GRAPH branches. */
  readonly branches?: true;
}

const MAIN_GRAPHS = [[ROOT, 'urn:listed:root'], [`${ROOT}/_verifiable_memory/a/1`, 'urn:listed:vm']] as const;
const SUB_GRAPHS = [[`${ROOT}/${SUB}`, 'urn:listed:sub'], [`${ROOT}/${SUB}/_verifiable_memory/a/1`, 'urn:listed:subvm']] as const;
const SHARED_GRAPHS = [[`${ROOT}/_shared_memory/a/1`, 'urn:listed:ka1'], [`${ROOT}/_shared_memory/a/2`, 'urn:listed:ka2']] as const;
const ROUTES: readonly Route[] = [
  { name: 'the default route', options: { contextGraphId: id }, graphs: MAIN_GRAPHS },
  { name: 'the verifiable-memory view', options: { contextGraphId: id, view: 'verifiable-memory' }, graphs: MAIN_GRAPHS },
  { name: 'a sub-graph', options: { contextGraphId: id, subGraphName: SUB }, graphs: SUB_GRAPHS },
  { name: 'a sub-graph verifiable-memory view', options: { contextGraphId: id, subGraphName: SUB, view: 'verifiable-memory' }, graphs: SUB_GRAPHS },
  { name: 'the shared-working-memory view', options: { contextGraphId: id, view: 'shared-working-memory' },
    graphs: [[`${ROOT}/_shared_memory`, 'urn:listed:swm'], ...SHARED_GRAPHS] },
  { name: 'the working-memory view', options: { contextGraphId: id, view: 'working-memory', agentAddress: AGENT },
    graphs: [[contextGraphLayerUri(id, MemoryLayer.WorkingMemory, AGENT, 1), 'urn:listed:wm1'], [contextGraphLayerUri(id, MemoryLayer.WorkingMemory, AGENT, 2), 'urn:listed:wm2']] },
  { name: 'the shared-memory route', options: { contextGraphId: id, graphSuffix: '_shared_memory' }, graphs: SHARED_GRAPHS, branches: true },
  { name: 'data and shared memory together', options: { contextGraphId: id, includeSharedMemory: true },
    graphs: [...MAIN_GRAPHS, ...SHARED_GRAPHS], branches: true },
];
const MAIN_ROUTES = ROUTES.slice(0, 2);
const prefixesOf = (route: Route) => route.graphs.map(([, prefix]) => prefix);

const TRUSTED = `"${TrustLevel.ConsensusVerified}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
const data: Quad[] = [
  ...[...new Map(ROUTES.flatMap(route => route.graphs)).entries()].flatMap(([graph, prefix]) => [
    ...chains(prefix, graph),
    // What an unlisted graph says about a listed term: one more hop, and statements either side of it.
    quad(`${prefix}:3`, L, 'urn:unlisted:bridge', UNLISTED_GRAPHS[0]),
    quad(`${prefix}:1`, NOTE, '"unlisted-note"', UNLISTED_GRAPHS[0]),
    quad('urn:unlisted:about', NOTE, `${prefix}:1`, UNLISTED_GRAPHS[1]),
  ]),
  ...chains('urn:unlisted:a', UNLISTED_GRAPHS[0]),
  ...chains('urn:unlisted:b', UNLISTED_GRAPHS[1]),
  ...chains('urn:listed:solo', SOLO),
  quad('urn:listed:solo:1', NOTE, '"unlisted-note"', UNLISTED_GRAPHS[0]),
  ...chains('urn:listed:trust', TRUST_GRAPHS[0]),
  ...chains('urn:listed:trust2', TRUST_GRAPHS[1]),
  ...['urn:listed:trust:1', 'urn:listed:trust2:1'].map((subject, index) => quad(subject, TRUST_LEVEL_PREDICATE, TRUSTED, TRUST_GRAPHS[index])),
  quad('urn:unlisted:a:1', TRUST_LEVEL_PREDICATE, TRUSTED, UNLISTED_GRAPHS[0]),
  quad('urn:listed:trust:3', L, 'urn:unlisted:bridge', UNLISTED_GRAPHS[0]),
];

type Row = Record<string, string>;
const rows = (prefixes: readonly string[], ...pairs: readonly (readonly [string, string])[]): Row[] =>
  prefixes.flatMap(prefix => pairs.map(([s, o]) => ({ s: `${prefix}:${s}`, o: `${prefix}:${o}` })));
const bag = (items: readonly Row[]) => items.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort();
const fromUnlistedGraph = (item: unknown) => JSON.stringify(item).includes('unlisted');
const pairsOf = (prefixes: readonly string[], pairs: readonly (readonly [string, string])[]) => rows(prefixes, ...pairs);

interface PathForm {
  readonly name: string;
  readonly pattern: string;
  /** Rows every store returns, or null where zero-length matches are the store's own choice. */
  readonly pairs: readonly (readonly [string, string])[] | null;
}

const PLUS: readonly (readonly [string, string])[] = [['1', '2'], ['2', '3'], ['1', '3']];
const PATHS: readonly PathForm[] = [
  { name: '+', pattern: `?s <${L}>+ ?o`, pairs: PLUS },
  { name: '*', pattern: `?s <${L}>* ?o`, pairs: null },
  { name: '?', pattern: `?s <${L}>? ?o`, pairs: null },
  { name: '(a/b)+', pattern: `?s (<${A}>/<${B}>)+ ?o`, pairs: [['s', 'm2'], ['s', 'm4'], ['m2', 'm4']] },
  { name: '(a/b)*', pattern: `?s (<${A}>/<${B}>)* ?o`, pairs: null },
  { name: '(a|b)*', pattern: `?s (<${A}>|<${B}>)* ?o`, pairs: null },
  { name: '(a|b)+', pattern: `?s (<${A}>|<${B}>)+ ?o`, pairs: [
    ['s', 'm1'], ['s', 'm2'], ['s', 'm3'], ['s', 'm4'], ['m1', 'm2'], ['m1', 'm3'], ['m1', 'm4'], ['m2', 'm3'], ['m2', 'm4'], ['m3', 'm4'],
  ] },
  { name: 'a|b+', pattern: `?s <${A}>|<${B}>+ ?o`, pairs: [['s', 'm1'], ['m2', 'm3'], ['m1', 'm2'], ['m3', 'm4']] },
  { name: 'a/b+', pattern: `?s <${A}>/<${B}>+ ?o`, pairs: [['s', 'm2'], ['m2', 'm4']] },
  { name: '^a+', pattern: `?s ^<${L}>+ ?o`, pairs: [['2', '1'], ['3', '2'], ['3', '1']] },
  { name: '!a', pattern: `?s !<${L}> ?o`, pairs: [['s', 'm1'], ['m1', 'm2'], ['m2', 'm3'], ['m3', 'm4']] },
  { name: '!(a|b)', pattern: `?s !(<${A}>|<${B}>) ?o`, pairs: [['1', '2'], ['2', '3']] },
  { name: '!^a', pattern: `?s !^<${L}> ?o`, pairs: [['m1', 's'], ['m2', 'm1'], ['m3', 'm2'], ['m4', 'm3']] },
  { name: '(!a)+', pattern: `?s (!<${A}>)+ ?o`, pairs: [['1', '2'], ['2', '3'], ['1', '3'], ['m1', 'm2'], ['m3', 'm4']] },
];

describe(`reads scoped to a graph list on ${endpoint ? 'Blazegraph' : 'Oxigraph'}`, { timeout: 30_000 }, () => {
  let store: TripleStore;
  let engine: DKGQueryEngine;
  const read = (sparql: string, options: QueryOptions): Promise<QueryResult> => engine.query(sparql, options);
  const select = async (sparql: string, options: QueryOptions) => (await read(sparql, options)).bindings;
  const quadsOf = async (sparql: string, options: QueryOptions) => (await read(sparql, options)).quads ?? [];
  const ask = async (sparql: string, options: QueryOptions) => (await read(sparql, options)).bindings[0]?.result;

  beforeAll(async () => {
    store = endpoint ? new BlazegraphStore(endpoint, { timeout: 20_000 }) : new OxigraphStore();
    await store.insert(data);
    engine = new DKGQueryEngine(store);
  }, 30_000);

  afterAll(async () => {
    if (!store) return;
    for (const graph of new Set(data.map(item => item.graph))) await store.dropGraph(graph).catch(() => {});
    await store.close().catch(() => {});
  }, 30_000);

  describe.each(ROUTES)('$name', (route) => {
    const prefixes = prefixesOf(route);

    it.each(PATHS)('SELECT with $name stays on the list', async ({ name, pattern, pairs }) => {
      const sparql = `SELECT ?s ?o WHERE { ${pattern} }`;
      // Blazegraph doesn't accept this alternative inside a UNION branch.
      if (endpoint && route.branches && name === 'a|b+') {
        await expect(select(sparql, route.options)).rejects.toThrow(/query failed/);
        return;
      }
      const found = await select(sparql, route.options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
      if (pairs) expect(bag(found)).toEqual(bag(pairsOf(prefixes, pairs)));
    });

    it('zero-length forms keep their in-list matches', async () => {
      const found = await select(`SELECT ?s ?o WHERE { ?s <${L}>* ?o }`, route.options);
      expect(bag(found)).toEqual(expect.arrayContaining(bag(pairsOf(prefixes, PLUS))));
    });

    it('a path from a listed term stops where the list ends', async () => {
      const found = await select(`SELECT ?o WHERE { <${prefixes[0]}:1> <${L}>+ ?o }`, route.options);
      expect(bag(found)).toEqual(bag([{ o: `${prefixes[0]}:2` }, { o: `${prefixes[0]}:3` }]));
    });

    it('a path to an unlisted term matches nothing', async () => {
      expect(await select(`SELECT ?s WHERE { ?s <${L}>+ <urn:unlisted:bridge> }`, route.options)).toEqual([]);
    });

    it('two paths in one pattern stay on the list', async () => {
      const found = await select(`SELECT ?s ?m ?o WHERE { ?s <${L}>+ ?m . ?m <${L}>+ ?o }`, route.options);
      expect(bag(found)).toEqual(bag(prefixes.map(prefix => ({ s: `${prefix}:1`, m: `${prefix}:2`, o: `${prefix}:3` }))));
    });

    it.each([
      ['EXISTS', (from: string) => `?s <${L}> ?o FILTER EXISTS { ${from} <${L}>+ <urn:unlisted:bridge> }`, []],
      ['NOT EXISTS', (from: string) => `?s <${L}> ?o FILTER NOT EXISTS { ${from} <${L}>+ <urn:unlisted:bridge> }`, null],
      ['MINUS', (from: string) => `?s <${L}> ?o MINUS { ?s <${L}>+ <urn:unlisted:bridge> } FILTER(BOUND(${from}))`, null],
    ] as const)('a path inside %s sees only the list', async (_name, pattern, expected) => {
      const found = await select(`SELECT ?s ?o WHERE { ${pattern('?o')} }`, route.options);
      expect(bag(found)).toEqual(bag(expected ?? pairsOf(prefixes, [['1', '2'], ['2', '3']])));
    });

    it('a path inside OPTIONAL binds only listed terms', async () => {
      const found = await select(`SELECT ?s ?x WHERE { ?s <${L}> ?o OPTIONAL { ?o <${L}>+ ?x } }`, route.options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
    });

    it('an expression over a path sees only the list', async () => {
      const found = await select(`SELECT ?s ?hit WHERE { ?s <${L}> ?o BIND(EXISTS { <urn:unlisted:a:1> <${L}>+ ?z } AS ?hit) }`, route.options);
      expect(found.map(row => row.hit).filter(hit => hit !== undefined && !hit.includes('false'))).toEqual([]);
    });

    it.each([
      ['a triple', `SELECT ?s ?o WHERE { { SELECT ?s ?o WHERE { ?s <${L}> ?o } } }`, [['1', '2'], ['2', '3']]],
      ['a path', `SELECT ?s ?o WHERE { { SELECT ?s ?o WHERE { ?s <${L}>+ ?o } } }`, PLUS],
      ['DISTINCT', `SELECT ?s ?o WHERE { { SELECT DISTINCT ?s ?o WHERE { ?s <${L}> ?o } } }`, [['1', '2'], ['2', '3']]],
    ] as const)('a nested SELECT over %s stays on the list', async (_name, sparql, pairs) => {
      expect(bag(await select(sparql, route.options))).toEqual(bag(pairsOf(prefixes, pairs)));
    });

    it('a nested SELECT over every triple stays on the list', async () => {
      const found = await select('SELECT ?s ?p ?o WHERE { { SELECT ?s ?p ?o WHERE { ?s ?p ?o } } }', route.options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
      expect(found).toHaveLength(prefixes.length * chains('x', 'y').length);
    });

    it('SELECT * over a nested SELECT stays on the list', async () => {
      const found = await select('SELECT * WHERE { { SELECT * WHERE { ?s ?p ?o } } }', route.options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
      expect(Object.keys(found[0] ?? {}).filter(name => name.startsWith('__'))).toEqual([]);
    });

    it('a nested count covers only the list', async () => {
      const found = await select(`SELECT ?c WHERE { { SELECT (COUNT(*) AS ?c) WHERE { ?s <${L}> ?o } } }`, route.options);
      const counts = found.map(row => Number(/^"(\d+)"/.exec(row.c!)?.[1]));
      // Each constant GRAPH branch counts its own graph; a graph variable covers the whole list at once.
      if (route.branches) expect(Math.max(...counts)).toBeLessThanOrEqual(prefixes.length * 2);
      else expect(counts).toEqual([prefixes.length * 2]);
    });

    it.each([
      ['EXISTS', `?s <${L}> ?o FILTER EXISTS { { SELECT ?z WHERE { <urn:unlisted:a:1> <${L}> ?z } } }`, []],
      ['NOT EXISTS', `?s <${L}> ?o FILTER NOT EXISTS { { SELECT ?z WHERE { <urn:unlisted:a:1> <${L}> ?z } } }`, null],
      ['OPTIONAL', `?s <${L}> ?o OPTIONAL { { SELECT ?z WHERE { <urn:unlisted:a:1> <${L}> ?z } } }`, null],
    ] as const)('a nested SELECT inside %s sees only the list', async (_name, pattern, expected) => {
      const found = await select(`SELECT ?s ?o ?z WHERE { ${pattern} }`, route.options);
      expect(bag(found)).toEqual(bag(expected ?? pairsOf(prefixes, [['1', '2'], ['2', '3']])));
    });

    it('ASK answers from the list alone', async () => {
      expect(await ask(`ASK WHERE { <${prefixes[0]}:1> <${L}>+ ?o }`, route.options)).toBe('true');
      expect(await ask(`ASK WHERE { <urn:unlisted:a:1> <${L}>+ ?o }`, route.options)).toBe('false');
      expect(await ask(`ASK WHERE { ?s <${L}>+ <urn:unlisted:bridge> }`, route.options)).toBe('false');
      expect(await ask(`ASK WHERE { { SELECT ?o WHERE { <urn:unlisted:a:1> <${L}> ?o } } }`, route.options)).toBe('false');
    });

    it('CONSTRUCT builds from the list alone', async () => {
      const paths = await quadsOf(`CONSTRUCT { ?s <urn:p:reaches> ?o } WHERE { ?s <${L}>+ ?o }`, route.options);
      expect(bag(paths.map(item => ({ s: item.subject, o: item.object })))).toEqual(bag(pairsOf(prefixes, PLUS)));
      const nested = await quadsOf(`CONSTRUCT { ?s <urn:p:reaches> ?o } WHERE { { SELECT ?s ?o WHERE { ?s <${L}> ?o } } }`, route.options);
      expect(bag(nested.map(item => ({ s: item.subject, o: item.object })))).toEqual(bag(pairsOf(prefixes, [['1', '2'], ['2', '3']])));
    });

    it.each([
      ['DESCRIBE ?var', () => `DESCRIBE ?s WHERE { ?s <${L}> ?o }`],
      ['DESCRIBE ?var over a path', () => `DESCRIBE ?s WHERE { ?s <${L}>+ ?o }`],
      ['DESCRIBE ?var over a nested SELECT', () => `DESCRIBE ?s WHERE { { SELECT ?s WHERE { ?s <${L}> ?o } } }`],
      ['DESCRIBE *', () => `DESCRIBE * WHERE { ?s <${L}> ?o }`],
      ['DESCRIBE <iri>', (prefix: string) => `DESCRIBE <${prefix}:1>`],
      ['DESCRIBE <iri> WHERE', (prefix: string) => `DESCRIBE <${prefix}:1> WHERE { ?a <${L}> ?b }`],
      ['DESCRIBE ?var with a modifier', () => `DESCRIBE ?s WHERE { ?s <${L}> ?o } LIMIT 1`],
    ] as const)('%s describes from the list alone', async (_name, sparql) => {
      const described = await quadsOf(sparql(prefixes[0]), route.options);
      expect(described.filter(fromUnlistedGraph)).toEqual([]);
    });

    it('DESCRIBE of an unlisted subject finds nothing', async () => {
      expect(await quadsOf('DESCRIBE <urn:unlisted:a:1>', route.options)).toEqual([]);
    });
  });

  if (endpoint) {
    it.each(MAIN_ROUTES)('DESCRIBE ?var still describes listed subjects on $name', async (route) => {
      const prefix = prefixesOf(route)[0];
      const described = await quadsOf(`DESCRIBE ?s WHERE { ?s <${L}> <${prefix}:2> }`, route.options);
      expect(bag(described.map(item => ({ s: item.subject, p: item.predicate, o: item.object })))).toEqual(
        bag([{ s: `${prefix}:1`, p: L, o: `${prefix}:2` }]),
      );
    });
  }

  if (endpoint) {
    describe('an arbitrary SPARQL URL in front of the same store', () => {
      const overUrl = () => new DKGQueryEngine(new SparqlHttpStore({ queryEndpoint: endpoint }));

      it.each(MAIN_ROUTES)('reads stay on the list on $name', async (route) => {
        const engineOverUrl = overUrl();
        for (const sparql of [`SELECT ?s ?o WHERE { ?s <${L}>+ ?o }`, `SELECT ?s ?o WHERE { ?s (<${A}>|<${B}>)* ?o }`, `SELECT ?s ?o WHERE { { SELECT ?s ?o WHERE { ?s <${L}> ?o } } }`]) {
          expect((await engineOverUrl.query(sparql, route.options)).bindings.filter(fromUnlistedGraph)).toEqual([]);
        }
        expect(((await engineOverUrl.query(`DESCRIBE ?s WHERE { ?s <${L}> ?o }`, route.options)).quads ?? []).filter(fromUnlistedGraph)).toEqual([]);
      });
    });
  }

  describe.each(MAIN_ROUTES)('a caller GRAPH clause on $name', (route) => {
    it.each(PATHS)('GRAPH ?g with $name stays on the list', async ({ pattern }) => {
      const found = await select(`SELECT ?g ?s ?o WHERE { GRAPH ?g { ${pattern} } }`, route.options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
    });

    it('GRAPH ?g names the graph holding each path', async () => {
      const found = await select(`SELECT ?g ?s ?o WHERE { GRAPH ?g { ?s <${L}>+ ?o } }`, route.options);
      expect(bag(found)).toEqual(bag(route.graphs.flatMap(([g, prefix]) => pairsOf([prefix], PLUS).map(row => ({ g, ...row })))));
    });

    it('caller VALUES naming listed graphs stays on the list', async () => {
      const values = route.graphs.map(([graph]) => `<${graph}>`).join(' ');
      const found = await select(`SELECT ?g ?s ?o WHERE { VALUES ?g { ${values} } GRAPH ?g { ?s (<${A}>|<${B}>)* ?o } }`, route.options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
    });

    it('a nested SELECT inside GRAPH ?g stays on the list', async () => {
      const found = await select('SELECT ?s ?p ?o WHERE { GRAPH ?g { { SELECT ?s ?p ?o WHERE { ?s ?p ?o } } } }', route.options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
    });

    it('a constant GRAPH with a path stays on the list', async () => {
      const [graph, prefix] = route.graphs[0];
      const found = await select(`SELECT ?s ?o WHERE { GRAPH <${graph}> { ?s <${L}>+ ?o } }`, route.options);
      expect(bag(found)).toEqual(bag(pairsOf([prefix], PLUS)));
    });

    it('a pattern beside a constant GRAPH sees only the list', async () => {
      const [graph, prefix] = route.graphs[0];
      const found = await select(`SELECT ?a ?s WHERE { GRAPH <${graph}> { ?a <${L}> <${prefix}:2> } ?s <${L}> <urn:unlisted:a:2> }`, route.options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
    });

    it.each([
      ['a constant GRAPH', (graph: string) => `DESCRIBE ?s WHERE { GRAPH <${graph}> { ?s <${L}> ?o } }`],
      ['a constant GRAPH and a FILTER', (graph: string) => `DESCRIBE ?s WHERE { GRAPH <${graph}> { ?s <${L}> ?o } FILTER(BOUND(?s)) }`],
      ['GRAPH ?g', () => `DESCRIBE ?s WHERE { GRAPH ?g { ?s <${L}> ?o } }`],
    ] as const)('DESCRIBE over %s is refused where the store cannot scope it', async (_name, sparql) => {
      const outcome = read(sparql(route.graphs[0][0]), route.options);
      if (endpoint) await expect(outcome).rejects.toThrow(/DESCRIBE cannot be combined with a GRAPH clause/);
      else expect(((await outcome).quads ?? []).filter(fromUnlistedGraph)).toEqual([]);
    });
  });

  describe('query shapes around the WHERE group', () => {
    const options = MAIN_ROUTES[0].options;

    it('a query with no WHERE keyword stays on the list', async () => {
      const found = await select(`SELECT ?s ?o { ?s <${L}>+ ?o }`, options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
    });

    it('a pattern in ORDER BY leaves the main group on the list', async () => {
      const found = await select(`SELECT ?s ?o { ?s <${L}> ?o } ORDER BY (EXISTS { ?a ?b ?c })`, options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
    });

    it.each([
      ['ORDER BY', (graph: string) => `SELECT ?g ?s ?o { GRAPH ?g { ?s <${L}> ?o } } ORDER BY (EXISTS { GRAPH <${graph}> { ?x ?y ?z } })`],
      ['an empty ORDER BY group', () => `SELECT ?g ?s ?o { GRAPH ?g { ?s <${L}> ?o } } ORDER BY (EXISTS { })`],
      ['a trailing VALUES', () => `SELECT ?g ?s ?o { GRAPH ?g { ?s <${L}> ?o } } VALUES ?x { 1 }`],
    ])('GRAPH ?g with no WHERE keyword stays on the list beside %s', async (_name, sparql) => {
      const found = await select(sparql(ROOT), options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
      expect(found.map(row => row.s)).toContain('urn:listed:root:1');
    });

    it('a GRAPH variable outside the main group is refused', async () => {
      await expect(select(`SELECT ?s WHERE { GRAPH <${ROOT}> { ?s <${L}> ?o } } ORDER BY (EXISTS { GRAPH ?v { <urn:unlisted:a:1> ?p ?x } })`, options))
        .rejects.toThrow(/GRAPH variables must appear at the top level/);
    });

    it('a named subquery sees only the list or is refused', async () => {
      const outcome = await select(`SELECT ?s ?o WITH { SELECT ?s ?o WHERE { ?s <${L}> ?o } } AS %x WHERE { INCLUDE %x }`, options)
        .catch((error: unknown) => {
          expect(String(error)).toMatch(/query failed|expected WHERE/);
          return [] as Row[];
        });
      expect(outcome.filter(fromUnlistedGraph)).toEqual([]);
    });
  });

  describe('a minimum trust level', () => {
    const options: QueryOptions = { contextGraphId: TRUST_ID, view: 'verifiable-memory', minTrust: TrustLevel.Endorsed };

    it.each(PATHS)('SELECT with $name stays on the list', async ({ pattern }) => {
      expect((await select(`SELECT ?s ?o WHERE { ${pattern} }`, options)).filter(fromUnlistedGraph)).toEqual([]);
    });

    it('a path from a trusted subject stops where the list ends', async () => {
      expect(bag(await select(`SELECT ?s ?o WHERE { ?s <${L}>+ ?o }`, options)).filter(row => row.includes('trust:1')))
        .toEqual(bag(rows(['urn:listed:trust'], ['1', '2'], ['1', '3'])));
    });

    it('DESCRIBE describes from the list alone', async () => {
      expect((await quadsOf(`DESCRIBE ?s WHERE { ?s <${L}> ?o }`, options)).filter(fromUnlistedGraph)).toEqual([]);
    });
  });

  describe('a context graph with one graph', () => {
    const options: QueryOptions = { contextGraphId: SOLO_ID };

    it.each(PATHS)('SELECT with $name stays on the list', async ({ pattern }) => {
      expect((await select(`SELECT ?s ?o WHERE { ${pattern} }`, options)).filter(fromUnlistedGraph)).toEqual([]);
    });

    it('a nested SELECT stays on the list', async () => {
      const found = await select('SELECT ?s ?p ?o WHERE { { SELECT ?s ?p ?o WHERE { ?s ?p ?o } } }', options);
      expect(found.filter(fromUnlistedGraph)).toEqual([]);
      expect(found).toHaveLength(chains('x', 'y').length);
    });

    it.each([
      ['DESCRIBE ?var', `DESCRIBE ?s WHERE { ?s <${L}> <urn:listed:solo:2> }`],
      ['DESCRIBE ?var with a FILTER', `DESCRIBE ?s WHERE { ?s <${L}> <urn:listed:solo:2> FILTER(BOUND(?s)) }`],
      ['DESCRIBE <iri>', 'DESCRIBE <urn:listed:solo:1>'],
    ])('%s describes from the list alone', async (_name, sparql) => {
      const described = await quadsOf(sparql, options);
      expect(described.filter(fromUnlistedGraph)).toEqual([]);
      if (endpoint || sparql === 'DESCRIBE <urn:listed:solo:1>') expect(described.length).toBeGreaterThan(0);
    });
  });

  describe('a context graph with no data yet', () => {
    const options: QueryOptions = { contextGraphId: `${id}-empty` };

    it.each([
      ['a path', `SELECT ?s ?o WHERE { ?s <${L}>+ ?o }`],
      ['a repeated alternative', `SELECT ?s ?o WHERE { ?s (<${A}>|<${B}>)* ?o }`],
      ['a nested SELECT', 'SELECT ?s ?o WHERE { { SELECT ?s ?o WHERE { ?s ?p ?o } } }'],
    ])('%s finds nothing', async (_name, sparql) => {
      expect(await select(sparql, options)).toEqual([]);
    });

    it('DESCRIBE finds nothing', async () => {
      expect(await quadsOf(`DESCRIBE ?s WHERE { ?s <${L}> ?o }`, options)).toEqual([]);
      expect(await quadsOf('DESCRIBE <urn:unlisted:a:1>', options)).toEqual([]);
    });
  });

  describe('the remote query handler', () => {
    const lookup = (sparql: string, deps: ConstructorParameters<typeof QueryHandler>[2], config: ConstructorParameters<typeof QueryHandler>[1]) =>
      new QueryHandler(engine, { rateLimitPerMinute: 100_000, ...config }, deps)
        .handle({ operationId: 'graph-list', lookupType: 'SPARQL_QUERY', contextGraphId: id, sparql }, 'remote-peer');

    describe.each([
      ['a context graph public on chain', { defaultPolicy: 'deny' as const }, { isContextGraphPublic: async () => true }],
      ['a public query policy', { defaultPolicy: 'public' as const }, {}],
    ])('on %s', (_name, config, deps) => {
      it.each([
        ...PATHS.map(({ name, pattern }) => [`a ${name} path`, `SELECT ?s ?o WHERE { ${pattern} }`] as const),
        ['a nested SELECT', 'SELECT ?s ?p ?o WHERE { { SELECT ?s ?p ?o WHERE { ?s ?p ?o } } }'],
        ['SELECT * over a nested SELECT', 'SELECT * WHERE { { SELECT * WHERE { ?s ?p ?o } } }'],
        ['a nested SELECT with a path', `SELECT ?s ?o WHERE { { SELECT ?s ?o WHERE { ?s <${L}>+ ?o } } }`],
        ['a path in EXISTS', `SELECT ?s WHERE { ?s <${L}> ?o FILTER EXISTS { ?o <${L}>+ <urn:unlisted:bridge> } }`],
      ])('SPARQL_QUERY with %s stays on the list', async (_query, sparql) => {
        const response = await lookup(sparql, deps, config);
        expect(response.status).toBe('OK');
        expect(JSON.parse(response.bindings ?? '[]').filter(fromUnlistedGraph)).toEqual([]);
      });

      it.each([
        ['a path', `ASK WHERE { <urn:unlisted:a:1> <${L}>+ ?o }`],
        ['a nested SELECT', `ASK WHERE { { SELECT ?o WHERE { <urn:unlisted:a:1> <${L}> ?o } } }`],
      ])('ASK over %s answers from the list alone', async (_query, sparql) => {
        const response = await lookup(sparql, deps, config);
        expect(response.status).toBe('OK');
        expect(JSON.parse(response.bindings ?? '[]')).toEqual([{ result: 'false' }]);
      });

      it.each([
        ['CONSTRUCT', `CONSTRUCT { ?s <urn:p:reaches> ?o } WHERE { ?s <${L}>+ ?o }`],
        ['DESCRIBE', `DESCRIBE ?s WHERE { ?s <${L}> ?o }`],
      ])('%s carries nothing from an unlisted graph', async (_query, sparql) => {
        const response = await lookup(sparql, deps, config);
        expect(response.status).toBe('OK');
        expect(JSON.stringify(response)).not.toContain('unlisted');
      });
    });
  });
});
