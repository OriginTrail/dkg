import { describe, expect, it } from 'vitest';
import { parseSparqlTsvLiteralTerm, type RdfLiteralTerm } from '../src/index.js';

describe('SPARQL TSV literal scanner', () => {
  it.each<[string, RdfLiteralTerm]>([
    ['""', { kind: 'plain', value: '' }],
    ["''", { kind: 'plain', value: '' }],
    ['"plain"', { kind: 'plain', value: 'plain' }],
    ["'single'", { kind: 'plain', value: 'single' }],
    ['"a\'b"', { kind: 'plain', value: "a'b" }],
    ["'a\"b'", { kind: 'plain', value: 'a"b' }],
    ['"a\u0001b\u007f"', { kind: 'plain', value: 'a\u0001b\u007f' }],
    [String.raw`"\t\b\n\r\f\"\'\\"`, { kind: 'plain', value: '\t\b\n\r\f"\'\\' }],
    [String.raw`'\t\b\n\r\f\"\'\\'`, { kind: 'plain', value: '\t\b\n\r\f"\'\\' }],
    [String.raw`"caf\u00E9 \U0001F30D"`, { kind: 'plain', value: 'café 🌍' }],
    [String.raw`"a\tb\nc"@es-419`, { kind: 'language', value: 'a\tb\nc', language: 'es-419' }],
    ["'colour'@en-GB", { kind: 'language', value: 'colour', language: 'en-GB' }],
    [String.raw`"a\tb"^^<urn:type>`, { kind: 'typed', value: 'a\tb', datatype: 'urn:type' }],
    [String.raw`'value'^^<urn:\u0074ype>`, { kind: 'typed', value: 'value', datatype: String.raw`urn:\u0074ype` }],
  ])('decodes %j without changing the datatype spelling', (input, expected) => {
    expect(parseSparqlTsvLiteralTerm(input)).toEqual(expected);
  });

  it.each([
    '', 'unquoted', '"unterminated', "'unterminated", '"mismatched\'',
    '"raw\ttab"', '"raw\nline"', "'raw\rline'",
    String.raw`"bad\xescape"`, String.raw`"bad\u00X0"`, String.raw`"bad\U00110000"`,
    '"trailing\\', String.raw`"escaped end\"`,
    '"value"junk', '"value"@', '"value"@419', '"value"@-en', '"value"@en-',
    '"value"@en--GB', '"value"@en_GB', '"value"@é',
    '"value"^^urn:type', '"value"^^<>', '"value"^^<urn:type',
    '"value"^^<urn:type>>', '"value"^^<urn:type>junk',
  ])('rejects malformed input %j', (input) => {
    expect(parseSparqlTsvLiteralTerm(input)).toBeNull();
  });

  it('only combines escaped UTF-16 pairs when requested, without accepting lone surrogates', () => {
    const pair = String.raw`"\uD83C\uDF0D"`;
    expect(parseSparqlTsvLiteralTerm(pair)).toBeNull();
    expect(parseSparqlTsvLiteralTerm(pair, { combineSurrogatePairs: false })).toBeNull();
    expect(parseSparqlTsvLiteralTerm(pair, { combineSurrogatePairs: true }))
      .toEqual({ kind: 'plain', value: '🌍' });
    for (const input of [String.raw`"\uD83C"`, String.raw`"\uDF0D"`, String.raw`"\uD83C\u0041"`]) {
      expect(parseSparqlTsvLiteralTerm(input, { combineSurrogatePairs: true })).toBeNull();
    }
  });
});
