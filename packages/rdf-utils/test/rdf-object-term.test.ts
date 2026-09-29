import { describe, expect, it } from 'vitest';
import {
  canonicalizeRdfObjectTerm,
  decodeRdfLiteralBody,
  parseRdfLiteralTerm,
} from '../src/index.js';

describe('UTF-16 surrogate pairs in literals', () => {
  it('combines a UTF-16 surrogate pair of short escapes only when asked', () => {
    const pair = '"\\uD83D\\uDDD3 12 October"';
    expect(parseRdfLiteralTerm(pair)).toBeNull();
    expect(parseRdfLiteralTerm(pair, { combineSurrogatePairs: true }))
      .toEqual({ kind: 'plain', value: '\u{1F5D3} 12 October' });
    expect(parseRdfLiteralTerm('"\\ud83d\\udccd"@en', { combineSurrogatePairs: true }))
      .toEqual({ kind: 'language', value: '\u{1F4CD}', language: 'en' });
    expect(decodeRdfLiteralBody('\\uD83D\\uDDD3\\n', { combineSurrogatePairs: true }))
      .toBe('\u{1F5D3}\n');
    for (const unpaired of [
      '\\uD83D x',
      '\\uDDD3',
      '\\uDDD3\\uD83D',
      '\\U0001F5D3\\uDDD3',
    ]) {
      expect(decodeRdfLiteralBody(unpaired, { combineSurrogatePairs: true })).toBeNull();
    }
  });
});

describe('canonicalizeRdfObjectTerm', () => {
  it.each([
    { name: 'a \\u escape', wire: '"Women\\u2019s"', stored: '"Women\u2019s"' },
    { name: 'a \\U escape', wire: '"rocket \\U0001F680"', stored: '"rocket \u{1F680}"' },
    { name: 'a UTF-16 escape pair', wire: '"\\uD83D\\uDDD3 12 October"', stored: '"\u{1F5D3} 12 October"' },
    { name: 'a lowercase UTF-16 escape pair', wire: '"\\ud83d\\udccd Zagreb"', stored: '"\u{1F4CD} Zagreb"' },
    { name: 'a raw tab', wire: '"a\tb"', stored: '"a\\tb"' },
    { name: 'an explicit xsd:string', wire: '"x"^^<http://www.w3.org/2001/XMLSchema#string>', stored: '"x"' },
    { name: 'a language-tagged literal', wire: '"caf\\u00E9"@fr', stored: '"caf\u00E9"@fr' },
    { name: 'a typed literal', wire: '"caf\\u00E9"^^<urn:datatype:text>', stored: '"caf\u00E9"^^<urn:datatype:text>' },
    { name: 'an escaped datatype IRI', wire: '"x"^^<urn:datatype:caf\\u00E9>', stored: '"x"^^<urn:datatype:caf\u00E9>' },
  ])('rewrites $name to the form the store returns', ({ wire, stored }) => {
    expect(canonicalizeRdfObjectTerm(wire)).toBe(stored);
    expect(canonicalizeRdfObjectTerm(stored)).toBe(stored);
  });

  it.each([
    'urn:test:iri',
    'urn:test:caf\\u00E9',
    '_:b0',
    '"lone \\uD83D surrogate"',
    '"reversed \\uDDD3\\uD83D pair"',
    '"unknown \\q escape"',
    '"v"^^urn:test:bare',
    '"x"^^<urn:datatype:\\u0020space>',
  ])('leaves %s unchanged', (term) => {
    expect(canonicalizeRdfObjectTerm(term)).toBe(term);
  });
});
