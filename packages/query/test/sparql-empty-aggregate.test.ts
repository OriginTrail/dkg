import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { contextGraphDataUri, contextGraphVerifiableMemoryUri } from '@origintrail-official/dkg-core';
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

  it('counts 0 in a view that has no graph yet, as it does once the view has an empty one', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const count = 'SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }';
    // Nothing published: the verifiable-memory view of this graph resolves no
    // named graph at all, and the engine answers without the store.
    const beforeAnyGraph = await engine.query(count, { contextGraphId: CG, view: 'verifiable-memory' });
    expect(beforeAnyGraph).toEqual({ bindings: [{ cnt: ZERO }] });

    await store.insert([{
      subject: 'urn:empty-aggregate:s',
      predicate: 'http://example.org/p',
      object: '"v"',
      graph: contextGraphVerifiableMemoryUri(CG, 'q1'),
    }, {
      subject: 'urn:empty-aggregate:other',
      predicate: 'http://example.org/p',
      object: '"w"',
      graph: contextGraphDataUri(`${CG}-other`),
    }]);
    const afterOne = await engine.query(count, { contextGraphId: CG, view: 'verifiable-memory' });
    expect(afterOne.bindings).toHaveLength(1);
    expect(afterOne.bindings[0]!['cnt']).toBe('"1"^^<http://www.w3.org/2001/XMLSchema#integer>');
  });
});
