import { describe, it, expect, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { contextGraphAssertionUri, contextGraphDataUri } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import {
  emptyQueryResultForKind,
  emptyResultForForm,
  emptyResultForSparql,
} from '../src/sparql-guard.js';
import { emptyImplicitGroupSolution } from '../src/sparql-empty-aggregate.js';

const CG = 'empty-aggregate-parity';
const ZERO = '"0"^^<http://www.w3.org/2001/XMLSchema#integer>';

/**
 * An answer the node synthesizes without running the query (a refused read, a
 * view with no graphs yet) stands in for the answer of a reader whose graph
 * holds nothing. These queries are the ones whose answer over no data is not
 * "no rows", and the ones next to them that must keep it.
 */
const AGGREGATE_ONLY = [
  'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }',
  'SELECT (COUNT(*) AS ?cnt) { ?s ?p ?o }',
  'select (count(distinct ?s) as ?subjects) where { ?s ?p ?o }',
  'SELECT DISTINCT (COUNT(?o) AS ?n) WHERE { ?s ?p ?o }',
  'SELECT (COUNT(*) AS ?triples) (COUNT(DISTINCT ?s) AS ?entities) WHERE { ?s ?p ?o }',
  'SELECT (SUM(?o) AS ?total) WHERE { ?s <http://example.org/score> ?o }',
  'SELECT (AVG(?o) AS ?mean) WHERE { ?s <http://example.org/score> ?o }',
  'SELECT (MIN(?o) AS ?low) (MAX(?o) AS ?high) (COUNT(*) AS ?n) WHERE { ?s ?p ?o }',
  'SELECT (SAMPLE(?o) AS ?any) WHERE { ?s ?p ?o }',
  'SELECT (GROUP_CONCAT(?o; SEPARATOR=", ") AS ?all) WHERE { ?s <http://example.org/name> ?o }',
  'PREFIX ex: <http://example.org/> SELECT (COUNT(*) AS ?cnt) WHERE { ?s ex:p ?o } ORDER BY ?cnt LIMIT 5 OFFSET 0',
  'SELECT (COUNT(*) AS $cnt) WHERE { ?s ?p ?o } LIMIT 1',
] as const;

const NO_ROWS = [
  'SELECT ?s WHERE { ?s ?p ?o }',
  'SELECT * WHERE { ?s ?p ?o }',
  'SELECT ?s (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o } GROUP BY ?s',
  'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o } GROUP BY ?p',
  'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o } LIMIT 0',
  'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o } OFFSET 1',
  'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o } HAVING (COUNT(*) > 0)',
] as const;

/**
 * WHERE groups that have no solution without stored data, whatever stands
 * beside their triple pattern: the row is known without running the query.
 */
const NEEDS_STORED_DATA = [
  'SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }',
  'SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g> { ?s a <urn:T> ; <urn:p> "x"@en , '
    + '"5"^^<http://www.w3.org/2001/XMLSchema#integer> , true , -3.5 . } }',
  'PREFIX ex: <http://example.org/> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> '
    + 'SELECT (COUNT(*) AS ?n) WHERE '
    + `{ ?s ex:p ex:o ; a ex:T . ?s ex:q 1e3 , .5 , """long""" , 'short' , "7"^^xsd:integer }`,
  'SELECT (COUNT(*) AS ?n) WHERE { _:b ?p ?o . ?o ?q _:b }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o . FILTER(?o > 1) FILTER regex(str(?o), "x") '
    + 'FILTER NOT EXISTS { ?s <urn:hidden> ?h } }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o FILTER EXISTS { ?s ?q ?r } }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o BIND(STR(?o) AS ?text) VALUES ?p { <urn:p> <urn:q> } }',
  'SELECT (COUNT(*) AS ?n) WHERE { VALUES (?a ?b) { (<urn:p> 2) (<urn:q> 4) } ?s ?a ?b }',
  'SELECT (COUNT(*) AS ?n) WHERE { OPTIONAL { ?a ?b ?c } ?s ?p ?o MINUS { ?s <urn:x> ?y } }',
  'SELECT (COUNT(*) AS ?n) WHERE { { ?s ?p ?o } }',
  'SELECT (COUNT(*) AS ?n) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }',
  'SELECT (COUNT(*) AS ?n) WHERE { { SELECT ?s WHERE { ?s ?p ?o } } ?s <urn:p> ?o }',
  'SELECT (COUNT(*) AS ?n) WHERE { { { { GRAPH ?g { { ?s ?p ?o } } } } } }',
] as const;

/**
 * WHERE groups that have solutions over no data at all, each with the count a
 * store that holds nothing answers. A made-up 0 would be a wrong number.
 */
const HAS_SOLUTIONS_OVER_NO_DATA: ReadonlyArray<readonly [string, number]> = [
  ['SELECT (COUNT(*) AS ?n) WHERE { VALUES ?x { 1 2 } }', 2],
  // A data block of three IRIs is not a triple pattern.
  ['SELECT (COUNT(*) AS ?n) WHERE { VALUES ?x { <urn:a> <urn:b> <urn:c> } }', 3],
  ['SELECT (COUNT(*) AS ?n) WHERE { VALUES (?x ?y) { (1 2) (3 4) (5 6) } }', 3],
  ['SELECT (COUNT(*) AS ?n) WHERE { BIND(1 AS ?x) }', 1],
  ['SELECT (COUNT(*) AS ?n) WHERE { OPTIONAL { ?s ?p ?o } }', 1],
  ['SELECT (COUNT(*) AS ?n) WHERE { MINUS { ?s ?p ?o } }', 1],
  ['SELECT (COUNT(*) AS ?n) WHERE { FILTER NOT EXISTS { ?s ?p ?o } }', 1],
  ['SELECT (COUNT(*) AS ?n) WHERE { }', 1],
  ['SELECT (COUNT(*) AS ?n) WHERE { { SELECT (COUNT(*) AS ?inner) WHERE { ?s ?p ?o } } }', 1],
  ['SELECT (COUNT(*) AS ?n) WHERE { SELECT (COUNT(*) AS ?inner) WHERE { ?s ?p ?o } }', 1],
  ['SELECT (COUNT(*) AS ?n) WHERE { { ?s ?p ?o } UNION { VALUES ?x { 1 } } }', 1],
  ['SELECT (COUNT(*) AS ?n) WHERE { { ?s ?p ?o } UNION { BIND(1 AS ?x) } UNION { ?a ?b ?c } }', 1],
  ['SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g> { VALUES ?x { 1 2 } } }', 2],
  ['SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { VALUES ?x { 1 2 } } }', 2],
];

/** WHERE groups the reading cannot tell about: no row is made up for them either. */
const NOT_READ = [
  // A property path can match at length zero.
  'SELECT (COUNT(*) AS ?n) WHERE { <urn:a> <urn:p>? ?o }',
  'SELECT (COUNT(*) AS ?n) WHERE { <urn:a> <urn:p>* ?o }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s <urn:p>+ ?o }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s <urn:p>/<urn:q> ?o }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s <urn:p>|<urn:q> ?o }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ^<urn:p> ?o }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s !<urn:p> ?o }',
  // Collections, blank node property lists, quoted triples.
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p (1 2) }',
  'SELECT (COUNT(*) AS ?n) WHERE { [ <urn:p> ?o ] ?q ?r }',
  'SELECT (COUNT(*) AS ?n) WHERE { [] ?q ?r }',
  'SELECT (COUNT(*) AS ?n) WHERE { << ?s ?p ?o >> ?q ?r }',
  // A subquery is not read, and a GRAPH clause proves nothing by itself.
  'SELECT (COUNT(*) AS ?n) WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }',
  'SELECT (COUNT(*) AS ?n) WHERE { SELECT DISTINCT ?s WHERE { ?s ?p ?o } }',
  'SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { } }',
  'SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g> { } }',
  // Elements and spellings this reading does not know.
  'SELECT (COUNT(*) AS ?n) WHERE { SERVICE <http://example.org/sparql> { ?s ?p ?o } }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o SERVICE <http://example.org/sparql> { ?s ?p ?o } }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p "5"^^ }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o UNION }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o OPTIONAL ?x }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o BIND ?x }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o VALUES ?x 1 }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o FILTER EXISTS ?x }',
  'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o FILTER ?x }',
  'SELECT (COUNT(*) AS ?n) WHERE { GRAPH { ?s ?p ?o } }',
] as const;

