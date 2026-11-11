import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ChangelogStore, OxigraphStore, OxigraphWorkerStore, createManagedOxigraphRuntimeStoreConfigV1, createTripleStore,
  sparqlEngineOf, type Quad, type TripleStore,
} from '@origintrail-official/dkg-storage';
import { TRUST_LEVEL_PREDICATE, TrustLevel } from '@origintrail-official/dkg-core';
import { materializePreparedSparql, prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { resolveQueryReadPlan } from '../src/query-read-plan.js';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import type { QueryOptions, QueryResult } from '../src/query-engine.js';
import { startOxigraphSparqlEndpoint } from '../../storage/test/helpers/oxigraph-sparql-endpoint.js';
import {
  hasNestedSelect,
  hasRepeatedPath,
  guardGraphBlocksWithoutTriples,
  planGraphDataset,
  readsNeedGraphList,
  withDatasetClauses,
} from '../src/sparql-graph-dataset.js';
import {
  constrainGraphVariablesToAllowedSet,
  prepareGraphScope,
  requireGraphScopeRewrite,
  rewriteGraphRoute,
  rewriteGraphSet,
  rewriteSingleGraph,
  wrapWithDeduplicatedGraphValues,
  wrapWithGraphValues,
} from '../src/sparql-graph-scope.js';
import { callerGraphBranchesFit, isolateCallerGraphAssignments } from '../src/sparql-caller-graph-read.js';

const graphs = ['urn:g:1', 'urn:g:2'];
const NAMED = 'FROM NAMED <urn:g:1> FROM NAMED <urn:g:2>';
const DEFAULT = 'FROM <urn:g:1> FROM <urn:g:2>';

function scope(source: string) {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error('Expected valid test input');
  return prepareGraphScope(prepared);
}

const ready = (result: ReturnType<typeof rewriteGraphSet>) => materializePreparedSparql(requireGraphScopeRewrite(result).prepared);
/** The graph list a listed rewrite writes; on Oxigraph the dataset's named graphs replace it. */
const LISTED = /VALUES \?__dkg\w+ \{ <urn:g:1> <urn:g:2> \} /g;

describe('hasRepeatedPath', () => {
  it.each([
    'SELECT * WHERE { ?s <urn:p>+ ?o }',
    'SELECT * WHERE { ?s <urn:p>* ?o }',
    'SELECT * WHERE { ?s <urn:p>? ?o }',
    'PREFIX e: <urn:> SELECT * WHERE { ?s e:p+ ?o }',
    'PREFIX : <urn:> SELECT * WHERE { ?s :p* ?o }',
    'SELECT * WHERE { ?s a+ ?o }',
    'SELECT * WHERE { ?s (<urn:a>/<urn:b>)+ ?o }',
    'SELECT * WHERE { ?s (<urn:a>|<urn:b>)* ?o }',
    'SELECT * WHERE { ?s ^<urn:p>+ ?o }',
    'SELECT * WHERE { ?s !<urn:p>+ ?o }',
    'SELECT * WHERE { ?s !(<urn:a>|<urn:b>)+ ?o }',
    'SELECT * WHERE { ?s <urn:a>/<urn:b>* ?o }',
    'SELECT ?s WHERE { ?s <urn:q> ?x FILTER EXISTS { ?s <urn:p>+ ?o } }',
    'ASK { <urn:s> <urn:p>* <urn:o> }',
    String.raw`SELECT * WHERE { ?s <urn:p>\u002B ?o }`,
    'SELECT * WHERE { ?s <urn:p> # note\n + ?o }',
  ])('finds a repeat in %s', (query) => {
    expect(hasRepeatedPath(scope(query))).toBe(true);
  });

  it.each([
    'SELECT * WHERE { ?s ?p ?o }',
    'SELECT (COUNT(*) AS ?c) WHERE { ?s ?p ?o }',
    'SELECT * WHERE { ?s <urn:a>/<urn:b> ?o }',
    'SELECT * WHERE { ?s <urn:a>|<urn:b> ?o }',
    'SELECT * WHERE { ?s ^<urn:a> ?o }',
    'SELECT * WHERE { ?s !<urn:a> ?o }',
    'SELECT * WHERE { ?s <urn:p>?o }',
    'SELECT * WHERE { ?s <urn:a+b> ?o }',
    'SELECT * WHERE { ?s <urn:p> "a+" }',
    'SELECT * WHERE { ?s <urn:p> ?o } # <urn:p>+',
    'SELECT * WHERE { ?s <urn:p> ?n FILTER(?n + 1 > 2) }',
  ])('finds no repeat in %s', (query) => {
    expect(hasRepeatedPath(scope(query))).toBe(false);
  });
});

describe('hasNestedSelect', () => {
  it.each([
    'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }',
    'SELECT ?s WHERE { ?s ?p ?o FILTER EXISTS { { SELECT ?x WHERE { ?x ?p ?o } } } }',
    'ASK { { SELECT ?s WHERE { ?s ?p ?o } } }',
    'SELECT ?s WITH { SELECT ?s WHERE { ?s ?p ?o } } AS %x WHERE { INCLUDE %x }',
    String.raw`SELECT ?s WHERE { { S\u0045LECT ?s WHERE { ?s ?p ?o } } }`,
    'PREFIX e: <urn:> SELECT ?s WHERE { { SELECT ?s WHERE { ?s e:p ?o } } }',
  ])('finds one in %s', (query) => {
    expect(hasNestedSelect(scope(query))).toBe(true);
  });

  it.each([
    'SELECT ?s WHERE { ?s ?p ?o }',
    'SELECT ?s WHERE { ?s <urn:p> "SELECT" }',
    'SELECT ?s WHERE { ?s ?p ?o } # SELECT',
    'PREFIX SELECT: <urn:> SELECT ?s WHERE { ?s SELECT:p ?o }',
    'SELECT ("demo"@select AS ?label) WHERE { ?s ?p ?o }',
    String.raw`SELECT ("demo"@s\u0065lect AS ?label) WHERE { ?s ?p ?o }`,
  ])('finds none in %s', (query) => {
    expect(hasNestedSelect(scope(query))).toBe(false);
  });
});

describe('planGraphDataset', () => {
  const both = ['FROM', 'FROM NAMED'] as const;
  const expected = (graphAccess: 'values' | 'dataset' | 'named', datasetClauses: readonly string[],
    transforms: Partial<{ preservePattern: boolean; bindCallerGraphs: boolean; wrapDescriptionPattern: boolean }> = {}) => ({
    graphAccess, datasetClauses, preservePattern: false, bindCallerGraphs: false, wrapDescriptionPattern: false, ...transforms,
  });
  // On Oxigraph every read's named graphs come from its dataset alone, with a default graph where it reads one.
  const named = ['FROM NAMED'] as const;
  it.each([
    ['SELECT ?s WHERE { ?s ?p ?o }', expected('named', named), expected('values', both)],
    ['SELECT ?s WHERE { ?s <urn:p>+ ?o }', expected('named', named), expected('dataset', both)],
    ['SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }', expected('dataset', named), expected('dataset', both)],
    ['ASK { ?s <urn:p>* ?o }', expected('named', named), expected('dataset', both)],
    ['CONSTRUCT { ?s ?p ?o } WHERE { { SELECT ?s ?p ?o WHERE { ?s ?p ?o } } }', expected('dataset', named), expected('dataset', both)],
    ['DESCRIBE ?s WHERE { ?s ?p ?o }', expected('named', both), expected('dataset', both, { wrapDescriptionPattern: true })],
    ['DESCRIBE <urn:s>', expected('named', ['FROM'], { preservePattern: true }), expected('dataset', ['FROM'], { preservePattern: true })],
    ['DESCRIBE ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }', expected('dataset', both), expected('dataset', both, { wrapDescriptionPattern: true })],
    ['SELECT ?s WITH { SELECT ?s { ?s ?p ?o } } AS %x { INCLUDE %x }', expected('named', both, { preservePattern: true }), expected('dataset', both, { preservePattern: true })],
    ['SELECT * WHERE { GRAPH ?g { ?s (<urn:a>|<urn:b>)+ ?o } }', expected('named', named), expected('dataset', both, { bindCallerGraphs: true })],
    ['SELECT * WHERE { GRAPH ?g { ?s <urn:p>+ ?o } }', expected('named', named), expected('dataset', both)],
    ['SELECT * WHERE { GRAPH ?g { BIND(<urn:g> AS ?g) ?s <urn:p>+ ?o } }', expected('named', named), expected('dataset', both, { bindCallerGraphs: true })],
    ['SELECT ?s (EXISTS { ?s <urn:f> ?f } AS ?x) WHERE { ?s ?p ?o }', expected('named', both), expected('values', both)],
    ['SELECT ?s WHERE { GRAPH <urn:g:1> { ?s ?p ?o } ?s <urn:f> ?f }', expected('named', both), expected('values', both)],
    // On Oxigraph a GRAPH block without a triple pattern of its own that holds a subquery,
    // a nested GRAPH or a VALUES keeps the graph list beside its dataset.
    ['SELECT ?g ?s WHERE { GRAPH ?g { { SELECT ?s WHERE { ?s ?p ?o } } } }', expected('dataset', named), expected('dataset', both)],
    ['SELECT ?g ?s WHERE { GRAPH ?g { GRAPH <urn:g:1> { ?s ?p ?o } } }', expected('values', named), expected('values', both)],
    ['SELECT ?x WHERE { VALUES ?x { <urn:x:1> <urn:x:2> } }', expected('values', named), expected('values', both)],
    ['SELECT ?x WHERE { VALUES ?x { "a" } FILTER regex(?x, "a") }', expected('values', named), expected('values', both)],
    ['SELECT ?g ?k WHERE { GRAPH ?g { VALUES ?k { <urn:k> } ?s ?p ?o } }', expected('named', named), expected('values', both)],
    ['SELECT ?s WHERE { ?s ?p ?o { SELECT ?t WHERE { ?t ?q ?u } } }', expected('named', named), expected('dataset', both)],
    ['SELECT ?g WHERE { GRAPH ?g { BIND(<urn:x> AS ?x) } }', expected('named', named), expected('values', both)],
    // A subquery that fills the GRAPH block keeps the list too.
    ['SELECT ?g ?s WHERE { GRAPH ?g { SELECT ?s WHERE { ?s ?p ?o } } }', expected('dataset', named), expected('dataset', both)],
    // On Oxigraph a block that assigns its graph variable reads the assignment under another name
    // (isolateCallerGraphAssignments); one with a subquery reads one constant branch per graph.
    ['SELECT ?g ?s WHERE { GRAPH ?g { BIND(<urn:g:1> AS ?g) ?s ?p ?o } }', expected('named', named), expected('values', both)],
    ['SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o OPTIONAL { BIND(<urn:g:1> AS ?g) } } }', expected('named', named), expected('values', both)],
    ['SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o { SELECT (<urn:g:1> AS ?g) WHERE {} } } }', expected('named', named, { bindCallerGraphs: true }), expected('dataset', both)],
    ['SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o VALUES ?g { <urn:g:1> } } }', expected('named', named), expected('values', both)],
    ['SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o BIND(IF(?x, <urn:g:1>, <urn:g:2>) AS ?g) } }', expected('named', named), expected('values', both)],
    // With a subquery, an assignment of an expression, which may fail and leave ?g unbound, keeps the graph list.
    ['SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o { SELECT (COALESCE(?k, <urn:g:2>) AS ?g) WHERE { BIND(<urn:g:1> AS ?k) } } } }', expected('dataset', named), expected('dataset', both)],
    // An assignment inside MINUS or EXISTS binds nothing for the block.
    ['SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o { SELECT ?x WHERE {} } MINUS { BIND(IF(?x, <urn:g:1>, <urn:g:2>) AS ?g) } } }', expected('named', named), expected('dataset', both)],
    ['SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o FILTER EXISTS { SELECT (<urn:g:1> AS ?g) WHERE {} } } }', expected('named', named), expected('dataset', both)],
    ['SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o FILTER(?g != <urn:g:2>) } }', expected('named', named), expected('values', both)],
  ] as const)('fully plans %s', (query, oxigraph, other) => {
    expect(planGraphDataset(scope(query), 'oxigraph')).toEqual(oxigraph);
    expect(planGraphDataset(scope(query), null)).toEqual(other);
  });

  it('reads the assignment of a block\'s own graph variable under another name, and keeps rows whose value is that graph', () => {
    // Other reads of the graph variable keep the graph's binding.
    const isolated = isolateCallerGraphAssignments(scope('SELECT ?g ?s WHERE { GRAPH ?g { BIND(<urn:g:1> AS ?g) ?s ?p ?o FILTER(?g != <urn:g:2>) } }'));
    expect(isolated.source).toBe('SELECT ?g ?s WHERE { { SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { BIND(<urn:g:1> AS ?__dkgAssignedg) ?s ?p ?o '
      + 'FILTER(?g != <urn:g:2>) } FILTER(COALESCE(sameTerm(?__dkgAssignedg, ?g), true)) } } }');
    expect(() => scope(isolated.source)).not.toThrow();
    const optional = isolateCallerGraphAssignments(scope('SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o OPTIONAL { ?s ?q ?x BIND(<urn:g:1> AS ?g) } FILTER(?g = <urn:g:2>) } }'));
    // An assignment inside OPTIONAL is checked inside that OPTIONAL too, so a value other than the graph fails only the OPTIONAL.
    expect(optional.source).toMatch(/OPTIONAL \{ \?s \?q \?x BIND\(<urn:g:1> AS \?__dkgAssignedg\)\s+FILTER\(COALESCE\(sameTerm\(\?__dkgAssignedg, \?g\), true\)\)\s+\} FILTER\(\?g = <urn:g:2>\)/);
    // The subquery projects only the variables the block binds: not those of a FILTER, EXISTS, MINUS or an assigned expression.
    const projected = isolateCallerGraphAssignments(scope('SELECT ?g WHERE { GRAPH ?g { BIND(<urn:g:1> AS ?g) ?s ?p ?o OPTIONAL { ?s ?q ?r } VALUES ?k { <urn:k> } '
      + 'FILTER EXISTS { ?hidden ?p ?o } MINUS { ?gone ?p ?o } FILTER(?other != ?s) BIND(STR(?unused) AS ?label) GRAPH ?h { ?t ?p ?o } } BIND(1 AS ?hidden) }'));
    expect(projected.source).toMatch(/^SELECT \?g WHERE \{ \{ SELECT \?g \?s \?p \?o \?q \?r \?k \?label \?h \?t WHERE \{ GRAPH \?g \{ BIND\(<urn:g:1> AS \?__dkgAssignedg\) /);
    // An assignment inside MINUS or EXISTS binds nothing for the block: it is left as it is, also beside one that does.
    for (const body of ['?s ?p ?o MINUS { BIND(<urn:g:1> AS ?g) }', '?s ?p ?o FILTER NOT EXISTS { BIND(<urn:g:1> AS ?g) }',
      '?s ?p ?o BIND(EXISTS { BIND(<urn:g:1> AS ?g) } AS ?e)', '?s ?p ?o FILTER(EXISTS { BIND(<urn:g:1> AS ?g) })']) {
      const unchanged = scope(`SELECT ?g ?s WHERE { GRAPH ?g { ${body} } }`);
      expect(isolateCallerGraphAssignments(unchanged), body).toBe(unchanged);
    }
    const beside = isolateCallerGraphAssignments(scope('SELECT ?g ?s WHERE { GRAPH ?g { BIND(<urn:g:1> AS ?g) ?s ?p ?o MINUS { BIND(<urn:g:2> AS ?g) } } }'));
    expect(beside.source).toContain('BIND(<urn:g:1> AS ?__dkgAssignedg) ?s ?p ?o MINUS { BIND(<urn:g:2> AS ?g) }');
    // Only the outer of two nested blocks that assign their variables; none without an assignment or with a subquery.
    const nested = isolateCallerGraphAssignments(scope('SELECT * WHERE { GRAPH ?g { BIND(<urn:g:1> AS ?g) ?x ?y ?z GRAPH ?h { BIND(<urn:g:2> AS ?h) ?s ?p ?o } } }'));
    expect(nested.source.match(/SELECT \?g/g)).toHaveLength(1);
    expect(nested.source).toContain('BIND(<urn:g:2> AS ?h)');
    // A block that keeps the graph list, with no triple of its own beside a nested GRAPH or VALUES, keeps its assignment as written.
    for (const query of ['SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }', 'SELECT * WHERE { GRAPH ?g { ?s ?p ?o { SELECT (<urn:g:1> AS ?g) WHERE {} } } }',
      'SELECT ?g ?s WHERE { GRAPH ?g { GRAPH <urn:g:1> { ?s ?p ?o } BIND(<urn:g:2> AS ?g) } }', 'SELECT ?g ?k WHERE { GRAPH ?g { VALUES ?k { 1 } BIND(<urn:g:2> AS ?g) } }']) {
      const unchanged = scope(query);
      expect(isolateCallerGraphAssignments(unchanged), query).toBe(unchanged);
    }
  });

  it('guards a GRAPH block that needs no triple of its own, and only such a block', () => {
    expect(guardGraphBlocksWithoutTriples(scope('ASK { GRAPH <urn:g:1> {} }')).source)
      .toMatch(/GRAPH <urn:g:1> \{\s+FILTER EXISTS \{ \?__dkgHeldS \?__dkgHeldP \?__dkgHeldO \}/);
    expect(guardGraphBlocksWithoutTriples(scope('SELECT ?x WHERE { BIND(1 AS ?x) }')).source).toContain('FILTER EXISTS');
    const triples = scope('SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }');
    expect(guardGraphBlocksWithoutTriples(triples)).toBe(triples);
    // A FILTER on a function named by an IRI or a prefixed name is no triple; a path in brackets after a subject is one.
    for (const query of [
      'ASK { GRAPH <urn:g:1> { FILTER <http://www.w3.org/2001/XMLSchema#boolean>(1) } }',
      'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> ASK { GRAPH <urn:g:1> { FILTER xsd:boolean(1) } }',
    ]) expect(guardGraphBlocksWithoutTriples(scope(query)).source, query).toContain('FILTER EXISTS');
    const path = scope('SELECT * WHERE { GRAPH ?g { <urn:s> (<urn:p>|<urn:q>) ?o } }');
    expect(guardGraphBlocksWithoutTriples(path)).toBe(path);
    // A path with * or ? matches its endpoints without a triple; one with + needs one.
    for (const query of [
      'ASK { GRAPH <urn:g:1> { <urn:x> <urn:p>* <urn:x> } }',
      'SELECT ?o WHERE { GRAPH <urn:g:1> { <urn:x> <urn:p>? ?o } }',
      'SELECT ?o WHERE { GRAPH <urn:g:1> { <urn:x> (<urn:p>/<urn:q>)* ?o } }',
    ]) expect(guardGraphBlocksWithoutTriples(scope(query)).source, query).toContain('FILTER EXISTS');
    const oneOrMore = scope('SELECT ?o WHERE { GRAPH <urn:g:1> { <urn:x> <urn:p>+ ?o } }');
    expect(guardGraphBlocksWithoutTriples(oneOrMore)).toBe(oneOrMore);
    // A nested group, or every branch of a UNION, that reads a triple of the graph needs no guard.
    for (const query of [
      'SELECT * WHERE { GRAPH ?g { { ?s ?p ?o } } }',
      'SELECT * WHERE { GRAPH ?g { { ?b ?p ?o } UNION { ?s ?p ?b } FILTER(isBlank(?b)) } }',
      'SELECT * WHERE { GRAPH ?g { { { ?b ?p ?o } UNION { ?s ?p ?b } UNION { ?b ?p ?b } } FILTER(isBlank(?b)) } }',
      'SELECT * WHERE { GRAPH ?g { BIND(1 AS ?x) { ?s ?p ?o } } }',
      'SELECT ?s WHERE { { ?s ?p ?o } UNION { ?o ?p ?s } }',
    ]) {
      const read = scope(query);
      expect(guardGraphBlocksWithoutTriples(read), query).toBe(read);
    }
    // A UNION branch that may read none, OPTIONAL, MINUS, EXISTS, a nested GRAPH or a subquery proves nothing.
    for (const query of [
      'SELECT * WHERE { GRAPH ?g { { ?s ?p ?o } UNION { BIND(1 AS ?x) } } }',
      'SELECT * WHERE { GRAPH ?g { { ?s <urn:p>* ?o } UNION { ?s ?p ?o } } }',
      'SELECT * WHERE { GRAPH ?g { OPTIONAL { ?s ?p ?o } } }',
      'SELECT * WHERE { GRAPH ?g { MINUS { ?s ?p ?o } } }',
      'SELECT * WHERE { GRAPH ?g { FILTER EXISTS { ?s ?p ?o } } }',
      'SELECT * WHERE { GRAPH ?g { GRAPH ?h { ?s ?p ?o } } }',
      'SELECT * WHERE { GRAPH ?g { VALUES ?x { 1 } { SELECT ?s WHERE { ?s ?p ?o } } } }',
      'SELECT * WHERE { GRAPH ?g { VALUES (?x) { (1) } } }',
    ]) expect(guardGraphBlocksWithoutTriples(scope(query)).source, query).toContain('FILTER EXISTS { ?__dkgHeld');
    // A subquery that fills its group moves into a group of its own, which the guard follows.
    const subquery = guardGraphBlocksWithoutTriples(scope('SELECT ?g ?s WHERE { GRAPH ?g { SELECT ?s WHERE { ?s ?p ?o } } }'));
    expect(subquery.source).toMatch(/GRAPH \?g \{ \{ SELECT \?s WHERE \{ \?s \?p \?o \}\s+\} FILTER EXISTS \{ [^}]+ \} \}/);
    expect(() => scope(subquery.source)).not.toThrow();
    const whole = guardGraphBlocksWithoutTriples(scope('SELECT ?s WHERE { SELECT ?s WHERE { ?s ?p ?o } }'));
    expect(whole.source).toMatch(/WHERE \{ \{ SELECT \?s WHERE \{ \?s \?p \?o \}\s+\} FILTER EXISTS/);
    expect(() => scope(whole.source)).not.toThrow();
  });

  it('keeps the graph list for a constant graph assignment over more graphs than the branches allow', () => {
    const query = scope('SELECT ?s WHERE { VALUES ?g { <urn:wide:1> } GRAPH ?g { ?s <urn:p> ?o { SELECT (<urn:wide:1> AS ?g) WHERE {} } } }');
    const fits = Array.from({ length: 128 }, (_, i) => `urn:wide:${i + 1}`);
    const wide = [...fits, 'urn:wide:129'];
    expect(callerGraphBranchesFit(query, fits)).toBe(true);
    expect(callerGraphBranchesFit(query, wide)).toBe(false);
    expect(ready(rewriteGraphSet(query, fits, 'values-union', 'oxigraph'))).toContain('GRAPH <urn:wide:128>');
    const kept = ready(rewriteGraphSet(query, wide, 'values-union', 'oxigraph'));
    expect(kept).not.toContain('GRAPH <urn:wide:1>');
    expect(kept).toContain('FROM NAMED <urn:wide:129>');
  });

  it('writes the graph list beside the dataset for a read that keeps one', () => {
    const text = ready(rewriteGraphSet(scope('SELECT ?x WHERE { VALUES ?x { <urn:x:1> <urn:x:2> } }'), graphs, 'values-union', 'oxigraph'));
    expect(text).toContain(NAMED);
    expect(text).toMatch(LISTED);
    expect(readsNeedGraphList(scope('SELECT ?s WHERE { VALUES ?x { 1 } ?s ?p ?x }'))).toBe(false);
    expect(readsNeedGraphList(scope('SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o } GRAPH <urn:g:1> { VALUES ?x { 1 } } }'))).toBe(false);
  });
});

describe('withDatasetClauses', () => {
  it.each([
    ['SELECT ?s WHERE { ?s ?p ?o }', `SELECT ?s ${NAMED} WHERE { ?s ?p ?o }`],
    ['SELECT ?s { ?s ?p ?o }', `SELECT ?s ${NAMED} { ?s ?p ?o }`],
    ['SELECT ?s{ ?s ?p ?o }', `SELECT ?s ${NAMED} { ?s ?p ?o }`],
    ['select distinct ?s where { ?s ?p ?o }', `select distinct ?s ${NAMED} where { ?s ?p ?o }`],
    ['SELECT (EXISTS { ?a ?b ?c } AS ?x) WHERE { ?s ?p ?o }', `SELECT (EXISTS { ?a ?b ?c } AS ?x) ${NAMED} WHERE { ?s ?p ?o }`],
    ['ASK { ?s ?p ?o }', `ASK ${NAMED} { ?s ?p ?o }`],
    ['ASK WHERE { ?s ?p ?o }', `ASK ${NAMED} WHERE { ?s ?p ?o }`],
    ['CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', `CONSTRUCT { ?s ?p ?o } ${NAMED} WHERE { ?s ?p ?o }`],
    ['CONSTRUCT { ?s ?p ?o } { ?s ?p ?o }', `CONSTRUCT { ?s ?p ?o } ${NAMED} { ?s ?p ?o }`],
    ['CONSTRUCT WHERE { ?s ?p ?o }', `CONSTRUCT ${NAMED} WHERE { ?s ?p ?o }`],
    ['DESCRIBE ?s WHERE { ?s ?p ?o }', `DESCRIBE ?s ${NAMED} WHERE { ?s ?p ?o }`],
    ['SELECT ?s WITH { SELECT ?s WHERE { ?s ?p ?o } } AS %x WHERE { INCLUDE %x }', `SELECT ?s ${NAMED} WITH { SELECT ?s WHERE { ?s ?p ?o } } AS %x WHERE { INCLUDE %x }`],
    ['PREFIX e: <urn:> SELECT ?s # note\nWHERE { ?s e:p ?o }', `PREFIX e: <urn:> SELECT ?s # note\n${NAMED} WHERE { ?s e:p ?o }`],
    ['SELECT ?s { ?s ?p ?o } ORDER BY (EXISTS { ?a ?b ?c })', `SELECT ?s ${NAMED} { ?s ?p ?o } ORDER BY (EXISTS { ?a ?b ?c })`],
  ])('places the clauses in %s', (query, expected) => {
    expect(withDatasetClauses(scope(query), graphs, 'FROM NAMED')).toBe(expected);
  });

  it('writes each graph once', () => {
    expect(withDatasetClauses(scope('DESCRIBE ?s WHERE { ?s ?p ?o }'), [...graphs, ...graphs], 'FROM'))
      .toBe(`DESCRIBE ?s ${DEFAULT} WHERE { ?s ?p ?o }`);
  });

  it.each([
    ['DESCRIBE <urn:s>', `DESCRIBE <urn:s> ${DEFAULT} `],
    ['DESCRIBE <urn:s> LIMIT 1', `DESCRIBE <urn:s> ${DEFAULT} LIMIT 1`],
    ['DESCRIBE ?s VALUES ?s { <urn:s> }', `DESCRIBE ?s ${DEFAULT} VALUES ?s { <urn:s> }`],
  ])('uses the same dataset writer for graphless %s', (query, expected) => {
    expect(withDatasetClauses(scope(query), graphs, 'FROM')).toBe(expected);
  });

  it('refuses a graph IRI that could break out of its brackets', () => {
    expect(() => withDatasetClauses(scope('SELECT ?s WHERE { ?s ?p ?o }'), ['urn:g> } #'], 'FROM NAMED')).toThrow();
  });
});

describe('rewriteGraphSet with a known and an unknown engine', () => {
  const flat = 'SELECT ?s ?o WHERE { ?s <urn:p> ?o }';

  it('refuses oversized compound GRAPH expansion instead of truncating its authorization list', () => {
    const allowed = Array.from({ length: 1400 }, (_, index) => `urn:large:${index}`);
    const source = scope('SELECT ?g ?s ?o WHERE { GRAPH ?g { ?s (<urn:a>|<urn:b>)+ ?o } } LIMIT 10');
    expect(() => rewriteGraphSet(source, allowed, 'values-union', null)).toThrow(/at most 128 graph branches/);
    // A verified native Oxigraph route does not need constant-graph expansion.
    expect(rewriteGraphSet(source, allowed, 'values-union', 'oxigraph').kind).toBe('ready');
  });

  it('bounds the total expansion across multiple GRAPH operands', () => {
    const source = scope('SELECT * WHERE { GRAPH ?g { ?s (<urn:a>|<urn:b>)+ ?o } GRAPH ?h { ?s (<urn:a>|<urn:b>)+ ?o } }');
    const allowed = Array.from({ length: 65 }, (_, index) => `urn:large:${index}`);
    expect(() => rewriteGraphSet(source, allowed, 'values-union', null)).toThrow(/at most 128 graph branches/);
  });

  it.each(['STRLEN("demo")', 'ABS(-2)'])('keeps a large atomic-path read scalable beside %s arithmetic', (expression) => {
    const source = scope(`SELECT * WHERE { GRAPH ?g { ?s <urn:p>+ ?o } BIND(${expression} * 2 AS ?n) }`);
    const allowed = Array.from({ length: 1400 }, (_, index) => `urn:large:${index}`);
    const text = ready(rewriteGraphSet(source, allowed, 'values-union', null));
    expect(text).not.toContain('UNION');
    expect(text).toContain(`BIND(${expression} * 2 AS ?n)`);
    expect(text).toContain('FROM NAMED <urn:large:1399>');
  });

  it.each([
    'WITH { SELECT ?s { ?s ?p ?o } } AS %limit WHERE { INCLUDE %limit }',
    'WITH { SELECT ?s { ?s ?p ?o } } AS %limit WITH { SELECT ?s { INCLUDE %limit } } AS %values { INCLUDE %values }',
    String.raw`W\u0049TH { SELECT ?s { ?s ?p ?o } } AS %l\u0069mit { INCL\u0055DE %limit }`,
  ])('sets the dataset without wrapping the declared named-set read: %s', (tail) => {
    const query = `SELECT ?s ${tail}`;
    const expected = materializePreparedSparql(scope(`SELECT ?s ${DEFAULT} ${NAMED} ${tail}`).prepared);
    for (const engine of ['oxigraph', null] as const) {
      expect(ready(rewriteGraphSet(scope(query), graphs, 'deduplicated-values-union', engine))).toBe(expected);
    }
  });

  // The listed rewrite, with the dataset's named graphs in place of its list.
  const fromNamed = (listed: string, head: string) => listed.replace(LISTED, '').replace(`${head} WHERE`, `${head} ${NAMED} WHERE`);

  it('keeps the per-graph shape of a flat Oxigraph read and selects its graphs by the dataset', () => {
    expect(ready(rewriteGraphSet(scope(flat), graphs, 'deduplicated-values-union', 'oxigraph')))
      .toBe(fromNamed(ready(wrapWithDeduplicatedGraphValues(scope(flat), graphs)), 'SELECT ?s ?o'));
    expect(ready(rewriteGraphSet(scope(flat), graphs, 'values-union', 'oxigraph')))
      .toBe(fromNamed(ready(wrapWithGraphValues(scope(flat), graphs)), 'SELECT ?s ?o'));
  });

  it('keeps the per-graph shape of an Oxigraph path read and selects its graphs by the dataset', () => {
    const path = 'SELECT ?s ?o WHERE { ?s <urn:p>+ ?o }';
    expect(ready(rewriteGraphSet(scope(path), graphs, 'values-union', 'oxigraph')))
      .toBe(fromNamed(ready(wrapWithGraphValues(scope(path), graphs)), 'SELECT ?s ?o'));
  });

  it('gives every Oxigraph read its dataset and no graph list', () => {
    for (const query of ['SELECT ?s WHERE { ?s <urn:p> ?o }', 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }',
      'ASK { ?s <urn:p> ?o }', 'SELECT ?s ?x WHERE { ?s <urn:p> ?o OPTIONAL { ?s <urn:q> ?x } }']) {
      for (const policy of ['values-union', 'deduplicated-values-union'] as const) {
        const text = ready(rewriteGraphSet(scope(query), graphs, policy, 'oxigraph'));
        expect(text).toContain(NAMED);
        expect(text).not.toContain('FROM <');
        expect(text.replace(NAMED, '')).not.toContain('<urn:g:');
      }
    }
  });

  it('keeps the rewrite on a flat read and adds the dataset on an unknown engine', () => {
    const text = ready(rewriteGraphSet(scope(flat), graphs, 'deduplicated-values-union', null));
    expect(text).toContain(`SELECT ?s ?o ${DEFAULT} ${NAMED} WHERE`);
    expect(text).toContain('VALUES');
    expect(text.replace(`${DEFAULT} ${NAMED} `, '')).toBe(ready(wrapWithDeduplicatedGraphValues(scope(flat), graphs)));
  });

  it.each([
    ['a nested SELECT on an unknown engine', 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }', null],
    ['a nested SELECT on Oxigraph', 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }', 'oxigraph'],
  ] as const)('lets the dataset alone select graphs for %s', (_name, query, engine) => {
    const text = ready(rewriteGraphSet(scope(query), graphs, 'deduplicated-values-union', engine));
    expect(text).toContain(NAMED);
    expect(text).toContain('GRAPH ?__dkgViewGraph');
    expect(text).not.toContain('VALUES');
  });

  it('preserves mirror suppression and hidden-path multiplicity on the dataset route', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        ...graphs.map(graph => ({ subject: 'urn:s', predicate: 'urn:p', object: 'urn:m1', graph })),
        ...graphs.map(graph => ({ subject: 'urn:m1', predicate: 'urn:q', object: 'urn:o', graph })),
        { subject: 'urn:s', predicate: 'urn:p', object: 'urn:m2', graph: graphs[0] },
        { subject: 'urn:m2', predicate: 'urn:q', object: 'urn:o', graph: graphs[0] },
      ]);
      const query = (text: string) => store.query(ready(rewriteGraphSet(scope(text), graphs, 'deduplicated-values-union', null)));
      expect((await query('SELECT ?s WHERE { ?s <urn:p>+ ?o }')).bindings).toEqual([{ s: 'urn:s' }, { s: 'urn:s' }]);
      expect((await query('SELECT ?s ?o WHERE { ?s <urn:p>+/<urn:q> ?o }')).bindings)
        .toEqual([{ s: 'urn:s', o: 'urn:o' }, { s: 'urn:s', o: 'urn:o' }]);
      expect((await query('SELECT (COUNT(*) AS ?n) WHERE { ?s <urn:p>+ ?o }')).bindings[0]?.n).toMatch(/^"2"/);
    } finally { await store.close(); }
  });

  it('hides the helper variable from SELECT * on the dataset route', () => {
    const text = ready(rewriteGraphSet(scope('SELECT * WHERE { ?s <urn:p>+ ?o }'), graphs, 'values-union', null));
    expect(text).toContain(`SELECT * ${DEFAULT} ${NAMED} WHERE { { SELECT ?s ?o WHERE { GRAPH ?__dkgViewGraph {`);
  });

  it('keeps the outer modifiers and carries a plain LIMIT inside', () => {
    const text = ready(rewriteGraphSet(scope('SELECT ?s ?o WHERE { ?s <urn:p>+ ?o } LIMIT 5'), graphs, 'values-union', null));
    expect(text).toMatch(/} LIMIT 5 }\s+}\s+LIMIT 5$/);
  });

  it.each(['oxigraph', null] as const)('reports a caller UNION as before on the dataset route (%s)', (engine) => {
    const query = 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } UNION { ?s <urn:p> ?o } }';
    expect(rewriteGraphSet(scope(query), graphs, 'values-union', engine))
      .toMatchObject({ kind: 'unsupported', reason: 'nested-union' });
  });

  it.each(['oxigraph', null] as const)('keeps constant GRAPH branches on a union-only route (%s)', (engine) => {
    const text = ready(rewriteGraphSet(scope('SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }'), graphs, 'union-only', engine));
    expect(text).toContain(NAMED);
    expect(text).toContain('GRAPH <urn:g:1>');
    expect(text).toContain('GRAPH <urn:g:2>');
    expect(text).not.toContain('GRAPH ?');
  });

  it('allocates a fresh graph helper beside the authorized dataset', () => {
    const text = ready(rewriteGraphSet(scope('SELECT ?__dkgViewGraph ?s WHERE { ?s <urn:p>+ ?o }'), graphs, 'values-union', null));
    expect(text).toContain(NAMED);
    expect(text).toContain('GRAPH ?__dkgViewGraph0');
    expect(text).not.toContain('UNION');
  });

  describe('DESCRIBE on an unknown engine', () => {
    it('reads the pattern and the description from the list', () => {
      const rewritten = ready(rewriteGraphSet(scope('DESCRIBE ?s WHERE { ?s <urn:p> ?o }'), graphs, 'deduplicated-values-union', null));
      expect(rewritten).toContain(`${DEFAULT} ${NAMED} WHERE { { SELECT * WHERE {`);
      expect(rewritten).toContain('GRAPH ?__dkgDedupGraph');
    });

    it('refuses a caller GRAPH clause with a clear reason', () => {
      for (const query of ['DESCRIBE ?s WHERE { GRAPH <urn:g:1> { ?s <urn:p> ?o } }', 'DESCRIBE <urn:s> WHERE { GRAPH ?g { ?s <urn:p> ?o } }']) {
        expect(() => rewriteGraphSet(scope(query), graphs, 'values-union', null)).toThrow(/DESCRIBE cannot be combined with a GRAPH clause/);
        expect(() => rewriteSingleGraph(scope(query), 'urn:g:1', null)).toThrow(/DESCRIBE cannot be combined with a GRAPH clause/);
      }
    });

    it('leaves a caller GRAPH clause to the store on Oxigraph, inside its dataset', () => {
      const query = scope('DESCRIBE ?s WHERE { GRAPH <urn:g:1> { ?s <urn:p> ?o } }');
      expect(ready(rewriteGraphSet(query, graphs, 'values-union', 'oxigraph')))
        .toBe(`DESCRIBE ?s ${DEFAULT} ${NAMED} WHERE { GRAPH <urn:g:1> { ?s <urn:p> ?o } }`);
    });
  });

  it.each(['oxigraph', null] as const)('scopes a graphless DESCRIBE through the dataset on %s', (engine) => {
    const query = scope('DESCRIBE <urn:s> LIMIT 1');
    expect(ready(rewriteSingleGraph(query, graphs[0], engine)))
      .toBe('DESCRIBE <urn:s> FROM <urn:g:1> LIMIT 1');
    for (const policy of ['values-union', 'union-only', 'deduplicated-values-union'] as const) {
      expect(ready(rewriteGraphSet(query, graphs, policy, engine)))
        .toBe('DESCRIBE <urn:s> FROM <urn:g:1> FROM <urn:g:2> LIMIT 1');
    }
  });

  it('describes from the default graph of the dataset on Oxigraph', () => {
    const query = 'DESCRIBE ?s WHERE { ?s <urn:p> ?o }';
    expect(ready(rewriteGraphSet(scope(query), graphs, 'values-union', 'oxigraph')))
      .toBe(ready(wrapWithGraphValues(scope(query), graphs)).replace(LISTED, '').replace('DESCRIBE ?s WHERE', `DESCRIBE ?s ${DEFAULT} ${NAMED} WHERE`));
  });

  describe('a caller GRAPH clause', () => {
    const constrained = (query: string) => requireGraphScopeRewrite(constrainGraphVariablesToAllowedSet(scope(query), graphs));

    it('keeps the VALUES that bind the caller variable, beside the dataset', () => {
      const text = ready(rewriteGraphSet(constrained('SELECT ?g ?s WHERE { GRAPH ?g { ?s <urn:p>+ ?o } }'), graphs, 'values-union', null));
      expect(text).toContain(NAMED);
      expect(text).toContain('VALUES ?g { <urn:g:1> <urn:g:2> }');
    });

    it('adds the dataset to every caller GRAPH read on Oxigraph', () => {
      const flatRead = constrained('SELECT ?g ?s WHERE { GRAPH ?g { ?s <urn:p>+ ?o } }');
      expect(ready(rewriteGraphSet(flatRead, graphs, 'values-union', 'oxigraph')))
        .toBe(materializePreparedSparql(flatRead.prepared).replace('SELECT ?g ?s WHERE', `SELECT ?g ?s ${NAMED} WHERE`));
      const nested = constrained('SELECT ?s WHERE { GRAPH ?g { { SELECT ?s WHERE { ?s ?p ?o } } } }');
      expect(ready(rewriteGraphSet(nested, graphs, 'values-union', 'oxigraph'))).toContain(NAMED);
    });

    it('checks caller graph variables without writing their list when the dataset bounds them', () => {
      const read = 'SELECT ?g ?s WHERE { GRAPH ?g { ?s <urn:p> ?o } }';
      expect(ready(constrainGraphVariablesToAllowedSet(scope(read), graphs, { boundByDataset: true }))).toBe(read);
      expect(() => constrainGraphVariablesToAllowedSet(scope('SELECT ?s WHERE { OPTIONAL { GRAPH ?g { ?s ?p ?o } } }'), graphs, { boundByDataset: true }))
        .toThrow(/top level/);
    });

    it('adds the dataset to a constant GRAPH on an unknown engine', () => {
      expect(ready(rewriteGraphSet(scope('SELECT ?s WHERE { GRAPH <urn:g:1> { ?s ?p ?o } }'), graphs, 'values-union', null)))
        .toBe(`SELECT ?s ${DEFAULT} ${NAMED} WHERE { GRAPH <urn:g:1> { ?s ?p ?o } }`);
    });
  });
});

