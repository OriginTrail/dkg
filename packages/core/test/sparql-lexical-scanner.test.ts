import { describe, expect, it } from 'vitest';
import {
  maskSparqlLexicalRegions,
  scanSparqlLexically,
} from '../src/sparql-lexical-scanner.js';

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
  });
});