function nested(levels: number): string {
  return `SELECT (COUNT(*) AS ?n) WHERE ${'{ '.repeat(levels)}?s ?p ?o${' }'.repeat(levels)}`;
}

describe('the empty answer of a SELECT that only aggregates', () => {
  it('is the one row the same query has over a graph that holds nothing', async () => {
    const engine = new DKGQueryEngine(new OxigraphStore());
    for (const sparql of [...AGGREGATE_ONLY, ...NO_ROWS]) {
      // No view: the engine runs the query against the (empty) data graph.
      const overNoData = await engine.query(sparql, { contextGraphId: CG });
      expect(emptyResultForSparql(sparql), sparql).toEqual(overNoData);
      expect(emptyQueryResultForKind(sparql), sparql).toEqual(overNoData);
    }
  });

  it('answers COUNT with one row of 0, and each other set function with its value over no data', () => {
    expect(emptyResultForSparql('SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }'))
      .toEqual({ bindings: [{ cnt: ZERO }] });
    expect(emptyImplicitGroupSolution(
      'SELECT (COUNT(*) AS ?n) (SUM(?o) AS ?sum) (AVG(?o) AS ?avg) (MIN(?o) AS ?min) '
        + '(MAX(?o) AS ?max) (SAMPLE(?o) AS ?any) (GROUP_CONCAT(?o) AS ?all) WHERE { ?s ?p ?o }',
    )).toEqual({ n: ZERO, sum: ZERO, avg: ZERO, all: '""' });
  });

  it('answers the row when the WHERE group needs stored data, whatever stands beside its triple pattern', async () => {
    const store = new OxigraphStore();
    for (const sparql of NEEDS_STORED_DATA) {
      const overNoData = await store.query(sparql);
      expect(overNoData, sparql).toEqual({ type: 'bindings', bindings: [{ n: ZERO }] });
      expect(emptyResultForSparql(sparql), sparql).toEqual({ bindings: [{ n: ZERO }] });
    }
  });

  it('makes up no count for a WHERE group that has solutions over no data', async () => {
    const store = new OxigraphStore();
    for (const [sparql, count] of HAS_SOLUTIONS_OVER_NO_DATA) {
      const overNoData = await store.query(sparql);
      expect(overNoData, sparql).toEqual({
        type: 'bindings',
        bindings: [{ n: `"${count}"^^<http://www.w3.org/2001/XMLSchema#integer>` }],
      });
      expect(emptyImplicitGroupSolution(sparql), sparql).toBeNull();
      expect(emptyResultForSparql(sparql), sparql).toEqual({ bindings: [] });
    }
  });

  it('makes up no count where it cannot tell what the WHERE group needs', () => {
    for (const sparql of [...NOT_READ, nested(18), nested(20_000)]) {
      expect(emptyImplicitGroupSolution(sparql), sparql.slice(0, 120)).toBeNull();
      expect(emptyResultForSparql(sparql), sparql.slice(0, 120)).toEqual({ bindings: [] });
    }
    expect(emptyImplicitGroupSolution(nested(17))).toEqual({ n: ZERO });
  });

  it('keeps a column whose name an object inherits a setter for', () => {
    const result = emptyResultForSparql(
      'SELECT (COUNT(*) AS ?__proto__) (COUNT(?s) AS ?constructor) (MAX(?o) AS ?toString) WHERE { ?s ?p ?o }',
    );
    const row = result.bindings[0]!;
    expect(Object.keys(row)).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(row, '__proto__')).toEqual({
      value: ZERO, writable: true, enumerable: true, configurable: true,
    });
    expect(row['constructor']).toBe(ZERO);
    // An ordinary row otherwise, as a store adapter returns it.
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    const zero = JSON.stringify(ZERO);
    expect(JSON.stringify(result)).toBe(`{"bindings":[{"__proto__":${zero},"constructor":${zero}}]}`);
    const overTheWire = JSON.parse(JSON.stringify(result)) as { bindings: Array<Record<string, string>> };
    expect(Object.getOwnPropertyDescriptor(overTheWire.bindings[0], '__proto__')?.value).toBe(ZERO);
  });

  it('keeps the answer without rows for every other SELECT', () => {
    for (const sparql of [
      ...NO_ROWS,
      // An expression around a set function needs an evaluator.
      'SELECT (COUNT(*) + 1 AS ?cnt) WHERE { ?s ?p ?o }',
      'SELECT (COALESCE(MAX(?o), 0) AS ?high) WHERE { ?s ?p ?o }',
      'SELECT (STR(?o) AS ?text) WHERE { ?s ?p ?o }',
      'SELECT (COUNT(*) AS ?cnt) ?s WHERE { ?s ?p ?o }',
      'SELECT (COUNT(*) AS ?cnt) (COUNT(?s) AS ?cnt) WHERE { ?s ?p ?o }',
      'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o } VALUES ?cnt { 1 }',
      'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o } LIMIT ?n',
      'SELECT (COUNT(*) AS ?cnt)',
      'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o',
      'SELECT (COUNT(* AS ?cnt) WHERE { ?s ?p ?o }',
      'SELECT ( ) WHERE { ?s ?p ?o }',
      'SELECT (COUNT AS ?cnt) WHERE { ?s ?p ?o }',
      'SELECT (COUNT(*) ?cnt) WHERE { ?s ?p ?o }',
      'SELECT (COUNT(*) AS cnt) WHERE { ?s ?p ?o }',
      'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p "\\u00ZZ" }',
    ]) {
      expect(emptyImplicitGroupSolution(sparql), sparql).toBeNull();
      expect(emptyResultForSparql(sparql), sparql).toEqual({ bindings: [] });
    }
  });

  it('leaves the other query forms and the form-only helper as they were', () => {
    expect(emptyResultForSparql('ASK { ?s ?p ?o }')).toEqual({ bindings: [{ result: 'false' }] });
    expect(emptyResultForSparql('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }'))
      .toEqual({ bindings: [], quads: [] });
    expect(emptyResultForSparql('DESCRIBE <urn:x>')).toEqual({ bindings: [], quads: [] });
    expect(emptyResultForForm('SELECT')).toEqual({ bindings: [] });
    expect(emptyImplicitGroupSolution('ASK { ?s ?p ?o }')).toBeNull();
    // A fresh row on every call, like the empty result itself.
    const first = emptyResultForSparql('SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }');
    first.bindings[0]!['cnt'] = 'changed';
    expect(emptyResultForSparql('SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }'))
      .toEqual({ bindings: [{ cnt: ZERO }] });
  });

  it('counts 0 in a view that resolves no graph, without running the query', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const agentAddress = '0x00000000000000000000000000000000000000a1';
    const count = 'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }';
    const workingMemory = { contextGraphId: CG, view: 'working-memory', agentAddress } as const;
    const countsExecuted = (): number => executed.mock.calls
      .filter(([sparql]) => /COUNT/i.test(sparql)).length;

    // An agent with no draft: the view looks its graphs up by prefix, finds
    // none, and the engine answers from the query text alone.
    const executed = vi.spyOn(store, 'query');
    const beforeAnyGraph = await engine.query(count, workingMemory);
    expect(beforeAnyGraph).toEqual({ bindings: [{ cnt: ZERO }] });
    expect(countsExecuted()).toBe(0);

    // The same view over one draft runs the query, and counts in the same shape.
    await store.insert([{
      subject: 'urn:empty-aggregate:s',
      predicate: 'http://example.org/p',
      object: '"v"',
      graph: contextGraphAssertionUri(CG, agentAddress, 'draft'),
    }, {
      subject: 'urn:empty-aggregate:other',
      predicate: 'http://example.org/p',
      object: '"w"',
      graph: contextGraphDataUri(`${CG}-other`),
    }]);
    const afterOne = await engine.query(count, workingMemory);
    expect(afterOne).toEqual({ bindings: [{ cnt: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' }] });
    expect(countsExecuted()).toBe(1);
    executed.mockRestore();
  });
});
