import { describe, expect, it } from 'vitest';
import {
  prepareSparql, prepareSparqlQuery, indexSparqlStructure, sparqlTokenIndexesAtDepth,
} from '../src/sparql.js';

function query(source: string) {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error(`Invalid lexical fixture: ${source}`);
  return prepareSparqlQuery(prepared);
}

describe('prepared query boundaries', () => {
  it('resolves declared and default graph prefixes and preserves direct IRI identity', () => {
    const result = query('BASE <urn:base:> PREFIX : <urn:default:> PREFIX ex: <urn:example:> SELECT * WHERE { GRAPH :one {} GRAPH ex:two {} GRAPH <urn:direct> {} }');
    expect([...result.prefixes]).toEqual([['', 'urn:default:'], ['ex', 'urn:example:']]);
    expect(result.graphTargets.map(t => t.kind === 'iri' ? t.iri : t.kind))
      .toEqual(['urn:default:one', 'urn:example:two', 'urn:direct']);
    expect(result.graphVariables).toEqual([]);
    expect(result.hasDatasetClause).toBe(false);
    expect(result.hasServiceClause).toBe(false);
    for (const target of result.graphTargets) {
      expect(target.braceDepth).toBe(1);
      expect(result.prepared.tokens[target.keywordTokenIndex].raw).toBe('GRAPH');
      expect(result.prepared.tokens[target.targetTokenIndex].start)
        .toBeGreaterThan(result.prepared.tokens[target.keywordTokenIndex].end);
    }
  });

  it.each(['GRAPH missing:name {}', 'GRAPH 123 {}', 'GRAPH'])
    ('marks an invalid graph operand instead of inventing an IRI (%s)', graph => {
      const result = query(`SELECT * WHERE { ${graph} }`);
      expect(result.hasGraphClause).toBe(true);
      expect(result.graphTargets).toHaveLength(1);
      expect(result.graphTargets[0].kind).toBe('invalid');
      expect(result.graphVariables).toEqual([]);
    });

  it('deduplicates variable identities across sigils and Unicode spellings', () => {
    const result = query(String.raw`SELECT ?outside ?g WHERE { GRAPH ?g { ?s ?p ?o } GRAPH $g {} GRAPH ?\u0067 {} SERVICE <urn:remote> { ?s ?p ?o } }`);
    expect(result.graphTargets.map(t => t.kind)).toEqual(['variable', 'variable', 'variable']);
    expect(result.graphVariables).toEqual([{ source: '?g', logicalName: 'g' }]);
    expect(result.whereVariables).toEqual([
      { source: '?g', logicalName: 'g' }, { source: '?s', logicalName: 's' },
      { source: '?p', logicalName: 'p' }, { source: '?o', logicalName: 'o' },
    ]);
    expect(result.queryVariables).toEqual([{ source: '?outside', logicalName: 'outside' }, ...result.whereVariables]);
    expect(result.hasServiceClause).toBe(true);
    expect(result.hasDatasetClause).toBe(false);
  });

  it.each(['SELECT * WHERE ?s', 'SELECT * WHERE { ?s ?p ?o', 'ASK', 'ASK } {'])
    ('does not invent a WHERE range for malformed group structure (%s)', source => {
      expect(query(source).where).toBeNull();
      expect(query(source).whereVariables).toEqual([]);
    });

  it('distinguishes a direct UNION from one nested in an inner group', () => {
    expect(query('SELECT * WHERE { { ?s ?p ?o } UNION { ?x ?y ?z } }').where?.hasUnion).toBe(true);
    expect(query('SELECT * WHERE { { { ?s ?p ?o } UNION { ?x ?y ?z } } }').where?.hasUnion).toBe(false);
  });

  it('chooses the data group rather than the CONSTRUCT template', () => {
    const source = 'CONSTRUCT { ?s ?p ?o } { ?s ?p ?o FILTER(?o > 1) }';
    expect(query(source).where).toMatchObject({
      openStart: source.lastIndexOf('{'), close: source.lastIndexOf('}'), hasUnion: false,
    });
  });

  it.each([
    ['SELECT ?s { ?s ?p ?o } ORDER BY (EXISTS { ?a ?b ?c })', '{ ?s ?p ?o }'],
    ['SELECT ?s { ?s ?p ?o } GROUP BY ?s HAVING (EXISTS { ?a ?b ?c })', '{ ?s ?p ?o }'],
    ['SELECT ?s { ?s ?p ?o } VALUES ?s { <urn:x> }', '{ ?s ?p ?o }'],
    ['SELECT ?s { ?s ?p ?o } LIMIT 1', '{ ?s ?p ?o }'],
    ['SELECT (EXISTS { ?a ?b ?c } AS ?x) { ?s ?p ?o }', '{ ?s ?p ?o }'],
    ['SELECT (EXISTS { ?a ?b ?c } AS ?x) WHERE { ?s ?p ?o } ORDER BY (EXISTS { ?d ?e ?f })', '{ ?s ?p ?o }'],
    ['SELECT (EXISTS { { SELECT ?a WHERE { ?a ?b ?c } } } AS ?x) { ?s ?p ?o }', '{ ?s ?p ?o }'],
    ['DESCRIBE ?s { ?s ?p ?o } ORDER BY (EXISTS { ?a ?b ?c })', '{ ?s ?p ?o }'],
    ['CONSTRUCT { ?a ?b ?c } { ?s ?p ?o } ORDER BY (EXISTS { ?d ?e ?f })', '{ ?s ?p ?o }'],
    ['SELECT ?s WITH { SELECT ?s WHERE { ?s ?p ?o } } AS %x { INCLUDE %x }', '{ INCLUDE %x }'],
    ['SELECT ?s WITH { SELECT ?s WHERE { ?s ?p ?o } } AS %x WHERE { INCLUDE %x } LIMIT 1', '{ INCLUDE %x }'],
  ])('chooses the pattern over any group in an expression or after it (%s)', (source, group) => {
    const { where } = query(source);
    expect(source.slice(where!.openStart, where!.close + 1)).toBe(group);
  });

  it.each(['', '?variable'])('has no operation for a non-keyword input (%s)', source => {
    expect(query(source).operation).toBeNull();
  });

  it('indexes mismatched delimiters without matching an unmatched closing delimiter', () => {
    const structure = indexSparqlStructure(prepareSparql('} { ( ) [ ]'));
    expect(structure.balanced).toBe(false);
    expect(structure.braces.balanced).toBe(false);
    expect(structure.braces.matchingTokenIndexes).toEqual([-1, -1, -1, -1, -1, -1]);
    expect(structure.parentheses.ranges).toEqual([{ openingTokenIndex: 2, closingTokenIndex: 3, depth: 0 }]);
    expect(structure.brackets.ranges).toEqual([{ openingTokenIndex: 4, closingTokenIndex: 5, depth: 0 }]);
    expect(sparqlTokenIndexesAtDepth(structure.parentheses, 1, 0, 6)).toEqual([3]);
    expect(Object.isFrozen(structure.braces.matchingTokenIndexes)).toBe(true);
  });
});