describe('rewriteSingleGraph and rewriteGraphRoute', () => {
  it('scopes one graph as before on Oxigraph, inside its dataset', () => {
    expect(ready(rewriteSingleGraph(scope('SELECT ?s WHERE { ?s ?p ?o }'), 'urn:g:1', 'oxigraph')))
      .toBe('SELECT ?s FROM NAMED <urn:g:1> WHERE { GRAPH <urn:g:1> {  ?s ?p ?o  } }');
  });

  it('adds the dataset on an unknown engine', () => {
    expect(ready(rewriteSingleGraph(scope('SELECT ?s WHERE { ?s ?p ?o }'), 'urn:g:1', null)))
      .toBe('SELECT ?s FROM <urn:g:1> FROM NAMED <urn:g:1> WHERE { GRAPH <urn:g:1> {  ?s ?p ?o  } }');
  });

  it('reads DESCRIBE from the one graph on an unknown engine', () => {
    expect(ready(rewriteSingleGraph(scope('DESCRIBE ?s WHERE { ?s ?p ?o }'), 'urn:g:1', null)))
      .toBe('DESCRIBE ?s FROM <urn:g:1> FROM NAMED <urn:g:1> WHERE { { SELECT * WHERE {  GRAPH <urn:g:1> {  ?s ?p ?o  }  } } }');
  });

  it('passes the engine to the fallback graph', () => {
    const union = 'SELECT ?s WHERE { { ?s <urn:p> ?o } UNION { ?s <urn:q> ?o } }';
    expect(ready(rewriteGraphRoute(scope(union), graphs, 'urn:g:1', 'values-union', 'compatibility', null)))
      .toContain('SELECT ?s FROM <urn:g:1> FROM NAMED <urn:g:1> WHERE { GRAPH <urn:g:1>');
    expect(ready(rewriteGraphRoute(scope(union), graphs, 'urn:g:1', 'values-union', 'compatibility', 'oxigraph')))
      .toContain('SELECT ?s FROM NAMED <urn:g:1> WHERE { GRAPH <urn:g:1>');
  });

  it('keeps a graph list empty of graphs on the fallback', () => {
    expect(ready(rewriteGraphRoute(scope('DESCRIBE ?s WHERE { ?s ?p ?o }'), [], 'urn:g:1', 'union-only', 'compatibility', null)))
      .toBe('DESCRIBE ?s FROM <urn:g:1> FROM NAMED <urn:g:1> WHERE { { SELECT * WHERE {  GRAPH <urn:g:1> {  ?s ?p ?o  }  } } }');
  });
});

