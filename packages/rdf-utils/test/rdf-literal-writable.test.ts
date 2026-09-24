import { describe, expect, it } from 'vitest';
import { parseRdfLiteralTerm } from '../src/index.js';

describe('parseRdfLiteralTerm writable mode', () => {
  it('accepts the legacy bare-datatype suffix only in writable mode', () => {
    const term = '"42"^^http://www.w3.org/2001/XMLSchema#integer';
    expect(parseRdfLiteralTerm(term)).toBeNull();
    expect(parseRdfLiteralTerm(term, { writable: true })).toEqual({
      kind: 'typed',
      value: '42',
      datatype: 'http://www.w3.org/2001/XMLSchema#integer',
    });
  });

  it('accepts raw control characters other than line breaks only in writable mode', () => {
    const term = '"form\ffeed, \u001B[31mred\u001B[0m, nul\u0000, del\u007F"';
    expect(parseRdfLiteralTerm(term)).toBeNull();
    expect(parseRdfLiteralTerm(term, { writable: true })).toEqual({
      kind: 'plain',
      value: 'form\ffeed, \u001B[31mred\u001B[0m, nul\u0000, del\u007F',
    });
  });

  it('parses the canonical forms the same way in both modes', () => {
    for (const term of [
      '"raw\ttab"',
      '"q\\"\\\\\\n\\u00E9\\U0001F600"',
      '"hallo"@de-CH-1996',
      '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
      '"42"^^<integer>',
    ]) {
      expect(parseRdfLiteralTerm(term, { writable: true })).toEqual(parseRdfLiteralTerm(term));
      expect(parseRdfLiteralTerm(term)).not.toBeNull();
    }
  });

  it.each([
    ['a raw line feed', '"raw\nnewline"'],
    ['a raw carriage return', '"raw\rreturn"'],
    ['a bare datatype after a raw line break', '"x"^^urn:a\nurn:b'],
    ['an unknown escape', '"bad \\x escape"'],
    ['a short unicode escape', '"\\u00E"'],
    ['a lone surrogate escape', '"\\uD800"'],
    ['a surrogate pair escape', '"\\uD83D\\uDE00"'],
    ['an out-of-range escape', '"\\U00110000"'],
    ['a stray quote', '"a"b"'],
    ['an unterminated literal', '"unterminated'],
    ['an empty language tag', '"x"@'],
    ['a malformed language tag', '"x"@en-'],
    ['an empty bracketed datatype', '"x"^^<>'],
    ['an unclosed bracketed datatype', '"x"^^<urn:dt'],
  ])('rejects %s in writable mode', (_label, term) => {
    expect(parseRdfLiteralTerm(term, { writable: true })).toBeNull();
  });
});