describe('lexical percent escapes and comparison boundaries', () => {
  it.each(['ex:%41', 'ex:a%aF', 'ex:%AFtail', 'ex:%09', String.raw`ex:%\u0034\u0031`])
    ('keeps valid percent escapes inside one prefixed name (%s)', name => {
      const prepared = prepareSparql(name);
      expect(prepared.status).toBe('valid');
      expect(prepared.tokens).toHaveLength(1);
      expect(prepared.tokens[0]).toMatchObject({ kind: 'prefixed-name', raw: name, start: 0, end: name.length });
    });

  it.each(['ex:%', 'ex:%G0', 'ex:%0G', 'ex:%A'])
    ('does not consume malformed percent escapes into a prefixed name (%s)', name => {
      const prepared = prepareSparql(name);
      expect(prepared.tokens[0]).toMatchObject({ kind: 'prefixed-name', raw: 'ex:', end: 3 });
      expect(prepared.tokens[1]).toMatchObject({ kind: 'symbol', raw: '%', start: 3 });
    });

  it.each(['true', 'false', '(?n + 1)'])('distinguishes a less-than operator after %s from an IRI opener', operand => {
    const prepared = prepareSparql(`SELECT * WHERE { FILTER(${operand}<3&&?limit>0) }`);
    expect(prepared.status).toBe('valid');
    expect(prepared.tokens.filter(t => t.kind === 'iri')).toEqual([]);
    expect(prepared.tokens.filter(t => t.kind === 'symbol' && t.logicalValue === '<')).toHaveLength(1);
    expect(prepared.tokens.filter(t => t.kind === 'variable').map(t => t.raw)).toContain('?limit');
  });
});
