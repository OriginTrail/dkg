import { describe, expect, it } from 'vitest';
import {
  canonicalizeSparqlTsvResultTerm,
  parseRdfLiteralTerm,
  parseSparqlTsvHeaderVariable,
  parseSparqlTsvResultTerm,
  parseWritableRdfTerm,
  SparqlTsvResultTermCanonicalizer,
} from '../src/index.js';

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

  it.each([
    '_:', '_:b.', '_:a b', '_:-b', '_:b\n', '_:b>', ' _:b0', '_:b0 ',
    String.raw`_:\u0061`, '_:\ud800',
  ])('rejects %j', (term) => {
    expect(kindOf(term)).toBeNull();
  });

  it.each([
    [0x00d6, true],
    [0x00d7, false],
    [0x00d8, true],
    [0x037d, true],
    [0x037e, false],
    [0x037f, true],
    [0xd7ff, true],
    [0xf900, true],
    [0xfdcf, true],
    [0xfdd0, false],
    [0xfdf0, true],
    [0xfffd, true],
    [0xfffe, false],
    [0x10000, true],
    [0xeffff, true],
    [0xf0000, false],
  ])('keeps raw name consumers in parity at U+%s', (codePoint, accepted) => {
    const character = String.fromCodePoint(codePoint);
    expect(parseSparqlTsvHeaderVariable(`?${character}`) !== null).toBe(accepted);
    expect(parseWritableRdfTerm(`_:${character}`) !== null).toBe(accepted);
  });

  it('does not preprocess escapes in raw result names', () => {
    expect(parseSparqlTsvHeaderVariable(String.raw`?\u0061`)).toBeNull();
    expect(parseSparqlTsvHeaderVariable('?\ud800')).toBeNull();
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

describe('parseSparqlTsvResultTerm', () => {
  it.each([
    ["'plain'", { kind: 'literal', value: { kind: 'plain', value: 'plain' } }],
    ["'bonjour'@fr", { kind: 'literal', value: { kind: 'language', value: 'bonjour', language: 'fr' } }],
    ["'7'^^<urn:test:type>", { kind: 'literal', value: { kind: 'typed', value: '7', datatype: 'urn:test:type' } }],
    ['<urn:test:\\u0061>', { kind: 'iri', value: 'urn:test:a' }],
    ['42', { kind: 'literal', value: { kind: 'typed', value: '42', datatype: XSD_INTEGER } }],
  ])('accepts TSV result term %j', (term, expected) => {
    expect(parseSparqlTsvResultTerm(term)).toEqual(expected);
  });

  it.each([
    ['"plain"', "'plain'"],
    ['"bonjour"@fr', "'bonjour'@fr"],
    ['"7"^^<urn:test:type>', "'7'^^<urn:test:type>"],
    ['<urn:test:a>', '<urn:test:\\u0061>'],
  ])('normalizes optimized and fallback spellings identically', (fast, fallback) => {
    expect(parseSparqlTsvResultTerm(fast)).toEqual(parseSparqlTsvResultTerm(fallback));
    expect(canonicalizeSparqlTsvResultTerm(fast))
      .toEqual(canonicalizeSparqlTsvResultTerm(fallback));
  });

  it.each([
    'urn:test:bare',
    '"x"^^urn:test:bare',
    "'unterminated",
    "'bad \\q'",
    '<relative>',
    '"x"^^<relative>',
  ])('rejects non-TSV/result-only spelling %j', (term) => {
    expect(parseSparqlTsvResultTerm(term)).toBeNull();
    expect(canonicalizeSparqlTsvResultTerm(term)).toBeNull();
  });
});

describe('parseSparqlTsvHeaderVariable', () => {
  it.each([
    ['?v', 'v'],
    ['?9value', '9value'],
    ['?café', 'café'],
    ['?变量', '变量'],
    ['?𐀀value', '𐀀value'],
  ])('accepts complete SPARQL VARNAME %j', (cell, expected) => {
    expect(parseSparqlTsvHeaderVariable(cell)).toBe(expected);
  });

  it.each(['', '?', '$v', '?bad-name', '?bad.name', '?bad value', '?bad\tvalue'])
    ('rejects malformed TSV header cell %j', (cell) => {
      expect(parseSparqlTsvHeaderVariable(cell)).toBeNull();
    });
});

describe('SparqlTsvResultTermCanonicalizer', () => {
  it('keeps a bounded per-column IRI validation cache without changing results', () => {
    const canonicalizer = new SparqlTsvResultTermCanonicalizer(2, true);
    expect(canonicalizer.canonicalize('<urn:test:a>', 0))
      .toEqual({ kind: 'iri', value: 'urn:test:a' });
    expect(canonicalizer.canonicalize('<urn:test:a>', 0))
      .toEqual({ kind: 'iri', value: 'urn:test:a' });
    expect(canonicalizer.canonicalize('"plain"', 1))
      .toEqual({ kind: 'non-iri', value: '"plain"' });
    expect(canonicalizer.canonicalize('<urn:test:%zz>', 0)).toBeNull();
  });

  it('uses the canonical validator directly when row caching is disabled', () => {
    const canonicalizer = new SparqlTsvResultTermCanonicalizer(1, false);
    expect(canonicalizer.canonicalize('<urn:test:b>', 0))
      .toEqual({ kind: 'iri', value: 'urn:test:b' });
  });

  it('keeps validating while comparisons are paused and after they resume', () => {
    const canonicalizer = new SparqlTsvResultTermCanonicalizer(1, true);
    for (let index = 0; index < 16; index += 1) {
      expect(canonicalizer.canonicalize(`<urn:test:miss-${index}>`, 0))
        .toEqual({ kind: 'iri', value: `urn:test:miss-${index}` });
    }
    expect(canonicalizer.canonicalize('<urn:test:%zz>', 0)).toBeNull();
    for (let index = 0; index < 127; index += 1) {
      expect(canonicalizer.canonicalize(`<urn:test:paused-${index}>`, 0)?.kind)
        .toBe('iri');
    }
    expect(canonicalizer.canonicalize('<urn:test:after-pause>', 0))
      .toEqual({ kind: 'iri', value: 'urn:test:after-pause' });
    expect(canonicalizer.canonicalize('<urn:test:after-pause>', 0))
      .toEqual({ kind: 'iri', value: 'urn:test:after-pause' });
    expect(canonicalizer.canonicalize('<urn:test:%zz>', 0)).toBeNull();
  });

  it('validates uncached columns and overlength values directly', () => {
    const canonicalizer = new SparqlTsvResultTermCanonicalizer(129, true);
    expect(canonicalizer.canonicalize('<urn:test:%zz>', 128)).toBeNull();

    const longIri = `urn:test:${'a'.repeat(1_024)}`;
    expect(canonicalizer.canonicalize(`<${longIri}>`, 0))
      .toEqual({ kind: 'iri', value: longIri });
    expect(canonicalizer.canonicalize(`<${longIri}>`, 0))
      .toEqual({ kind: 'iri', value: longIri });
    expect(canonicalizer.canonicalize(`<${longIri}%zz>`, 0)).toBeNull();
  });
});