describe('what reaches an Oxigraph store through the engine', () => {
  const ID = 'dataset-route';
  const ROOT = `did:dkg:context-graph:${ID}`;
  const VM = `${ROOT}/_verifiable_memory/a/1`;

  async function sent(sparql: string, wrap: (store: OxigraphStore) => OxigraphStore | ChangelogStore = store => store) {
    const inner = new OxigraphStore();
    await inner.insert([
      { subject: 'urn:s:1', predicate: 'urn:p', object: 'urn:s:2', graph: ROOT },
      { subject: 'urn:s:3', predicate: 'urn:p', object: 'urn:s:4', graph: VM },
    ]);
    const query = vi.spyOn(inner, 'query');
    try {
      await new DKGQueryEngine(wrap(inner)).query(sparql, { contextGraphId: ID });
      return query.mock.calls.map(([text]) => text).filter(text => text.includes('urn:p'));
    } finally {
      await inner.close();
    }
  }

  it('sends a flat read and a path read with their dataset and no graph list', async () => {
    for (const read of ['SELECT ?s WHERE { ?s <urn:p> ?o }', 'SELECT ?s WHERE { ?s <urn:p>+ ?o }']) {
      const [text] = await sent(read);
      expect(text).toContain(`FROM NAMED <${ROOT}> FROM NAMED <${VM}>`);
      expect(text).not.toContain('VALUES');
    }
  });

  it('sends a nested SELECT with the dataset, through a decorator too', async () => {
    const read = 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s <urn:p> ?o } } }';
    for (const wrap of [undefined, (store: OxigraphStore) => new ChangelogStore(store)]) {
      const [text] = await sent(read, wrap);
      expect(text).toContain(`FROM NAMED <${ROOT}> FROM NAMED <${VM}>`);
      expect(text).not.toContain('VALUES');
    }
  });
});

