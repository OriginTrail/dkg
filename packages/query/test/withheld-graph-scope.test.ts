import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
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
const isWithheld = (graph: string) => graph === ROOT || graph.startsWith(`${ROOT}/`);
const QUADS: Quad[] = [
  ...Object.entries(GRAPHS).map(([name, graph]) => ({ subject: `urn:s:${name}`, predicate: 'urn:p', object: `"${name}"`, graph })),
  // One subject described in a readable graph and in a withheld one.
  { subject: 'urn:shared', predicate: 'urn:p', object: '"visible"', graph: GRAPHS.open },
  { subject: 'urn:shared', predicate: 'urn:secret', object: '"withheld"', graph: GRAPHS.meta },
  { subject: 'urn:s:default', predicate: 'urn:p', object: '"default"', graph: '' },
];

let full: OxigraphStore;
let oracle: OxigraphStore;
beforeEach(async () => {
  full = new OxigraphStore();
  oracle = new OxigraphStore();
  await full.insert(QUADS);
  // The behavioural oracle: the same store with the withheld graphs physically absent.
  await oracle.insert(QUADS.filter(quad => !isWithheld(quad.graph)));
});
afterEach(async () => { await full.close(); await oracle.close(); });

function normalize(result: { bindings: Array<Record<string, string>>; quads?: Quad[] }) {
  return JSON.stringify({
    bindings: result.bindings.map(row => JSON.stringify(Object.entries(row).sort())).sort(),
    quads: (result.quads ?? []).map(quad => JSON.stringify([quad.subject, quad.predicate, quad.object, quad.graph])).sort(),
  });
}

// Shapes where a per-pattern rewrite would lose readable rows or let a
// subquery read a withheld graph; the dataset restriction answers them all.
const SHAPES = [
  'SELECT ?o WHERE { GRAPH ?g { ?s <urn:p> ?o } }',
  'SELECT ?o WHERE { GRAPH $g { ?s <urn:p> ?o } }',
  'SELECT DISTINCT ?g WHERE { GRAPH ?g { } }',
  'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }',
  'SELECT ?x WHERE { VALUES ?x { "probe" } FILTER EXISTS { GRAPH ?g { ?s <urn:p> "meta" } } }',
  'SELECT ?x WHERE { VALUES ?x { "probe" } FILTER NOT EXISTS { GRAPH ?g { ?s <urn:p> "meta" } } }',
  'SELECT ?s WHERE { VALUES ?s { <urn:s:meta> <urn:s:open> } MINUS { GRAPH ?g { ?s <urn:p> ?o } } }',
  'SELECT ?s ?o WHERE { VALUES ?s { <urn:s:meta> } OPTIONAL { GRAPH ?g { ?s <urn:p> ?o } } }',
  'SELECT ?c WHERE { { SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } } } }',
  'SELECT ?g ?o WHERE { GRAPH ?g { { SELECT ?o WHERE { ?s <urn:p> ?o } } } }',
  'SELECT ?g ?o WHERE { GRAPH ?g { OPTIONAL { { SELECT ?o WHERE { ?s <urn:p> ?o } } } } }',
  'SELECT ?x WHERE { VALUES ?x { "probe" } FILTER NOT EXISTS { GRAPH ?g { { SELECT ?o WHERE { ?s <urn:p> "meta" } } } } }',
  'SELECT ?o WHERE { GRAPH ?g { GRAPH ?h { ?s <urn:p> ?o } } }',
  `SELECT ?o WHERE { VALUES ?g { <${GRAPHS.meta}> } GRAPH ?g { ?s <urn:p> ?o } }`,
  'SELECT ?o ?q WHERE { GRAPH ?g { ?s <urn:p> ?o }GRAPH ?h { ?t <urn:p> ?q } }',
  `SELECT ?o WHERE { GRAPH <${GRAPHS.meta}> { ?s ?p ?o } }`,
  `SELECT ?o WHERE { GRAPH <${GRAPHS.sibling}> { ?s ?p ?o } }`,
  'PREFIX cg: <did:dkg:context-graph:> SELECT ?o WHERE { GRAPH cg:marked\\/_meta { ?s ?p ?o } }',
  'BASE <did:dkg:context-graph:> SELECT ?o WHERE { GRAPH <marked/_meta> { ?s ?p ?o } }',
  'SELECT ?o WHERE { ?s <urn:p> ?o }',
  'ASK { GRAPH ?g { ?s <urn:secret> ?o } }',
  'DESCRIBE <urn:shared>',
  'DESCRIBE ?s WHERE { GRAPH ?g { ?s <urn:p> "visible" } }',
  'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }',
];

describe('unscoped queries with withheld graphs', () => {
  it('answers each shape as the same query over a store without the withheld graphs', async () => {
    const engine = new DKGQueryEngine(full);
    const reference = new DKGQueryEngine(oracle);
    for (const sparql of SHAPES) {
      expect(normalize(await engine.query(sparql, withheld)), sparql).toBe(normalize(await reference.query(sparql)));
    }
    // The withheld content is there: without roots the same store returns it.
    expect(normalize(await engine.query(SHAPES[0]!))).toContain('meta');
    expect((await engine.query('ASK { GRAPH ?g { ?s <urn:secret> ?o } }')).bindings).toEqual([{ result: 'true' }]);
  });

  it('refuses a query that names its own dataset while graphs are withheld', async () => {
    const engine = new DKGQueryEngine(full);
    for (const sparql of [
      `SELECT ?o FROM <${GRAPHS.open}> WHERE { ?s <urn:p> ?o }`,
      `SELECT ?o FROM NAMED <${GRAPHS.meta}> WHERE { GRAPH ?g { ?s <urn:p> ?o } }`,
    ]) {
      const error = await engine.query(sparql, withheld).then(() => undefined, (cause: unknown) => cause);
      expect(error, sparql).toBeInstanceOf(WithheldGraphQueryError);
      expect(isWithheldGraphQueryError(error)).toBe(true);
      // Without withheld graphs the query runs as before.
      await expect(engine.query(sparql)).resolves.toBeDefined();
    }
    expect(isWithheldGraphQueryError(new Error('other'))).toBe(false);
  });

  it('runs as before without roots and rejects roots on scoped queries', async () => {
    const engine = new DKGQueryEngine(full);
    expect(normalize(await engine.query(SHAPES[0]!, { withheldGraphRoots: [] }))).toBe(normalize(await engine.query(SHAPES[0]!)));
    await expect(engine.query('SELECT ?o WHERE { ?s <urn:p> ?o }', { contextGraphId: 'open', ...withheld }))
      .rejects.toThrow('only to queries without a contextGraphId');
  });
});
