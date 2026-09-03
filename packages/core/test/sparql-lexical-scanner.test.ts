import { describe, expect, it } from 'vitest';
import {
  maskSparqlLexicalRegions,
  scanSparqlLexically,
} from '../src/sparql-lexical-scanner.js';
import {
  decodeSparqlCodePointEscapes,
  skipSparqlIriRef,
  skipSparqlIriRefForStructuralScan,
} from '../src/sparql-lexical-primitives.js';

describe('canonical SPARQL lexical scanner', () => {
  it.each([
    'foaf.core',
    'café',
    'δοκιμή',
  ])('recognizes PN_PREFIX label %s and reaches the operation token', (prefix) => {
    const scan = scanSparqlLexically(
      `PREFIX ${prefix}: <http://example.com/> SELECT ?s WHERE { ?s ${prefix}:name ?n }`,
    );

    expect(scan.prologue.declaredPrefixes).toEqual([prefix]);
    expect(scan.tokens[scan.prologue.endTokenIndex]).toMatchObject({
      kind: 'word',
      upper: 'SELECT',
    });
  });

  it('recognizes an adjacent IRIREF in a compact BASE prologue', () => {
    const scan = scanSparqlLexically('BASE<https://example.com/>SELECT * WHERE {}');

    expect(scan.prologue.endTokenIndex).toBe(2);
    expect(scan.tokens[1]).toMatchObject({ kind: 'iri' });
    expect(scan.tokens[2]).toMatchObject({ kind: 'word', upper: 'SELECT' });
  });

  it('keeps grammar IRIREF recognition distinct from the rewrite heuristic', () => {
    const source = String.raw`\u003C10\u003E`;

    expect(skipSparqlIriRef(source, 0)).toBe(source.length);
    expect(skipSparqlIriRefForStructuralScan(source, 0)).toBeNull();
  });

  it('preprocesses UCHAR escapes while preserving raw token offsets', () => {
    const source = String.raw`PREFIX \u0065x\u003A <http://example.com/> \u0053ELECT \u003Fs WHERE { \u003Fs \u0065x\u003Aname ?n }`;
    const scan = scanSparqlLexically(source);

    expect(scan.prologue).toEqual({ endTokenIndex: 3, declaredPrefixes: ['ex'] });
    const operation = scan.tokens[scan.prologue.endTokenIndex];
    expect(operation).toMatchObject({
      kind: 'word',
      value: String.raw`\u0053ELECT`,
      logicalValue: 'SELECT',
      upper: 'SELECT',
    });
    for (const token of scan.tokens) {
      if ('value' in token) {
        expect(source.slice(token.start, token.end)).toBe(token.value);
      }
    }
    expect(scan.tokens).toContainEqual(expect.objectContaining({
      kind: 'variable',
      value: String.raw`\u003Fs`,
      logicalValue: '?s',
    }));
  });

  it('does not reinterpret escaped string backslashes as overlapping UCHARs', () => {
    const malformedLookalike = String.raw`SELECT ?x WHERE { BIND("\\u00ZZ" AS ?x) }`;
    const validLookalike = String.raw`SELECT ?x WHERE { BIND("\\u006E" AS ?x) }`;

    expect(decodeSparqlCodePointEscapes(malformedLookalike)).toBe(malformedLookalike);
    expect(decodeSparqlCodePointEscapes(validLookalike)).toBe(validLookalike);
  });

  it('leaves UCHAR-like comment text inert while decoding active tokens', () => {
    const source = String.raw`\u0053ELECT * WHERE {} # \u00ZZ \u0053ERVICE`;

    expect(decodeSparqlCodePointEscapes(source))
      .toBe(String.raw`SELECT * WHERE {} # \u00ZZ \u0053ERVICE`);
  });

  it.each([
    String.raw`PREFIX \u00G0x: <http://example.com/> SELECT * WHERE {}`,
    String.raw`PREFIX \uD800x: <http://example.com/> SELECT * WHERE {}`,
    String.raw`PREFIX \U00110000x: <http://example.com/> SELECT * WHERE {}`,
  ])('fails closed for malformed or non-scalar UCHAR names: %s', (source) => {
    expect(scanSparqlLexically(source).prologue)
      .toEqual({ endTokenIndex: 0, declaredPrefixes: [] });
  });

  it('accepts a valid eight-hex-digit UCHAR in a prefix label', () => {
    const scan = scanSparqlLexically(
      String.raw`PREFIX \U000003B1: <http://example.com/> SELECT * WHERE {}`,
    );
    expect(scan.prologue).toEqual({ endTokenIndex: 3, declaredPrefixes: ['α'] });
  });

  it('uses PN_LOCAL and VARNAME boundaries around operators', () => {
    const scan = scanSparqlLexically(
      String.raw`?1count ?x-STRCONTAINS() ex:value=STRCONTAINS() ex:local.name. ex:escaped\=value`,
    );
    const tokens = scan.tokens.map((token) => (
      'value' in token ? `${token.kind}:${token.value}` : token.kind
    ));

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

  it('recognizes a default prefix declaration without accepting a local part', () => {
    expect(scanSparqlLexically('PREFIX : <urn:default:> SELECT * WHERE {}').prologue)
      .toEqual({ endTokenIndex: 3, declaredPrefixes: [''] });
    expect(scanSparqlLexically('PREFIX :: <urn:default:> SELECT * WHERE {}').prologue)
      .toEqual({ endTokenIndex: 0, declaredPrefixes: [] });
  });

  it('preserves offsets while making strings, IRIs, and comments lexically inert', () => {
    const source = 'SELECT "FROM {" <urn:test> # DELETE }\nWHERE { ?s ?p ?o }';
    const scan = scanSparqlLexically(source);

    expect(scan.masked).toHaveLength(source.length);
    expect(scan.masked).not.toContain('FROM');
    expect(scan.masked).not.toContain('urn:test');
    expect(scan.masked).not.toContain('DELETE');
    expect(scan.masked).toContain('SELECT');
    expect(scan.masked).toContain('WHERE');
    expect(maskSparqlLexicalRegions(source)).toEqual({
      masked: scan.masked,
      unterminated: false,
    });
  });

  it('reports an unterminated string without losing the preceding tokens', () => {
    const scan = scanSparqlLexically('SELECT ?s WHERE { BIND("unfinished AS ?s) }');

    expect(scan.unterminated).toBe(true);
    expect(scan.tokens[0]).toMatchObject({ kind: 'word', upper: 'SELECT' });
    expect(maskSparqlLexicalRegions('SELECT ?s WHERE { BIND("unfinished AS ?s) }'))
      .toEqual({ masked: scan.masked, unterminated: scan.unterminated });
  });
});
