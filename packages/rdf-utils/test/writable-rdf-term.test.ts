import { describe, expect, it } from 'vitest';
import { parseRdfLiteralTerm, parseWritableRdfTerm } from '../src/index.js';

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const kindOf = (term: string) => parseWritableRdfTerm(term)?.kind ?? null;

describe('parseWritableRdfTerm IRIs', () => {
  it.each([
    ['urn:x', 'urn:x'],
    ['<urn:x>', 'urn:x'],
    ['a:', 'a:'],
    ['<a:>', 'a:'],
    ['https://ex.org/a?b=1#c', 'https://ex.org/a?b=1#c'],
    ['<did:dkg:context-graph:0xabc/cg>', 'did:dkg:context-graph:0xabc/cg'],
    ['https://ex.org/café', 'https://ex.org/café'],
    ['http://[2001:db8::1]/a', 'http://[2001:db8::1]/a'],
    ['urn:test:%E2%82%AC', 'urn:test:%E2%82%AC'],
  ])('accepts %s', (term, value) => {
    expect(parseWritableRdfTerm(term)).toEqual({ kind: 'iri', value });
  });

  it.each([
    '',
    '<>',
    '<',
    'foo',
    '<foo>',
    '1bad:scheme',
    '<urn:x',
    'urn:x>',
    '<<urn:x>>',
    'urn:a b',
    '<urn:a b>',
    ' urn:x',
    'urn:x ',
    'https://schema.org/na^me',
    'urn:{p}',
    'urn:x|y',
    'https://example.org/%zz',
    'https://example.org/%0',
    'http://user@@example.org/',
    'http://example.org:bad/',
    'https://example.org/a[0]',
    'urn:test:#fragment#again',
    '<_:b0>',
  ])('rejects %j', (term) => {
    expect(kindOf(term)).toBeNull();
  });

  it('reads a quoted IRI as a literal', () => {
    expect(parseWritableRdfTerm('"urn:x"')).toEqual({ kind: 'literal', value: { kind: 'plain', value: 'urn:x' } });
  });
});

describe('parseWritableRdfTerm blank nodes', () => {
  it.each(['b0', '0', '7f3a9c0e5d', 'c14n0', 'n3-0', 'a.b', 'genid_1', 'é', 'x·y'])(
    'accepts _:%s',
    (label) => {
      expect(parseWritableRdfTerm(`_:${label}`)).toEqual({ kind: 'blank-node', value: label });
    },
  );

  it.each(['_:', '_:b.', '_:a b', '_:-b', '_:b\n', '_:b>', ' _:b0', '_:b0 '])('rejects %j', (term) => {
    expect(kindOf(term)).toBeNull();
  });
});

describe('parseWritableRdfTerm literals', () => {
  it.each([
    ['""', { kind: 'plain', value: '' }],
    ['"plain"', { kind: 'plain', value: 'plain' }],
    [
      '"with \\"escaped\\" quotes \\\\ and \\n escapes"',
      { kind: 'plain', value: 'with "escaped" quotes \\ and \n escapes' },
    ],
    ['"\\u00E9 and \\U0001F600"', { kind: 'plain', value: 'é and 😀' }],
    ['"raw\ttab"', { kind: 'plain', value: 'raw\ttab' }],
    // N-Quads and SPARQL only require line breaks, quotes and backslashes to be escaped.
    [
      '"form\ffeed, \u001B[31mred\u001B[0m, nul\u0000, del\u007F"',
      { kind: 'plain', value: 'form\ffeed, \u001B[31mred\u001B[0m, nul\u0000, del\u007F' },
    ],
    ['"hallo"@de-CH-1996', { kind: 'language', value: 'hallo', language: 'de-CH-1996' }],
    [`"42"^^<${XSD_INTEGER}>`, { kind: 'typed', value: '42', datatype: XSD_INTEGER }],
    [`"42"^^${XSD_INTEGER}`, { kind: 'typed', value: '42', datatype: XSD_INTEGER }],
    ['"x"^^<a:>', { kind: 'typed', value: 'x', datatype: 'a:' }],
  ])('accepts %j', (term, literal) => {
    expect(parseWritableRdfTerm(term)).toEqual({ kind: 'literal', value: literal });
  });

  it.each([
    '"',
    '"unterminated',
    '"a"b"',
    ' "v"',
    '"v" ',
    '"raw\nnewline"',
    '"raw\rreturn"',
    '"x" .\n<urn:dkg:file:deadbeef> <http://dkg.io/ontology/trustLevel> "y"',
    '"bad \\x escape"',
    '"\\u00E"',
    '"\\uD800"',
    '"\\uD83D\\uDE00"',
    '"\\U00110000"',
    '"x"@',
    '"x"@en-',
    '"x"^^<>',
    '"x"^^<urn:dt',
    '"x"^^<urn:dt with space>',
    '"x"^^urn:dt with space',
    '"x"^^urn:a\nurn:b',
    '"42"^^<integer>',
    '"42"^^integer',
    '"42"^^<#integer>',
    '"42"^^<https://example.org/%zz>',
  ])('rejects %j', (term) => {
    expect(kindOf(term)).toBeNull();
  });

  it('leaves parseRdfLiteralTerm on the canonical grammar', () => {
    expect(parseRdfLiteralTerm(`"42"^^${XSD_INTEGER}`)).toBeNull();
    expect(parseRdfLiteralTerm('"form\ffeed"')).toBeNull();
    // Datatype policy belongs to the callers of the canonical parser.
    expect(parseRdfLiteralTerm('"42"^^<integer>')).toEqual({ kind: 'typed', value: '42', datatype: 'integer' });
  });
});
