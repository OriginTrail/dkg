import { readSparqlQueryBoundaries } from '../src/sparql.js';
import { describe, expect, it } from 'vitest';
import {
  prepareSparql, prepareSparqlQuery, indexSparqlStructure, sparqlTokenIndexesAtDepth, isSparqlKeyword,
} from '../src/sparql.js';

function query(source: string) {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error(`Invalid lexical fixture: ${source}`);
  return prepareSparqlQuery(prepared);
}

describe('prepared query boundaries', () => {
  it('shares keyword classification without treating payload words as syntax', () => {
    const { tokens } = query('SELECT ("demo"@select AS ?label) WITH { SELECT ?s { ?s ?p ?o } } AS %select { INCLUDE %select }').prepared;
    expect(tokens.filter((_token, index) => isSparqlKeyword(tokens, index, 'SELECT'))).toHaveLength(2);
    expect(tokens.filter((_token, index) => isSparqlKeyword(tokens, index, 'INCLUDE'))).toHaveLength(1);
  });
  it.each(['limit', 'order', 'values', 'offset', 'having', 'group', 'where', 'from', 'service', 'graph', 'union', 'with', String.raw`l\u0069mit`])('keeps named solution set %s outside keyword scanning', (name) => {
    for (const keyword of ['WHERE ', '']) {
      const body = `{ INCLUDE %${name} }`;
      const source = `SELECT ?s WITH { SELECT ?s WHERE { ?s ?p ?o } } AS %${name} ${keyword}${body}`;
      const result = query(source);
      expect(source.slice(result.where!.openStart, result.where!.close + 1)).toBe(body);
      expect(result.datasetInsertionOffset).toBe(source.indexOf('WITH'));
      expect(result.readsOnlyDeclaredNamedSet).toBe(true);
      expect(result.where!.hasUnion).toBe(false);
      expect(result.hasDatasetClause).toBe(false);
      expect(result.hasServiceClause).toBe(false);
      expect(result.hasGraphClause).toBe(false);
      expect(result.solutionModifiers).toEqual({ hasLimit: false, hasOffset: false, hasOrderBy: false, insertionOffset: source.length });
    }
  });

  it('does not use a WITH declaration as a missing outer pattern', () => {
    expect(query('SELECT ?s WITH { SELECT ?s WHERE { ?s ?p ?o } } AS %limit').where).toBeNull();
  });

  it('keeps real modifiers after multiple named declarations', () => {
    const source = 'SELECT ?s WITH { SELECT ?s { ?s ?p ?o } } AS %limit WITH { SELECT ?s { INCLUDE %limit } } AS %values { INCLUDE %values } ORDER BY ?s LIMIT 2 OFFSET 1';
    const result = query(source);
    expect(source.slice(result.where!.openStart, result.where!.close + 1)).toBe('{ INCLUDE %values }');
    expect(result.readsOnlyDeclaredNamedSet).toBe(true);
    expect(result.solutionModifiers).toEqual({ hasLimit: true, hasOffset: true, hasOrderBy: true, insertionOffset: source.length });
  });

  it('matches decoded named-set identities across different source spellings', () => {
    expect(query(String.raw`SELECT ?s W\u0049TH { SELECT ?s { ?s ?p ?o } } AS %l\u0069mit { INCL\u0055DE %limit }`)
      .readsOnlyDeclaredNamedSet).toBe(true);
  });

  it.each([
    'SELECT ?s { INCLUDE %x }',
    'SELECT ?s WITH { SELECT ?s { ?s ?p ?o } } AS %x { INCLUDE %y }',
    'SELECT ?s WITH { SELECT ?s { ?s ?p ?o } } AS %x { INCLUDE %X }',
    'SELECT ?s WITH { SELECT ?s { ?s ?p ?o } } AS %x { INCLUDE %x ?s ?p ?o }',
    'SELECT ?s WITH { SELECT ?s { ?s ?p ?o } } AS %x',
    'SELECT ?s { { SELECT ?s WITH { SELECT ?s { ?s ?p ?o } } AS %x { INCLUDE %x } } INCLUDE %x }',
  ])('does not bypass rewriting for a non-sole or undeclared named set: %s', (source) => {
    expect(query(source).readsOnlyDeclaredNamedSet).toBe(false);
  });

  it.each(['group', 'having', 'order', 'limit', 'offset', 'values', 'where'])('keeps a projection language tag @%s outside keyword scanning', (tag) => {
    for (const keyword of ['WHERE ', '']) {
      const source = `SELECT ("demo"@${tag} AS ?label) ${keyword}{ ?s ?p ?o }`;
      const result = query(source);
      expect(result.where?.openStart).toBe(source.indexOf('{'));
      expect(result.datasetInsertionOffset).toBe(keyword ? source.indexOf('WHERE') : source.indexOf('{'));
    }
  });

  it.each([
    ['SELECT (EXISTS { ?a ?b ?c } AS ?x) WHERE { ?s ?p ?o }', 'WHERE'],
    ['CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', 'WHERE'],
    ['SELECT ?s WITH { SELECT ?s WHERE { ?s ?p ?o } } AS %x { INCLUDE %x }', 'WITH'],
    ['DESCRIBE <urn:s> LIMIT 1', 'LIMIT'],
    ['DESCRIBE ?s VALUES ?s { <urn:s> }', 'VALUES'],
  ])('owns the dataset boundary for %s', (source, boundary) => {
    expect(query(source).datasetInsertionOffset).toBe(source.indexOf(boundary));
  });

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

describe('query boundaries within a token range', () => {
  it.each([
    ['SELECT (EXISTS { ?a ?b ?c } AS ?hit) WHERE { ?s ?p ?o }', '{ ?s ?p ?o }'],
    ['SELECT (EXISTS { ?a ?b ?c } AS ?hit) { ?s ?p ?o }', '{ ?s ?p ?o }'],
    ['SELECT (EXISTS { ?a ?b ?c } AS ?hit) { ?s ?p ?o } ORDER BY (EXISTS { ?x ?y ?z }) LIMIT 2', '{ ?s ?p ?o }'],
    ['SELECT ("text"@where AS ?label) { ?s ?p ?o } VALUES ?s { <urn:s> }', '{ ?s ?p ?o }'],
    ['SELECT ?s { ?s ?p ?o } GROUP BY ?s HAVING(EXISTS { ?s ?x ?y })', '{ ?s ?p ?o }'],
    ['SELECT ?s WITH { SELECT ?s { ?s ?p ?o } } AS %x { INCLUDE %x }', '{ INCLUDE %x }'],
    [String.raw`SELECT ?s WHERE \u007B ?s ?p ?o \u007D`, String.raw`\u007B ?s ?p ?o \u007D`],
  ])('shares outer and nested recognition without rebasing coordinates: %s', (source, body) => {
    const outer = query(source);
    const prefix = 'SELECT * WHERE { { ';
    const wrapped = query(`${prefix}${source} } GRAPH <urn:later> { ?later ?p ?o } } ORDER BY ?later`);
    const operationTokenIndex = wrapped.prepared.tokens.findIndex(token => token.start === prefix.length);
    const endTokenIndex = wrapped.prepared.tokens.findIndex(token => token.start >= prefix.length + source.length);
    const nested = readSparqlQueryBoundaries(wrapped.prepared, wrapped.structure, { operationTokenIndex, endTokenIndex });
    expect(outer.where).not.toBeNull();
    expect(nested.where).not.toBeNull();
    if (!outer.where || !nested.where) throw new Error('Expected query patterns');
    expect(outer.source.slice(outer.where.openStart, outer.prepared.tokens[outer.where.closingTokenIndex].end)).toBe(body);
    expect(wrapped.source.slice(nested.where.openStart, wrapped.prepared.tokens[nested.where.closingTokenIndex].end)).toBe(body);
    expect(nested.where.openStart).toBe(outer.where.openStart + prefix.length);
    expect(nested.where.openEnd).toBe(outer.where.openEnd + prefix.length);
    expect(nested.where.close).toBe(outer.where.close + prefix.length);
    expect(nested.where.openingTokenIndex).toBe(outer.where.openingTokenIndex + operationTokenIndex);
    expect(nested.where.closingTokenIndex).toBe(outer.where.closingTokenIndex + operationTokenIndex);
    expect(nested.datasetInsertionOffset).toBe(outer.datasetInsertionOffset! + prefix.length);
  });

  it('does not take a missing nested pattern from its next sibling', () => {
    const scope = query('SELECT * WHERE { { SELECT ?s } { ?later ?p ?o } }');
    const operationTokenIndex = scope.prepared.tokens.findIndex((token, index) => index > 0 && token.kind === 'word' && token.upper === 'SELECT');
    const endTokenIndex = scope.prepared.tokens.findIndex((token, index) => index > operationTokenIndex && token.logicalValue === '}');
    expect(readSparqlQueryBoundaries(scope.prepared, scope.structure, { operationTokenIndex, endTokenIndex }))
      .toEqual({ where: null, datasetInsertionOffset: null });
  });
});