// The node's three Oxigraph stores: in process, in a worker, and a managed oxigraph-server
// (here the in-process SPARQL endpoint that runs the same engine).
const OXIGRAPH_STORES: Array<[string, () => Promise<{ store: TripleStore; close: () => Promise<void> }>]> = [
  ['embedded', async () => { const store = new OxigraphStore(); return { store, close: () => store.close() }; }],
  ['worker', async () => { const store = new OxigraphWorkerStore(); return { store, close: () => store.close() }; }],
  ['managed server', async () => {
    const endpoint = await startOxigraphSparqlEndpoint();
    const store = await createTripleStore(createManagedOxigraphRuntimeStoreConfigV1({ backend: 'sparql-http',
      options: { queryEndpoint: endpoint.queryEndpoint, updateEndpoint: endpoint.updateEndpoint, managedByDkg: true } }));
    return { store, close: async () => { await store.close(); await endpoint.close(); } };
  }],
];

describe.each(OXIGRAPH_STORES)('scoped reads on an Oxigraph store (%s)', (_kind, open) => {
  const ID = 'dataset-stores';
  const ROOT = `did:dkg:context-graph:${ID}`;
  const OTHER = 'did:dkg:context-graph:dataset-stores-other';
  const DATA = [ROOT, `${ROOT}/_verifiable_memory/0xa/1`, `${ROOT}/_verifiable_memory/0xb/2`];
  const SHARED = [`${ROOT}/_shared_memory/0xa/1`, `${ROOT}/_shared_memory/0xb/2`];
  const ELSEWHERE = [OTHER, `${OTHER}/_verifiable_memory/0xa/1`, `${OTHER}/_shared_memory/0xa/1`];
  const ALL = [...DATA, ...SHARED, ...ELSEWHERE];
  // Every graph holds its own resources and a label on one resource that every graph shares.
  const quadsOf = (graphs: readonly string[]): Quad[] => graphs.flatMap((graph) => {
    const n = ALL.indexOf(graph);
    return [
      { subject: `urn:s:${n}`, predicate: 'urn:p', object: `urn:o:${n}`, graph },
      { subject: `urn:o:${n}`, predicate: 'urn:p', object: `"${graph}"`, graph },
      { subject: `urn:s:${n}`, predicate: 'urn:label', object: `"label ${n}"`, graph },
      { subject: 'urn:shared', predicate: 'urn:label', object: `"${graph}"`, graph },
    ];
  });
  const ROUTES: Array<[string, Partial<QueryOptions>, string[][]]> = [
    ['the verifiable-memory view', { view: 'verifiable-memory' }, [DATA]],
    ['the shared-memory view', { view: 'shared-working-memory' }, [SHARED]],
    ['the data route', {}, [DATA]],
    ['the shared-memory route', { graphSuffix: '_shared_memory' }, [SHARED]],
    ['data and shared memory', { includeSharedMemory: true }, [DATA, SHARED]],
  ];
  const READS = [
    'SELECT ?s ?o WHERE { ?s <urn:p> ?o }',
    'SELECT (COUNT(*) AS ?n) WHERE { ?s <urn:label> ?l }',
    'SELECT DISTINCT ?o WHERE { ?s <urn:p>+ ?o }',
    'SELECT ?g ?s WHERE { GRAPH ?g { ?s <urn:label> ?l } }',
    'SELECT ?s ?l WHERE { ?s <urn:p> ?o OPTIONAL { ?s <urn:label> ?l } }',
    'SELECT ?s WHERE { { SELECT ?s WHERE { ?s <urn:label> ?l } } }',
    'ASK { ?s <urn:label> ?l }',
    'CONSTRUCT { ?s <urn:label> ?l } WHERE { ?s <urn:label> ?l }',
    'DESCRIBE <urn:shared>',
    'DESCRIBE ?s WHERE { ?s <urn:label> ?l }',
  ];
  const answerOf = (result: QueryResult) => JSON.stringify({
    rows: result.bindings.map(row => JSON.stringify(Object.entries(row).sort())).sort(),
    quads: (result.quads ?? []).map(quad => JSON.stringify([quad.subject, quad.predicate, quad.object, quad.graph])).sort(),
  });
  const datasetOf = (text: string) => [...text.matchAll(/FROM (?:NAMED )?<([^>]+)>/g)].map(match => match[1]);

  let opened: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    opened = await open();
    await opened.store.insert([...quadsOf(DATA), ...quadsOf(SHARED), ...quadsOf(ELSEWHERE)]);
  }, 60_000);
  afterAll(async () => { await opened?.close(); });

  it('is a store the query engine reads as Oxigraph', () => {
    expect(sparqlEngineOf(opened.store)).toBe('oxigraph');
  });

  it.each(ROUTES)('sends every read on %s with the dataset of its graphs', async (_route, route, families) => {
    const query = vi.spyOn(opened.store, 'query');
    try {
      for (const read of READS) {
        query.mockClear();
        await new DKGQueryEngine(opened.store).query(read, { contextGraphId: ID, ...route });
        const sent = query.mock.calls.map(([text]) => text).filter(text => text.includes('<urn:'));
        expect(sent.length, read).toBeGreaterThan(0);
        for (const text of sent) {
          const dataset = datasetOf(text);
          expect(dataset.length, read).toBeGreaterThan(0);
          expect(dataset.filter(graph => !graph.startsWith(`${ROOT}/`) && graph !== ROOT), read).toEqual([]);
          expect(families.some(family => family.every(graph => dataset.includes(graph))), read).toBe(true);
        }
      }
    } finally {
      query.mockRestore();
    }
  });

  it.each(ROUTES)('answers on %s as a store that holds only its graphs', async (_route, route, families) => {
    const only = new OxigraphStore();
    try {
      await only.insert(quadsOf([...new Set(families.flat())]));
      for (const read of READS) {
        const options = { contextGraphId: ID, ...route };
        const [full, scoped] = await Promise.all([
          new DKGQueryEngine(opened.store).query(read, options), new DKGQueryEngine(only).query(read, options)]);
        expect(answerOf(full), read).toBe(answerOf(scoped));
        // A description reads the graphs in scope as its default graph.
        if (read.startsWith('DESCRIBE')) expect(full.quads?.length, read).toBeGreaterThan(0);
      }
    } finally {
      await only.close();
    }
  });

  it('keeps a graph variable bound around a subquery, and per-graph rows for VALUES', async () => {
    const engine = new DKGQueryEngine(opened.store);
    const view: QueryOptions = { contextGraphId: ID, view: 'verifiable-memory' };
    const around = await engine.query('SELECT ?g ?s WHERE { GRAPH ?g { { SELECT ?s WHERE { ?s <urn:label> ?l } } } }', view);
    // Oxigraph reads a subquery in a GRAPH ?g block over the whole dataset, so each graph's rows are
    // the subquery's rows over the view's graphs: every row as the read with the graph list gives it.
    const perGraph = (bindings: readonly Record<string, string>[]) => bindings.map(row => `${row.g} ${row.s}`).sort();
    const listedRows = async (where: string) => {
      const named = DATA.map(graph => `FROM NAMED <${graph}>`).join(' ');
      const listed = await opened.store.query(`SELECT ?g ?s ${named} WHERE { VALUES ?g { ${DATA.map(graph => `<${graph}>`).join(' ')} } ${where} }`);
      return perGraph(listed.type === 'bindings' ? listed.bindings : []);
    };
    expect(around.bindings.length).toBeGreaterThan(0);
    expect(perGraph(around.bindings)).toEqual(await listedRows('GRAPH ?g { { SELECT ?s WHERE { ?s <urn:label> ?l } } }'));
    // With a triple pattern of its own, the block reads graph by graph.
    const labelled = quadsOf(DATA).filter(quad => quad.predicate === 'urn:label');
    const rows = (result: QueryResult) => result.bindings.map(row => JSON.stringify(Object.entries(row).sort())).sort();
    expect(rows(await engine.query('SELECT ?g ?s ?k WHERE { GRAPH ?g { VALUES ?k { <urn:k> } ?s <urn:label> ?l } }', view)))
      .toEqual(labelled.map(quad => JSON.stringify(Object.entries({ g: quad.graph, k: 'urn:k', s: quad.subject }).sort())).sort());
    // A pattern of VALUES alone repeats once for every graph of the view's list, as with the list alone.
    const values = '{ VALUES ?x { <urn:x:1> <urn:x:2> } }';
    const once = await engine.query(`SELECT ?x WHERE ${values}`, { contextGraphId: ID, view: 'shared-working-memory' });
    const listed = [`${ROOT}/_shared_memory`, ...SHARED].map(graph => `<${graph}>`).join(' ');
    const asListed = await opened.store.query(`SELECT ?x WHERE { VALUES ?v { ${listed} } GRAPH ?v ${values} }`);
    expect(once.bindings).toHaveLength(asListed.type === 'bindings' ? asListed.bindings.length : -1);
  });

  it('keeps the graph binding and the rows of a subquery that fills its GRAPH block, and of a block that assigns its graph', async () => {
    const engine = new DKGQueryEngine(opened.store);
    const view: QueryOptions = { contextGraphId: ID, view: 'verifiable-memory' };
    const direct = await engine.query('SELECT ?g ?s WHERE { GRAPH ?g { SELECT ?s WHERE { ?s <urn:label> ?l } } FILTER(BOUND(?g)) }', view);
    // As the read with the graph list gives it, every row and each as often (see the test above).
    const named = DATA.map(graph => `FROM NAMED <${graph}>`).join(' ');
    const listed = await opened.store.query(`SELECT ?g ?s ${named} WHERE { VALUES ?g { ${DATA.map(graph => `<${graph}>`).join(' ')} } GRAPH ?g { SELECT ?s WHERE { ?s <urn:label> ?l } } FILTER(BOUND(?g)) }`);
    const perGraph = (bindings: readonly Record<string, string>[]) => bindings.map(row => `${row.g} ${row.s}`).sort();
    expect(direct.bindings.length).toBeGreaterThan(0);
    expect(perGraph(direct.bindings)).toEqual(perGraph(listed.type === 'bindings' ? listed.bindings : []));
    // A block that assigns its graph variable gives one row per match in the graph it names, inside the view only.
    const shared: QueryOptions = { contextGraphId: ID, view: 'shared-working-memory' };
    const rows = (bindings: readonly Record<string, string>[]) => bindings.map(row => JSON.stringify(Object.entries(row).sort())).sort();
    const labelled = quadsOf([SHARED[0]]).filter(quad => quad.predicate === 'urn:label').map(quad => ({ g: SHARED[0], s: quad.subject }));
    for (const body of [`BIND(<${SHARED[0]}> AS ?g) ?s <urn:label> ?l`, `?s <urn:label> ?l VALUES ?g { <${SHARED[0]}> }`]) {
      const scoped = await engine.query(`SELECT ?g ?s WHERE { GRAPH ?g { ${body} } }`, shared);
      expect(rows(scoped.bindings), body).toEqual(rows(labelled));
    }
    const outside = await engine.query(`SELECT ?g ?s WHERE { GRAPH ?g { BIND(<${DATA[1]}> AS ?g) ?s <urn:label> ?l } }`, shared);
    expect(outside.bindings).toEqual([]);
    // Nested assignments: a group or a subquery binds the graph, or an OPTIONAL may.
    for (const body of [`?s <urn:label> ?l { BIND(<${SHARED[0]}> AS ?g) }`, `?s <urn:label> ?l { SELECT (<${SHARED[0]}> AS ?g) WHERE {} }`]) {
      const scoped = await engine.query(`SELECT ?g ?s WHERE { GRAPH ?g { ${body} } }`, shared);
      expect(rows(scoped.bindings), body).toEqual(rows(labelled));
    }
    const plain = await engine.query('SELECT ?g ?s WHERE { GRAPH ?g { ?s <urn:label> ?l } }', shared);
    // A graph the store does not hold contributes nothing, also when the block assigns its variable.
    const counted = await engine.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { BIND(IRI("${SHARED[0]}") AS ?g) } }`, shared);
    expect(counted.bindings[0]?.n).toMatch(/^"?1"?/);
    // An assignment whose expression fails leaves ?g to the graph: every graph keeps its own rows,
    // as the read with the view's graph list gives them.
    const viewGraphs = [`${ROOT}/_shared_memory`, ...SHARED];
    const asListed = async (body: string) => {
      const listed = await opened.store.query(`SELECT ?g ?s ${viewGraphs.map(graph => `FROM NAMED <${graph}>`).join(' ')} `
        + `WHERE { VALUES ?g { ${viewGraphs.map(graph => `<${graph}>`).join(' ')} } GRAPH ?g { ${body} } }`);
      return rows(listed.type === 'bindings' ? listed.bindings : []);
    };
    const failingBody = `?s <urn:label> ?l BIND(IF(?missing, <${SHARED[0]}>, <${SHARED[1]}>) AS ?g)`;
    const failing = await engine.query(`SELECT ?g ?s WHERE { GRAPH ?g { ${failingBody} } }`, shared);
    expect(rows(failing.bindings)).toEqual(rows(plain.bindings));
    expect(rows(failing.bindings)).toEqual(await asListed(failingBody));
    const perRowBody = `?s <urn:label> ?l BIND(IF(?s = <urn:shared>, <${SHARED[0]}>, <${DATA[1]}>) AS ?g)`;
    const perRow = await engine.query(`SELECT ?g ?s WHERE { GRAPH ?g { ${perRowBody} } }`, shared);
    // Only the rows whose assigned value is the graph that holds them.
    expect(rows(perRow.bindings)).toEqual(rows([{ g: SHARED[0], s: 'urn:shared' }]));
    // An OPTIONAL assignment that names another graph fails only its OPTIONAL: every graph keeps its rows, as with the graph list.
    const optionalBody = `?s <urn:label> ?l OPTIONAL { BIND(<${SHARED[0]}> AS ?g) }`;
    const optional = await engine.query(`SELECT ?g ?s WHERE { GRAPH ?g { ${optionalBody} } }`, shared);
    expect(rows(optional.bindings)).toEqual(rows(plain.bindings));
    expect(rows(optional.bindings)).toEqual(await asListed(optionalBody));
    expect(plain.bindings.length).toBeGreaterThan(labelled.length);
  });

  it('binds the graph only by the assignments that reach its block, and keeps the graph binding for other reads', async () => {
    const engine = new DKGQueryEngine(opened.store);
    const shared: QueryOptions = { contextGraphId: ID, view: 'shared-working-memory' };
    const perGraph = (bindings: readonly Record<string, string>[]) => bindings.map(row => `${row.g} ${row.s}`).sort();
    const read = async (body: string) => perGraph((await engine.query(`SELECT ?g ?s WHERE { GRAPH ?g { ${body} } }`, shared)).bindings);
    const viewGraphs = [`${ROOT}/_shared_memory`, ...SHARED];
    const asListed = async (body: string) => {
      const listed = await opened.store.query(`SELECT ?g ?s ${viewGraphs.map(graph => `FROM NAMED <${graph}>`).join(' ')} `
        + `WHERE { VALUES ?g { ${viewGraphs.map(graph => `<${graph}>`).join(' ')} } GRAPH ?g { ${body} } }`);
      return perGraph(listed.type === 'bindings' ? listed.bindings : []);
    };
    const plain = await read('?s <urn:label> ?l');
    const inGraph = (graph: string) => plain.filter(row => row.startsWith(`${graph} `));
    expect(inGraph(SHARED[0]).length).toBeGreaterThan(0);
    expect(inGraph(SHARED[1]).length).toBeGreaterThan(0);
    // An assignment inside MINUS binds nothing for the block: the rows are those the graph list gives.
    const minus = `?s <urn:label> ?l MINUS { BIND(<${SHARED[0]}> AS ?g) }`;
    expect(await read(minus)).toEqual(await asListed(minus));
    expect(await read(minus)).toEqual(inGraph(SHARED[1]));
    // A read of the graph variable beside an assignment that fails, or an OPTIONAL one that finds nothing, reads the graph.
    const failing = `?s <urn:label> ?l BIND(IF(?missing, <${SHARED[0]}>, <${SHARED[1]}>) AS ?g) FILTER(?g = <${SHARED[0]}>)`;
    expect(await read(failing)).toEqual(await asListed(failing));
    expect(await read(failing)).toEqual(inGraph(SHARED[0]));
    const optional = `?s <urn:label> ?l OPTIONAL { ?s <urn:p> ?x BIND(<${SHARED[0]}> AS ?g) } FILTER(?g = <${SHARED[1]}>)`;
    expect(await read(optional)).toEqual(await asListed(optional));
    expect(await read(optional)).toEqual(inGraph(SHARED[1]));
    // A variable of the block's EXISTS stays out of scope after the block.
    const hidden = await engine.query(`SELECT ?g ?hidden WHERE { GRAPH ?g { BIND(<${SHARED[0]}> AS ?g) FILTER EXISTS { ?hidden <urn:p> ?o } } BIND(1 AS ?hidden) }`, shared);
    expect(hidden.bindings.map(row => row.g)).toEqual([SHARED[0]]);
    expect(hidden.bindings[0]?.hidden).toMatch(/^"?1"?/);
    // With a subquery, an assignment that fails keeps the graph list: every row as the read with that list gives it, each as often.
    const subquery = `?s <urn:label> ?l { SELECT (IF(?missing, <${SHARED[0]}>, <${SHARED[1]}>) AS ?g) WHERE {} }`;
    expect(await read(subquery)).toEqual(await asListed(subquery));
    expect(await read(subquery)).toEqual(plain);
  });

  it('applies a minimum trust level to a path that can match without a triple', async () => {
    const trusted = 'dataset-stores-trust';
    const asset = `did:dkg:context-graph:${trusted}/_verifiable_memory/0xa/1`;
    await opened.store.insert([
      { subject: 'urn:trust:x', predicate: 'urn:p', object: 'urn:trust:y', graph: asset },
      { subject: 'urn:trust:x', predicate: TRUST_LEVEL_PREDICATE, object: `"${TrustLevel.Endorsed}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: asset },
      { subject: 'urn:trust:u', predicate: 'urn:p', object: 'urn:trust:v', graph: asset },
    ]);
    const engine = new DKGQueryEngine(opened.store);
    const options: QueryOptions = { contextGraphId: trusted, view: 'verifiable-memory', minTrust: TrustLevel.Endorsed };
    const objects = async (sparql: string) => (await engine.query(sparql, options)).bindings.map(row => row.o).sort();
    for (const path of ['*', '?']) {
      expect(await objects(`SELECT ?o WHERE { <urn:trust:x> <urn:p>${path} ?o }`), path).toEqual(['urn:trust:x', 'urn:trust:y']);
      // A subject without trust metadata gives nothing.
      expect(await objects(`SELECT ?o WHERE { <urn:trust:u> <urn:p>${path} ?o }`), path).toEqual([]);
    }
  });

  it('reads a triple that two graphs of the view hold once, on a path that can match without a triple', async () => {
    const mirrored = 'dataset-stores-mirror';
    const mirrorRoot = `did:dkg:context-graph:${mirrored}`;
    await opened.store.insert([mirrorRoot, `${mirrorRoot}/_verifiable_memory/0xa/1`]
      .map(graph => ({ subject: 'urn:mirror:x', predicate: 'urn:p', object: 'urn:mirror:y', graph })));
    const engine = new DKGQueryEngine(opened.store);
    const view: QueryOptions = { contextGraphId: mirrored, view: 'verifiable-memory' };
    const read = async (sparql: string) => (await engine.query(sparql, view)).bindings.map(row => [row.s, row.o].filter(Boolean).join(' ')).sort();
    expect(await read('SELECT ?o WHERE { <urn:mirror:x> <urn:p>* ?o }')).toEqual(['urn:mirror:x', 'urn:mirror:y']);
    expect(await read('SELECT ?s ?o WHERE { ?s <urn:p> ?o . ?s <urn:p>* ?o }')).toEqual(['urn:mirror:x urn:mirror:y']);
  });

  it('answers as a store that holds only the view\'s graphs: an assignment beside a nested GRAPH, a volatile OPTIONAL binding', async () => {
    const only = new OxigraphStore();
    try {
      await only.insert(quadsOf(DATA));
      const engine = new DKGQueryEngine(opened.store);
      const view: QueryOptions = { contextGraphId: ID, view: 'verifiable-memory' };
      const rows = (bindings: readonly Record<string, string>[]) => bindings.map(row => JSON.stringify(Object.entries(row).sort())).sort();
      for (const query of [
        `SELECT ?g ?s WHERE { GRAPH ?g { GRAPH <${DATA[1]}> { ?s <urn:label> ?l } BIND(<${DATA[2]}> AS ?g) } }`,
        'SELECT (COUNT(DISTINCT ?x) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o OPTIONAL { BIND(UUID() AS ?x) } } }',
      ]) {
        const reference = await only.query(query);
        const answer = rows(reference.type === 'bindings' ? reference.bindings : []);
        expect(answer.length, query).toBeGreaterThan(0);
        expect(rows((await engine.query(query, view)).bindings), query).toEqual(answer);
      }
    } finally {
      await only.close();
    }
  });

  it('counts the matches of a pattern without variables in every graph of the view', async () => {
    const counted = 'dataset-stores-count';
    const members = [`did:dkg:context-graph:${counted}/_verifiable_memory/0xa/1`, `did:dkg:context-graph:${counted}/_verifiable_memory/0xb/2`];
    await opened.store.insert([
      { subject: 'urn:count:a', predicate: 'urn:p', object: 'urn:count:target', graph: members[0] },
      { subject: 'urn:count:b', predicate: 'urn:p', object: 'urn:count:target', graph: members[1] },
    ]);
    const query = 'SELECT (COUNT(*) AS ?n) WHERE { [] <urn:p>/<urn:q>* <urn:count:target> }';
    const scoped = await new DKGQueryEngine(opened.store).query(query, { contextGraphId: counted, view: 'verifiable-memory' });
    // As the same query over a default graph made of the view's graphs alone.
    const reference = await opened.store.query(query.replace(' WHERE', ` ${members.map(graph => `FROM <${graph}>`).join(' ')} WHERE`));
    expect(scoped.bindings).toEqual(reference.type === 'bindings' ? reference.bindings : []);
    expect(scoped.bindings[0]?.n).toMatch(/^"?2"?/);
  });

  it('answers a constant graph assignment on a view with more graphs than the branches allow', async () => {
    const wide = 'dataset-stores-wide';
    const wideRoot = `did:dkg:context-graph:${wide}`;
    const members = Array.from({ length: 130 }, (_, i) => `${wideRoot}/_verifiable_memory/0xa/${i + 1}`);
    await opened.store.insert(members.map((graph, i) => ({ subject: `urn:wide:s${i + 1}`, predicate: 'urn:p', object: `"w${i + 1}"`, graph })));
    const engine = new DKGQueryEngine(opened.store);
    const view: QueryOptions = { contextGraphId: wide, view: 'verifiable-memory' };
    // An assignment without a subquery reads under another name: the one match, once, with or without caller VALUES.
    for (const values of [`VALUES ?g { <${members[0]}> }`, '']) {
      const result = await engine.query(`SELECT ?s WHERE { ${values} GRAPH ?g { BIND(<${members[0]}> AS ?g) ?s <urn:p> ?o } }`, view);
      expect(result.bindings, values).toEqual([{ s: 'urn:wide:s1' }]);
    }
    // One in a subquery, over more graphs than the branches allow, keeps the graph list the engine writes:
    // every row as the read with that list gives it, each as often.
    const body = `GRAPH ?g { ?s <urn:p> ?o { SELECT (<${members[0]}> AS ?g) WHERE {} } }`;
    const query = vi.spyOn(opened.store, 'query');
    let sent: string[] = [];
    try {
      const result = await engine.query(`SELECT ?s WHERE { ${body} }`, view);
      sent = query.mock.calls.map(([text]) => text).filter(text => text.includes(`<${members[0]}> AS ?g`));
      expect(sent).toHaveLength(1);
      // The view's graphs, known apart from what the engine sends: its root and every member.
      const viewGraphs = [wideRoot, ...members].map(graph => `<${graph}>`);
      const listed = /VALUES \?g \{([^}]*)\}/.exec(sent[0]!)?.[1]?.trim().split(/\s+/) ?? [];
      expect([...listed].sort()).toEqual([...viewGraphs].sort());
      const named = viewGraphs.map(graph => `FROM NAMED ${graph}`).join(' ');
      const expected = await opened.store.query(`SELECT ?s ${named} WHERE { VALUES ?g { ${viewGraphs.join(' ')} } ${body} }`);
      const counted = (bindings: readonly Record<string, string>[]) => bindings.map(row => row.s).sort();
      expect(counted(result.bindings)).toEqual(counted(expected.type === 'bindings' ? expected.bindings : []));
      expect(result.bindings.length).toBeGreaterThan(0);
    } finally {
      query.mockRestore();
    }
  });

  it('leaves graphs the store does not hold out of patterns that need no triple', async () => {
    const engine = new DKGQueryEngine(opened.store);
    // The data route allows its metadata graphs and the shared-memory view its bucket; this store holds neither.
    expect((await engine.query(`ASK { GRAPH <${ROOT}/_meta> {} }`, { contextGraphId: ID })).bindings).toEqual([{ result: 'false' }]);
    // A path that can match without a triple does not make a graph the store lacks present.
    expect((await engine.query(`ASK { GRAPH <${ROOT}/_meta> { <urn:x> <urn:p>* <urn:x> } }`, { contextGraphId: ID })).bindings).toEqual([{ result: 'false' }]);
    for (const filter of ['<http://www.w3.org/2001/XMLSchema#boolean>(1)', 'xsd:boolean(1)']) {
      const ask = `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> ASK { GRAPH <${ROOT}/_meta> { FILTER ${filter} } }`;
      expect((await engine.query(ask, { contextGraphId: ID })).bindings, filter).toEqual([{ result: 'false' }]);
    }
    const listed = await engine.query('SELECT ?g WHERE { GRAPH ?g {} }', { contextGraphId: ID });
    expect(listed.bindings.map(row => row.g).sort()).toEqual([...DATA].sort());
    const optional = await engine.query('SELECT ?s WHERE { OPTIONAL { ?s <urn:p> ?o } }', { contextGraphId: ID, view: 'shared-working-memory' });
    expect(optional.bindings.length).toBeGreaterThan(0);
    expect(optional.bindings.every(row => row.s !== undefined)).toBe(true);
  });
});

