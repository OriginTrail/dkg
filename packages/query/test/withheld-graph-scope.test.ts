import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { isWithheldGraphQueryError, WithheldGraphQueryError } from '../src/withheld-graph-scope.js';

const ROOT = 'did:dkg:context-graph:marked';
const GRAPHS: Record<string, string> = {
  root: ROOT,
  meta: `${ROOT}/_meta`,
  vm: `${ROOT}/_verifiable_memory/0xab/1`,
  child: `${ROOT}/child/_meta`,
  sibling: 'did:dkg:context-graph:marked-other/_meta',
  open: 'did:dkg:context-graph:open/_meta',
};
const withheld = { withheldGraphRoots: [ROOT] };

let store: OxigraphStore;
let engine: DKGQueryEngine;
beforeEach(async () => {
  store = new OxigraphStore();
  engine = new DKGQueryEngine(store);
  await store.insert([
    ...Object.entries(GRAPHS).map(([name, graph]) => ({ subject: `urn:s:${name}`, predicate: 'urn:p', object: `"${name}"`, graph })),
    { subject: 'urn:s:default', predicate: 'urn:p', object: '"default"', graph: '' },
  ]);
});
afterEach(async () => { await store.close(); });

const values = (result: { bindings: Array<Record<string, string>> }, name: string) =>
  result.bindings.map(row => row[name]).sort();

