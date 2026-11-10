import { describe, expect, it } from 'vitest';
import { materializePreparedSparql, prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { prepareGraphScope } from '../src/sparql-graph-scope.js';
import {
  hideReadGraphPartitions, readGraphPartitionExclusionFilter, UnscopedReadGraphQueryError,
} from '../src/unscoped-read-graph-scope.js';

function scope(source: string) {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error('Expected valid test input');
  return prepareGraphScope(prepared);
}
const hidden = (source: string) => materializePreparedSparql(hideReadGraphPartitions(scope(source)).prepared);
const exists = (holder: string, triple: string) =>
  `FILTER EXISTS { GRAPH ${holder} { ${triple} } ${readGraphPartitionExclusionFilter(holder)} }`;

describe('patterns outside GRAPH', () => {
  it('keep their pattern and gain an existence check in a graph outside the partitions', () => {
    expect(hidden('SELECT ?s WHERE { ?s ?p ?o }'))
      .toBe(`SELECT ?s WHERE { ?s ?p ?o . ${exists('?_holder', '?s ?p ?o')} }`);
    expect(hidden('SELECT ?s WHERE { ?s <urn:p> ?x ; <urn:q> ?y , ?z . }')).toBe(`SELECT ?s WHERE { ?s <urn:p> ?x . ${exists('?_holder', '?s <urn:p> ?x')}`
      + ` ?s <urn:q> ?y . ${exists('?_holder0', '?s <urn:q> ?y')} ?s <urn:q> ?z . ${exists('?_holder1', '?s <urn:q> ?z')} }`);
  });

  it('reach every group outside GRAPH, and leave GRAPH groups to the graph filter', () => {
    const text = hidden([
      'SELECT ?s (EXISTS { ?s <urn:e> ?e } AS ?has) WHERE { ?s <urn:a> ?a OPTIONAL { ?s <urn:b> ?b } MINUS { ?s <urn:c> ?c }',
      'FILTER NOT EXISTS { ?s <urn:d> ?d } { ?s <urn:f> ?f } UNION { ?s <urn:g> ?g } { SELECT ?s WHERE { ?s <urn:h> ?h } }',
      'BIND(EXISTS { ?s <urn:i> ?i } AS ?j) VALUES ?v { 1 } GRAPH ?graph { ?s <urn:k> ?k } }',
    ].join(' '));
    for (const predicate of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) expect(text).toMatch(new RegExp(`GRAPH \\?_holder\\d* \\{ \\?s <urn:${predicate}> \\?${predicate} \\}`));
    expect(text).not.toMatch(/GRAPH \?_holder\d* \{ \?s <urn:k>/);
    expect(text).toContain(`GRAPH ?graph { ?s <urn:k> ?k } ${readGraphPartitionExclusionFilter('?graph')}`);
  });

  it('expand property paths into patterns of their own', () => {
    expect(hidden('SELECT ?s ?z WHERE { ?s <urn:p>/^<urn:r> ?z }')).toBe('SELECT ?s ?z WHERE { '
      + `?s <urn:p> ?_step . ${exists('?_holder', '?s <urn:p> ?_step')} ?z <urn:r> ?_step . ${exists('?_holder0', '?z <urn:r> ?_step')} }`);
    expect(hidden('SELECT ?s WHERE { ?s <urn:p>|<urn:q> ?o }')).toBe('SELECT ?s WHERE { '
      + `{ ?s <urn:p> ?o . ${exists('?_holder', '?s <urn:p> ?o')} } UNION { ?s <urn:q> ?o . ${exists('?_holder0', '?s <urn:q> ?o')} } }`);
    expect(hidden('SELECT ?s WHERE { ?s !(<urn:p>|^<urn:q>) ?o }')).toContain('FILTER(?_verb NOT IN (<urn:p>))');
  });

  it('keep counting stored quads in the fast counting form', () => {
    const graphForm = (triple: string) => `GRAPH ?_holder { ${triple} } ${readGraphPartitionExclusionFilter('?_holder')}`;
    expect(hidden('SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }')).toBe(`SELECT (COUNT(*) AS ?n) WHERE { ${graphForm('?s ?p ?o')} }`);
    expect(hidden('SELECT DISTINCT (COUNT(*) AS ?n) WHERE { { ?s <urn:p> ?o } } LIMIT 5'))
      .toBe(`SELECT DISTINCT (COUNT(*) AS ?n) WHERE { { ${graphForm('?s <urn:p> ?o')} } } LIMIT 5`);
    expect(hidden('SELECT ?s (COUNT(?o) AS ?n) WHERE { ?s ?p ?o } GROUP BY ?s'))
      .toBe(`SELECT ?s (COUNT(?o) AS ?n) WHERE { ${graphForm('?s ?p ?o')} } GROUP BY ?s`);
    expect(hidden('SELECT (COUNT(*) AS ?n) $s WHERE { ?s ?p ?o } GROUP BY ?s ORDER BY DESC(?n) LIMIT 3'))
      .toBe(`SELECT (COUNT(*) AS ?n) $s WHERE { ${graphForm('?s ?p ?o')} } GROUP BY ?s ORDER BY DESC(?n) LIMIT 3`);
    expect(hidden('SELECT ?n WHERE { { SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o } } }')).toContain(graphForm('?s ?p ?o'));
    // Not the fast form: these count solutions of the merged default graph.
    for (const query of [
      'SELECT (COUNT(?o) AS ?n) WHERE { ?s ?p ?o }',
      'SELECT (COUNT(DISTINCT *) AS ?n) WHERE { ?s ?p ?o }',
      'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o . ?o ?q ?r }',
      'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o FILTER(isIRI(?o)) }',
      'SELECT ?x (COUNT(*) AS ?n) WHERE { ?s ?p ?o } GROUP BY ?x',
      'SELECT ?s (COUNT(*) AS ?n) WHERE { ?s ?p ?o } GROUP BY ?s HAVING (COUNT(*) > 1)',
      'SELECT ?s ?p (COUNT(*) AS ?n) WHERE { ?s ?p ?o } GROUP BY ?s',
    ]) expect(hidden(query)).toContain('FILTER EXISTS');
  });

  it('write out the template of a short CONSTRUCT', () => {
    expect(hidden('CONSTRUCT WHERE { ?s <urn:p> ?o } LIMIT 3'))
      .toBe(`CONSTRUCT { ?s <urn:p> ?o } WHERE { ?s <urn:p> ?o . ${exists('?_holder', '?s <urn:p> ?o')} } LIMIT 3`);
  });

  it('describe as the store does, one step out and one step in', () => {
    const text = hidden('DESCRIBE <urn:a>');
    expect(text).toMatch(/^CONSTRUCT \{ <urn:a> \?_describedVerb \?_describedObject \. \?_describingSubject \?_describingVerb <urn:a> \. \} WHERE/);
    expect(text).toContain('UNION');
    expect(hidden('PREFIX ex: <urn:ex:> DESCRIBE ?s WHERE { ?s ex:p ?o }')).toMatch(/^PREFIX ex: <urn:ex:> CONSTRUCT/);
    // The description joins the WHERE solutions, as the store's DESCRIBE does.
    expect(hidden('DESCRIBE ?s WHERE { VALUES ?s { UNDEF } }')).toMatch(/WHERE \{\s+VALUES \?s \{ UNDEF \}\s+\{ \{ \?s /);
  });

  it.each([
    ['a repeated path', 'SELECT ?s WHERE { ?s <urn:p>* ?o }'],
    ['an RDF collection', 'SELECT ?s WHERE { ?s <urn:p> ( 1 2 ) }'],
    ['SELECT * with a blank node', 'SELECT * WHERE { ?s <urn:p> [ <urn:q> ?o ] }'],
    ['SELECT * with a sequence path', 'SELECT * WHERE { ?s <urn:p>/<urn:q> ?o }'],
    ['DESCRIBE *', 'DESCRIBE * WHERE { ?s ?p ?o }'],
    ['DESCRIBE of an IRI with WHERE', 'DESCRIBE <urn:a> WHERE { ?s ?p ?o }'],
    ['DESCRIBE with solution modifiers', 'DESCRIBE ?s WHERE { ?s ?p ?o } LIMIT 1'],
  ])('refuses %s', (_label, source) => {
    expect(() => hideReadGraphPartitions(scope(source))).toThrow(UnscopedReadGraphQueryError);
  });

  it('reach patterns outside GRAPH in the projection, ORDER BY and HAVING', () => {
    for (const query of [
      'SELECT ?s (EXISTS { ?s <urn:q> ?y } AS ?e) WHERE { GRAPH ?g { ?s ?p ?o } }',
      'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY (EXISTS { ?s <urn:q> ?y })',
      'SELECT ?s (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?s HAVING (EXISTS { ?s <urn:q> ?y })',
    ]) expect(hidden(query)).toMatch(/GRAPH \?_holder\d* \{ \?s <urn:q> \?y \}/);
  });

  it('reads an escaped a as rdf:type and refuses its repetition', () => {
    expect(hidden('SELECT ?s WHERE { ?s \\u0061 <urn:T> }')).toContain('?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:T>');
    expect(() => hideReadGraphPartitions(scope('SELECT ?s WHERE { ?s \\u0061* ?o }'))).toThrow(UnscopedReadGraphQueryError);
  });

  it('lets SELECT * through when nothing new comes into scope', () => {
    expect(hidden('SELECT * WHERE { ?s ?p ?o }')).toContain('FILTER EXISTS');
  });
});