// Blazegraph itself leaves projected EXISTS unbound and rejects HAVING EXISTS
// (verified on 2.1.5 and 2.1.6). Use the conforming in-process backend to verify
// both dataset policies; live tests separately prove mixed GRAPH/default joins.
describe.each(['oxigraph', null] as const)('outer default-graph expressions (%s)', engine => {
  it('keeps authorized projection, HAVING and ORDER BY matches and excludes unlisted flags', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        { subject: 'urn:s:1', predicate: 'urn:p', object: 'urn:o', graph: graphs[0] },
        { subject: 'urn:s:2', predicate: 'urn:p', object: 'urn:o', graph: graphs[1] },
        { subject: 'urn:s:2', predicate: 'urn:flag', object: '"allowed"', graph: graphs[1] },
        { subject: 'urn:s:1', predicate: 'urn:flag', object: '"hidden"', graph: 'urn:unlisted' },
      ]);
      const query = async (source: string) => (await store.query(ready(rewriteGraphSet(scope(source), graphs, 'deduplicated-values-union', engine)))).bindings;
      const found = await query('SELECT ?s (EXISTS { ?s <urn:flag> ?flag } AS ?flagged) WHERE { ?s <urn:p> ?o } ORDER BY ?s');
      expect(found).toHaveLength(2);
      expect(found[0].flagged).toContain('false');
      expect(found[1].flagged).toContain('true');
      expect(await query('SELECT ?s WHERE { ?s <urn:p> ?o } GROUP BY ?s HAVING(EXISTS { ?s <urn:flag> ?flag })')).toEqual([{ s: 'urn:s:2' }]);
      expect(await query('SELECT ?s WHERE { ?s <urn:p> ?o } ORDER BY DESC(EXISTS { ?s <urn:flag> ?flag }) ?s')).toEqual([{ s: 'urn:s:2' }, { s: 'urn:s:1' }]);
    } finally { await store.close(); }
  });
});