describe('unscoped queries with withheld graphs', () => {
  it('answers over the dataset without the withheld root and every graph below it', async () => {
    const sparql = 'SELECT ?o WHERE { GRAPH ?g { ?s <urn:p> ?o } }';
    expect(values(await engine.query(sparql), 'o')).toEqual(['"child"', '"meta"', '"open"', '"root"', '"sibling"', '"vm"']);
    expect(values(await engine.query(sparql, withheld), 'o')).toEqual(['"open"', '"sibling"']);
    expect(values(await engine.query('SELECT ?o WHERE { GRAPH $g { ?s <urn:p> ?o } }', withheld), 'o')).toEqual(['"open"', '"sibling"']);
    expect(values(await engine.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { } }', withheld), 'g')).toEqual([GRAPHS.sibling, GRAPHS.open]);
  });

  it('counts the default graph and the remaining named graphs, as the node metrics do', async () => {
    const count = 'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }';
    expect((await engine.query(count)).bindings[0]!.c).toContain('"7"');
    expect((await engine.query(count, withheld)).bindings[0]!.c).toContain('"3"');
  });

  it('leaves withheld graphs out wherever a GRAPH pattern stands', async () => {
    const run = async (sparql: string) => (await engine.query(sparql, withheld)).bindings;
    // EXISTS / NOT EXISTS see a dataset without the withheld graphs.
    expect(await run('SELECT ?x WHERE { VALUES ?x { "probe" } FILTER EXISTS { GRAPH ?g { ?s <urn:p> "meta" } } }')).toEqual([]);
    expect(await run('SELECT ?x WHERE { VALUES ?x { "probe" } FILTER NOT EXISTS { GRAPH ?g { ?s <urn:p> "meta" } } }')).toEqual([{ x: '"probe"' }]);
    // MINUS removes only what a visible graph holds.
    expect(await run('SELECT ?s WHERE { VALUES ?s { <urn:s:meta> <urn:s:open> } MINUS { GRAPH ?g { ?s <urn:p> ?o } } }')).toEqual([{ s: 'urn:s:meta' }]);
    expect(await run('SELECT ?s ?o WHERE { VALUES ?s { <urn:s:meta> } OPTIONAL { GRAPH ?g { ?s <urn:p> ?o } } }')).toEqual([{ s: 'urn:s:meta' }]);
    expect(await run('SELECT ?c WHERE { { SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } } } }')).toEqual([{ c: expect.stringContaining('"2"') }]);
    // Oxigraph leaves ?g unbound for these groups although they read named
    // graphs; such rows are dropped, so nothing from a withheld graph escapes.
    expect(values(await engine.query('SELECT ?o WHERE { GRAPH ?g { { SELECT ?o WHERE { ?s <urn:p> ?o } } } }'), 'o'))
      .toEqual(['"child"', '"meta"', '"open"', '"root"', '"sibling"', '"vm"']);
    expect(await run('SELECT ?o WHERE { GRAPH ?g { { SELECT ?o WHERE { ?s <urn:p> ?o } } } }')).toEqual([]);
    expect(await run('SELECT ?o WHERE { GRAPH ?g { GRAPH ?h { ?s <urn:p> ?o } } }')).toEqual([]);
    expect(values({ bindings: await run('SELECT ?o WHERE { GRAPH ?g { ?x ?y ?z GRAPH ?h { ?s <urn:p> ?o } } }') }, 'o'))
      .toEqual(['"open"', '"open"', '"sibling"', '"sibling"']);
    expect(await run(`SELECT ?o WHERE { VALUES ?g { <${GRAPHS.meta}> } GRAPH ?g { ?s <urn:p> ?o } }`)).toEqual([]);
    expect(values({ bindings: await run('SELECT ?o WHERE { { GRAPH ?g { ?s <urn:p> ?o } } UNION { GRAPH ?h { ?s <urn:p> ?o } } }') }, 'o'))
      .toEqual(['"open"', '"open"', '"sibling"', '"sibling"']);
    // Two adjacent patterns: one's closing edit and the next one's opening edit share a position.
    expect(await run('SELECT ?o ?q WHERE { GRAPH ?g { ?s <urn:p> ?o }GRAPH ?h { ?t <urn:p> ?q } }')).toHaveLength(4);
  });

  it('refuses a query that names a withheld graph or a graph it cannot place', async () => {
    const refused = [
      `SELECT ?o WHERE { GRAPH <${GRAPHS.meta}> { ?s <urn:p> ?o } }`,
      `SELECT ?o WHERE { GRAPH <${ROOT}> { ?s <urn:p> ?o } }`,
      'PREFIX cg: <did:dkg:context-graph:> SELECT ?o WHERE { GRAPH cg:marked { ?s <urn:p> ?o } }',
      `SELECT ?o FROM <${GRAPHS.vm}> WHERE { ?s <urn:p> ?o }`,
      `SELECT ?o FROM NAMED <${GRAPHS.child}> WHERE { GRAPH ?g { ?s <urn:p> ?o } }`,
      'BASE <did:dkg:context-graph:> SELECT ?o WHERE { GRAPH <marked/_meta> { ?s <urn:p> ?o } }',
      'SELECT ?o WHERE { GRAPH <marked/_meta> { ?s <urn:p> ?o } }',
      'SELECT ?o WHERE { GRAPH undeclared:graph { ?s <urn:p> ?o } }',
      'SELECT ?o FROM undeclared:graph WHERE { ?s <urn:p> ?o }',
      'SELECT ?o WHERE { GRAPH ?g ?s }',
    ];
    for (const sparql of refused) {
      const error = await engine.query(sparql, withheld).then(() => undefined, (cause: unknown) => cause);
      expect(error, sparql).toBeInstanceOf(WithheldGraphQueryError);
      expect(isWithheldGraphQueryError(error)).toBe(true);
    }
    expect(isWithheldGraphQueryError(new Error('other'))).toBe(false);
  });

  it('keeps explicit graphs and datasets outside the withheld roots', async () => {
    expect(values(await engine.query(`SELECT ?o WHERE { GRAPH <${GRAPHS.sibling}> { ?s <urn:p> ?o } }`, withheld), 'o')).toEqual(['"sibling"']);
    expect(values(await engine.query(`SELECT ?o FROM <${GRAPHS.open}> WHERE { ?s <urn:p> ?o }`, withheld), 'o')).toEqual(['"open"']);
    expect(values(await engine.query('PREFIX open: <did:dkg:context-graph:open/> SELECT ?o FROM NAMED open:_meta WHERE { GRAPH ?g { ?s <urn:p> ?o } }', withheld), 'o'))
      .toEqual(['"open"']);
    expect(values(await engine.query('SELECT ?o WHERE { ?s <urn:p> ?o }', withheld), 'o')).toEqual(['"default"']);
    expect(values(await engine.query('SELECT ?o WHERE { GRAPH ?g { ?s <urn:p> ?o } }', { withheldGraphRoots: [] }), 'o')).toHaveLength(6);
  });

  it('rejects withheld roots on scoped queries and unsafe roots', async () => {
    await expect(engine.query('SELECT ?o WHERE { ?s <urn:p> ?o }', { contextGraphId: 'open', ...withheld }))
      .rejects.toThrow('only to queries without a contextGraphId');
    await expect(engine.query('SELECT ?o WHERE { GRAPH ?g { ?s <urn:p> ?o } }', { withheldGraphRoots: ['did:dkg:context-graph:x> } <urn:y'] }))
      .rejects.toThrow('Unsafe');
  });
});
