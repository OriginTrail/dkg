import { describe, expect, it } from 'vitest';
import {
  materializePreparedSparql,
  prepareSparql,
  type PreparedSparql,
  type ValidPreparedSparql,
} from '../src/sparql-lexical-scanner.js';
import {
  indexSparqlStructure,
  sparqlTokenIndexesAtDepth,
} from '../src/sparql-structure.js';

function validPrepared(source: string): ValidPreparedSparql {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error('expected valid prepared SPARQL');
  return prepared;
}

describe('canonical SPARQL lexical scanner', () => {
  it('scans large ordinary IRIs without changing their lexical value', () => {
    const body = `urn:large:${'segment/'.repeat(16_384)}tail`;
    const prepared = prepareSparql(`SELECT * WHERE { GRAPH <${body}> { ?s ?p ?o } }`);

    expect(prepared.status).toBe('valid');
    if (prepared.status !== 'valid') return;
    expect(prepared.tokens.find((token) => token.kind === 'iri')).toMatchObject({
      kind: 'iri',
      logicalValue: body,
    });
  });

  it('keeps a large raw IRI on the raw path when inert text looks like UCHAR', () => {
    const body = `urn:large:${'segment/'.repeat(16_384)}tail`;
    const source = String.raw`SELECT * WHERE { GRAPH <${body}> { ?s ?p ?o } } # \u1234`;
    const prepared = prepareSparql(source);

    expect(prepared.status).toBe('valid');
    if (prepared.status !== 'valid') return;
    expect(prepared.tokens.find((token) => token.kind === 'iri')).toMatchObject({
      kind: 'iri',
      logicalValue: body,
    });
  });

  it.each([
    'foaf.core',
    'café',
    'δοκιμή',
  ])('recognizes PN_PREFIX label %s and reaches the operation token', (prefix) => {
    const scan = prepareSparql(
      `PREFIX ${prefix}: <http://example.com/> SELECT ?s WHERE { ?s ${prefix}:name ?n }`,
    );

    expect(scan.prologue.declaredPrefixes).toEqual([prefix]);
    expect(scan.tokens[scan.prologue.endTokenIndex]).toMatchObject({
      kind: 'word',
      upper: 'SELECT',
    });
  });

  it('recognizes an adjacent IRIREF in a compact BASE prologue', () => {
    const scan = prepareSparql('BASE<https://example.com/>SELECT * WHERE {}');

    expect(scan.prologue.endTokenIndex).toBe(2);
    expect(scan.tokens[1]).toMatchObject({ kind: 'iri' });
    expect(scan.tokens[2]).toMatchObject({ kind: 'word', upper: 'SELECT' });
  });

  it('returns one validity status plus raw offsets, prologue, and word facts', () => {
    const source = String.raw`BASE\u003Chttp://example.com/\u003E\u0053ELECT ?s{?s<1#item>?o}`;
    const prepared = prepareSparql(source);

    expect(prepared.status).toBe('valid');
    expect(prepared.unterminated).toBe(false);
    expect(prepared.prologue.endTokenIndex).toBe(2);
    expect(prepared.wordTokens.has('SELECT')).toBe(true);
    const relativeIri = prepared.tokens.find((token) => token.kind === 'iri' && token.start > 20);
    expect(relativeIri).toMatchObject({ kind: 'iri' });
    expect(source.slice(relativeIri!.start, relativeIri!.end)).toBe('<1#item>');
  });

  it('does not hide compact comparison variables inside a false IRIREF', () => {
    const prepared = validPrepared(
      'SELECT ?n WHERE { ?s <urn:p> ?n . FILTER(?n<100&&?__dkgDedupRank>0) }',
    );

    expect(prepared.tokens.filter((token) => token.kind === 'variable'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ logicalValue: '?n' }),
        expect.objectContaining({ logicalValue: '?__dkgDedupRank' }),
      ]));
    expect(prepared.tokens.some((token) => (
      token.kind === 'iri' && token.logicalValue.includes('__dkgDedupRank')
    ))).toBe(false);
  });

  it('preprocesses UCHAR escapes while preserving raw token offsets', () => {
    const source = String.raw`PREFIX \u0065x\u003A <http://example.com/> \u0053ELECT \u003Fs WHERE { \u003Fs \u0065x\u003Aname ?n }`;
    const scan = prepareSparql(source);

    expect(scan.prologue).toEqual({ endTokenIndex: 3, declaredPrefixes: ['ex'] });
    const operation = scan.tokens[scan.prologue.endTokenIndex];
    expect(operation).toMatchObject({
      kind: 'word',
      raw: String.raw`\u0053ELECT`,
      logicalValue: 'SELECT',
      upper: 'SELECT',
    });
    for (const token of scan.tokens) {
      expect(source.slice(token.start, token.end)).toBe(token.raw);
    }
    expect(scan.tokens).toContainEqual(expect.objectContaining({
      kind: 'variable',
      raw: String.raw`\u003Fs`,
      logicalValue: '?s',
    }));
    expect(scan.tokens.every((token) => !('normalizedStart' in token))).toBe(true);
    expect(scan.tokens.every((token) => !('normalizedEnd' in token))).toBe(true);
  });

  it('indexes UCHAR-spelled groups and nested expressions once for policy consumers', () => {
    const prepared = prepareSparql(
      String.raw`SELECT * WHERE \u007B ?s <urn:p> ?o . OPTIONAL \u007B FILTER((?o > 1)) \u007D \u007D`,
    );
    const structure = indexSparqlStructure(prepared);
    const openingIndexes = prepared.tokens
      .map((token, index) => ({ token, index }))
      .filter(({ token }) => (
        token.kind === 'symbol' && token.logicalValue === '{'
      ))
      .map(({ index }) => index);

    expect(structure.braces.balanced).toBe(true);
    expect(structure.parentheses.balanced).toBe(true);
    expect(structure.balanced).toBe(true);
    expect(openingIndexes).toHaveLength(2);
    expect(structure.braces.matchingTokenIndexes[openingIndexes[0]])
      .toBeGreaterThan(openingIndexes[1]);
    expect(structure.braces.depthBefore[openingIndexes[1]]).toBe(1);
    expect(structure.braces.ranges).toEqual([
      expect.objectContaining({ openingTokenIndex: openingIndexes[0], depth: 0 }),
      expect.objectContaining({ openingTokenIndex: openingIndexes[1], depth: 1 }),
    ]);
    expect(sparqlTokenIndexesAtDepth(
      structure.braces,
      2,
      openingIndexes[1] + 1,
      structure.braces.matchingTokenIndexes[openingIndexes[1]],
    ).length).toBeGreaterThan(0);
  });

  it.each([
    { family: 'braces', source: 'SELECT * WHERE { ?s ?p ?o' },
    { family: 'parentheses', source: 'SELECT * WHERE { FILTER(?o > 1 }' },
    { family: 'brackets', source: 'SELECT * WHERE { [ <urn:p> ?o . }' },
  ] as const)('reports aggregate imbalance for $family', ({ family, source }) => {
    const structure = indexSparqlStructure(prepareSparql(source));

    expect(structure[family].balanced).toBe(false);
    expect(structure.balanced).toBe(false);
  });

  it('derives an IRI value without promoting UCHAR payload to delimiters', () => {
    const encodedDelimiters = prepareSparql(
      String.raw`SELECT * WHERE { GRAPH \u003Curn:\u0061\u003E {} }`,
    );
    const encodedPayload = prepareSparql(
      String.raw`SELECT * WHERE { <urn:a\u003Eb> <urn:p> ?o }`,
    );

    expect(encodedDelimiters.tokens.find((token) => token.kind === 'iri')).toMatchObject({
      kind: 'iri',
      logicalValue: 'urn:a',
    });
    expect(encodedPayload.tokens.filter((token) => token.kind === 'iri')).toEqual([
      expect.objectContaining({ logicalValue: 'urn:a>b' }),
      expect.objectContaining({ logicalValue: 'urn:p' }),
    ]);
  });

  it('does not reinterpret escaped string backslashes as overlapping UCHARs', () => {
    const malformedLookalike = String.raw`SELECT ?x WHERE { BIND("\\u00ZZ" AS ?x) }`;
    const validLookalike = String.raw`SELECT ?x WHERE { BIND("\\u006E" AS ?x) }`;

    expect(materializePreparedSparql(validPrepared(malformedLookalike))).toBe(malformedLookalike);
    expect(materializePreparedSparql(validPrepared(validLookalike))).toBe(validLookalike);
  });

  it('rejects malformed UCHAR inside a string without treating an escaped slash as UCHAR', () => {
    expect(prepareSparql(String.raw`SELECT * WHERE { BIND("\u00ZZ" AS ?x) }`).status)
      .toBe('malformed-uchar');
    expect(prepareSparql(String.raw`SELECT * WHERE { BIND("\\u00ZZ" AS ?x) }`).status)
      .toBe('valid');
  });

  it.each([
    String.raw`SELECT * WHERE { BIND("\u0022" AS ?x) }`,
    String.raw`SELECT * WHERE { BIND('\u005C' AS ?x) }`,
    String.raw`SELECT * WHERE { BIND("""\u000A""" AS ?x) }`,
    String.raw`SELECT * WHERE { BIND('''\u0022''' AS ?x) }`,
  ])('keeps UCHAR string payload opaque in the policy view: %s', (source) => {
    const prepared = prepareSparql(source);

    expect(prepared.status).toBe('valid');
    expect(prepared.unterminated).toBe(false);
    expect(prepared.tokens.filter((token) => token.kind === 'string')).toHaveLength(1);
  });

  it('leaves UCHAR-like comment text inert while decoding active tokens', () => {
    const source = String.raw`\u0053ELECT * WHERE {} # \u00ZZ \u0053ERVICE`;

    expect(materializePreparedSparql(validPrepared(source)))
      .toBe(String.raw`SELECT * WHERE {} # \u00ZZ \u0053ERVICE`);
  });

  it('materializes active syntax while preserving opaque IRI, string, and comment payloads', () => {
    const source = String.raw`\u0053ELECT * WHERE \u007B <urn:\u0061> <urn:p> "\u0041" \u007D # \u0053ERVICE`;

    expect(materializePreparedSparql(validPrepared(source))).toBe(
      String.raw`SELECT * WHERE { <urn:\u0061> <urn:p> "\u0041" } # \u0053ERVICE`,
    );
  });

  it.each([
    String.raw`SELECT * WHERE { \u005Cu0053ERVICE <http://127.0.0.1/sparql> { ?s ?p ?o } }`,
    String.raw`SELECT * WHERE { \u005Cu0047RAPH <urn:private> { ?s ?p ?o } }`,
    String.raw`SELECT * \u005Cu0046ROM <urn:private> WHERE { ?s ?p ?o }`,
    String.raw`SELECT * WHERE {} \u005Cu0044ELETE DATA { <urn:s> <urn:p> <urn:o> }`,
    String.raw`SELECT * WHERE { \u005Cu0022 SERVICE <urn:remote> {} \u005Cu0022 }`,
  ])('rejects second-generation active UCHAR syntax: %s', (source) => {
    expect(prepareSparql(source).status).toBe('malformed-uchar');
  });

  it.each([
    String.raw`SELECT * WHERE { BIND("\u005Cu0053ERVICE" AS ?x) }`,
    String.raw`SELECT * WHERE { <urn:\u005Cu0053ERVICE> <urn:p> ?o }`,
    String.raw`SELECT * WHERE {} # \u005Cu0053ERVICE`,
  ])('keeps second-generation-looking UCHAR text inert in opaque regions: %s', (source) => {
    const prepared = prepareSparql(source);
    expect(prepared.status).toBe('valid');
    if (prepared.status === 'valid') {
      expect(materializePreparedSparql(prepared)).toBe(source);
    }
  });

  it('does not type malformed lexical artifacts as execution-ready', () => {
    type Malformed = Extract<PreparedSparql, { status: 'malformed-uchar' }>;
    type MaterializerAcceptsMalformed = Malformed extends Parameters<
      typeof materializePreparedSparql
    >[0] ? true : false;
    const materializerAcceptsMalformed: MaterializerAcceptsMalformed = false;

    expect(materializerAcceptsMalformed).toBe(false);
    expect(prepareSparql(String.raw`SELECT ?\u00ZZ WHERE {}`).status)
      .toBe('malformed-uchar');
  });

  it('does not let an escaped newline terminate an already-open comment', () => {
    const prepared = prepareSparql(String.raw`SELECT * WHERE {} # \u000A INSERT DATA {}`);

    expect(prepared.wordTokens.has('SELECT')).toBe(true);
    expect(prepared.wordTokens.has('INSERT')).toBe(false);
  });

  it.each([
    String.raw`PREFIX \u00G0x: <http://example.com/> SELECT * WHERE {}`,
    String.raw`PREFIX \uD800x: <http://example.com/> SELECT * WHERE {}`,
    String.raw`PREFIX \U00110000x: <http://example.com/> SELECT * WHERE {}`,
  ])('fails closed for malformed or non-scalar UCHAR names: %s', (source) => {
    const prepared = prepareSparql(source);
    expect(prepared.status).toBe('malformed-uchar');
    expect(prepared.prologue).toEqual({ endTokenIndex: 0, declaredPrefixes: [] });
  });

  it('accepts a valid eight-hex-digit UCHAR in a prefix label', () => {
    const scan = prepareSparql(
      String.raw`PREFIX \U000003B1: <http://example.com/> SELECT * WHERE {}`,
    );
    expect(scan.prologue).toEqual({ endTokenIndex: 3, declaredPrefixes: ['α'] });
  });

  it('uses PN_LOCAL and VARNAME boundaries around operators', () => {
    const scan = prepareSparql(
      String.raw`?1count ?x-STRCONTAINS() ex:value=STRCONTAINS() ex:local.name. ex:escaped\=value`,
    );
    const tokens = scan.tokens.map((token) => `${token.kind}:${token.raw}`);

    expect(tokens).toEqual([
      'variable:?1count',
      'variable:?x',
      'symbol:-',
      'word:STRCONTAINS',
      'symbol:(',
      'symbol:)',
      'prefixed-name:ex:value',
      'symbol:=',
      'word:STRCONTAINS',
      'symbol:(',
      'symbol:)',
      'prefixed-name:ex:local.name',
      'symbol:.',
      String.raw`prefixed-name:ex:escaped\=value`,
    ]);
  });

  it('emits complete signed and unsigned numeric literal tokens', () => {
    const scan = validPrepared(
      'SELECT * WHERE { ?s <urn:p> .5, -.5, +.5, 1.5, 1e2, -1.E+2, 1. }',
    );
    const numericTokens = scan.tokens
      .filter((token) => token.kind === 'number')
      .map((token) => token.logicalValue);
    const trailingPoint = scan.tokens.findIndex(
      (token) => token.kind === 'number' && token.logicalValue === '1',
    );

    expect(numericTokens).toEqual(['.5', '-.5', '+.5', '1.5', '1e2', '-1.E+2', '1']);
    expect(scan.tokens[trailingPoint + 1]).toMatchObject({
      kind: 'symbol',
      logicalValue: '.',
    });
  });

  it('recognizes a default prefix declaration without accepting a local part', () => {
    expect(prepareSparql('PREFIX : <urn:default:> SELECT * WHERE {}').prologue)
      .toEqual({ endTokenIndex: 3, declaredPrefixes: [''] });
    expect(prepareSparql('PREFIX :: <urn:default:> SELECT * WHERE {}').prologue)
      .toEqual({ endTokenIndex: 0, declaredPrefixes: [] });
  });

  it('preserves offsets while making strings, IRIs, and comments lexically inert', () => {
    const source = 'SELECT "FROM {" <urn:test> # DELETE }\nWHERE { ?s ?p ?o }';
    const scan = prepareSparql(source);

    expect(scan.masked).toHaveLength(source.length);
    expect(scan.masked).not.toContain('FROM');
    expect(scan.masked).not.toContain('urn:test');
    expect(scan.masked).not.toContain('DELETE');
    expect(scan.masked).toContain('SELECT');
    expect(scan.masked).toContain('WHERE');
    expect({ masked: scan.masked, unterminated: scan.unterminated }).toEqual({
      masked: scan.masked,
      unterminated: false,
    });
  });

  it('reports an unterminated string without losing the preceding tokens', () => {
    const scan = prepareSparql('SELECT ?s WHERE { BIND("unfinished AS ?s) }');

    expect(scan.unterminated).toBe(true);
    expect(scan.tokens[0]).toMatchObject({ kind: 'word', upper: 'SELECT' });
    const prepared = prepareSparql('SELECT ?s WHERE { BIND("unfinished AS ?s) }');
    expect({ masked: prepared.masked, unterminated: prepared.unterminated })
      .toEqual({ masked: scan.masked, unterminated: scan.unterminated });
  });
});