describe('content discovery for static GRAPH queries', () => {
  const meta = 'did:dkg:context-graph:discovery/_meta';
  const graph = `GRAPH <${meta}> { ?ka <urn:rootEntity> ?s }`;
  it.each([
    [`SELECT ?s WHERE { ${graph} }`, false],
    [`SELECT ?s WHERE { ${graph} FILTER(BOUND(?s)) }`, false],
    [`SELECT ?s WHERE { ${graph} BIND(1 AS ?n) VALUES ?x { <urn:x> } }`, false],
    [`SELECT ?s WHERE { ${graph} OPTIONAL { GRAPH <${meta}> { ?ka ?p ?o } } }`, false],
    [`SELECT ?s WHERE { ${graph} ?s <urn:flag> ?flag }`, true],
    [`SELECT ?s WHERE { ${graph} FILTER(EXISTS { ?s <urn:flag> ?flag }) }`, true],
    [`SELECT ?s WHERE { ${graph} FILTER(EXISTS { GRAPH <${meta}> { ?s ?p ?o } }) }`, false],
    [`SELECT ?s (EXISTS { ?s <urn:flag> ?flag } AS ?hit) WHERE { ${graph} }`, true],
    [`SELECT ?s (EXISTS { GRAPH <${meta}> { ?s ?p ?o } } AS ?hit) WHERE { ${graph} }`, false],
    ...['WHERE', ''].flatMap(where => [
      [`SELECT ?s WHERE { { SELECT ?s (EXISTS { ?s <urn:flag> ?flag } AS ?hit) ${where} { ${graph} } } }`, true] as const,
      [`SELECT ?s WHERE { { SELECT ?s (EXISTS { GRAPH <${meta}> { ?s ?p ?o } } AS ?hit) ${where} { ${graph} } } }`, false] as const,
    ]),
  ] as const)('discovers content only when needed: %s', (source, needed) => {
    const plan = resolveQueryReadPlan(scope(source), { contextGraphId: 'discovery' }, null);
    expect(plan.kind).toBe('scoped');
    if (plan.kind !== 'scoped') throw new Error('Expected a scoped read');
    expect(plan.discovery.contentPrefixes.length > 0).toBe(needed);
  });

  it('gives a static GRAPH read a default graph on Oxigraph only where it reads one', () => {
    expect(planGraphDataset(scope(`SELECT ?s WHERE { ${graph} FILTER(BOUND(?s)) }`), 'oxigraph').datasetClauses).toEqual(['FROM NAMED']);
    expect(planGraphDataset(scope(`SELECT ?s WHERE { ${graph} FILTER(EXISTS { ?s <urn:flag> ?flag }) }`), 'oxigraph').datasetClauses).toEqual(['FROM', 'FROM NAMED']);
  });
});
