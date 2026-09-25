import { describe, expect, it } from 'vitest';
import {
  canonicalizeRdfObjectTerm,
  escapeRdfLiteral,
  decodeRdfLiteralBody,
  decodeNTriplesIriEscapesPreservingLegacy,
  decodeNTriplesIriEscapesStrict,
  decodeNTriplesUcharEscapes,
  formatCanonicalRdfLiteralTerm,
  isRdfTerm,
  normalizeRdfObject,
  parseRdfLiteralLexicalTerm,
  parseRdfLiteralTerm,
  type RdfLiteralTerm,
} from '../src/index.js';

describe('escapeRdfLiteral', () => {
  it('escapes quotes, backslashes, ECHAR controls, remaining C0 controls, and DEL', () => {
    expect(escapeRdfLiteral('q"\\b\bt\tn\nf\fr\rnul\u0000vt\u000Bus\u001Fdel\u007F')).toBe(
      'q\\"\\\\b\\bt\\tn\\nf\\fr\\rnul\\u0000vt\\u000Bus\\u001Fdel\\u007F',
    );
  });

  it('owns the complete dependency-free RDF object normalization boundary', () => {
    expect(isRdfTerm('urn:test:entity')).toBe(true);
    expect(isRdfTerm('_:blank')).toBe(true);
    expect(isRdfTerm('plain')).toBe(false);
    expect(normalizeRdfObject('urn:test:entity')).toBe('urn:test:entity');
    expect(normalizeRdfObject('a "quote"\u0000')).toBe('"a \\"quote\\"\\u0000"');
    expect(normalizeRdfObject(null)).toBe('""');
  });
});

describe('N-Triples UCHAR decoding', () => {
  it('decodes BMP, scalar, and paired UTF-16 escape forms', () => {
    expect(decodeNTriplesUcharEscapes(String.raw`caf\u00E9/\U0001F600/\uD83D\uDE00`, {
      surrogatePolicy: 'combine',
    })).toBe('café/😀/😀');
  });

  it('rejects malformed, unpaired, and out-of-range escapes by default', () => {
    expect(decodeNTriplesUcharEscapes(String.raw`\q`)).toBeNull();
    expect(decodeNTriplesUcharEscapes(String.raw`\uD800`, {
      surrogatePolicy: 'combine',
    })).toBeNull();
    expect(decodeNTriplesUcharEscapes(String.raw`\uDC00`, {
      surrogatePolicy: 'combine',
    })).toBeNull();
    expect(decodeNTriplesUcharEscapes(String.raw`\U00110000`)).toBeNull();
  });

  it('supports the consensus compatibility policy explicitly', () => {
    expect(decodeNTriplesUcharEscapes(String.raw`\q/\uD800`, {
      invalidEscape: 'preserve',
      surrogatePolicy: 'allow',
    })).toBe(`\\q/\uD800`);
  });

  it('preserves malformed prefixes without hiding a later valid legacy escape', () => {
    expect(decodeNTriplesIriEscapesPreservingLegacy(String.raw`\u12\u0041`))
      .toBe(String.raw`\u12A`);
    expect(decodeNTriplesIriEscapesPreservingLegacy(String.raw`\\u0041`))
      .toBe(String.raw`\A`);
  });

  it('combines only two short surrogate escapes in strict IRI mode', () => {
    expect(decodeNTriplesIriEscapesStrict(String.raw`\uD83D\uDE00`)).toBe('😀');
    expect(decodeNTriplesIriEscapesStrict(String.raw`\U0000D83D\uDE00`)).toBeNull();
  });

  it('rejects recognized ECHAR in strict IRIs and preserves it for legacy datatype IRIs', () => {
    expect(decodeNTriplesIriEscapesStrict(String.raw`urn:x\n`)).toBeNull();
    expect(decodeNTriplesIriEscapesPreservingLegacy(String.raw`urn:x\n`))
      .toBe(String.raw`urn:x\n`);
  });
});

describe('RDF literal term codec', () => {
  const value = 'café 😀 "quote" \\ tab:\t control:\u0001 del:\u007F slash-n:\\n';
  const body = 'café 😀 \\"quote\\" \\\\ tab:\\t control:\\u0001 del:\\u007F slash-n:\\\\n';

  it('owns plain, language-tagged, and typed binding formatting', () => {
    expect(formatCanonicalRdfLiteralTerm({ kind: 'plain', value })).toBe(`"${body}"`);
    expect(formatCanonicalRdfLiteralTerm({ kind: 'language', value, language: 'en' })).toBe(`"${body}"@en`);
    expect(formatCanonicalRdfLiteralTerm({ kind: 'typed', value, datatype: 'urn:test:datatype' }))
      .toBe(`"${body}"^^<urn:test:datatype>`);
    expect(formatCanonicalRdfLiteralTerm({
      kind: 'typed',
      value,
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
    })).toBe(`"${body}"`);
  });

  it.each<RdfLiteralTerm>([
    { kind: 'plain', value },
    { kind: 'language', value, language: 'sr-Latn' },
    { kind: 'typed', value, datatype: 'urn:test:datatype' },
  ])('round-trips $kind literals through the canonical formatter and parser', (literal) => {
    const formatted = formatCanonicalRdfLiteralTerm(literal);
    expect(parseRdfLiteralTerm(formatted)).toEqual(literal);
    expect(formatCanonicalRdfLiteralTerm(parseRdfLiteralTerm(formatted)!)).toBe(formatted);
  });

  it('round-trips the complete escaped C0 and DEL control range', () => {
    const controls = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('')
      + '\u007F';
    const literal: RdfLiteralTerm = { kind: 'plain', value: controls };
    expect(parseRdfLiteralTerm(formatCanonicalRdfLiteralTerm(literal))).toEqual(literal);
  });

  it('keeps XSD string elision in the typed formatting path', () => {
    const typed: RdfLiteralTerm = {
      kind: 'typed',
      value,
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
    };
    const formatted = formatCanonicalRdfLiteralTerm(typed);
    expect(formatted).toBe(`"${body}"`);
    expect(parseRdfLiteralTerm(formatted)).toEqual({ kind: 'plain', value });
  });

  it('unescapes standard short and Unicode escapes in a single parity-safe pass', () => {
    expect(parseRdfLiteralTerm(
      '"quote:\\" slash:\\\\ controls:\\b\\t\\n\\f\\r BMP:\\u00E9 astral:\\U0001F600"',
    )).toEqual({ kind: 'plain', value: 'quote:" slash:\\ controls:\b\t\n\f\r BMP:é astral:😀' });
    expect(parseRdfLiteralTerm('"literal-backslash-n:\\\\n"'))
      .toEqual({ kind: 'plain', value: 'literal-backslash-n:\\n' });
  });

  it('preserves supported raw tabs in suffixed literal terms', () => {
    expect(parseRdfLiteralTerm('"a\tb"@en'))
      .toEqual({ kind: 'language', value: 'a\tb', language: 'en' });
    expect(parseRdfLiteralTerm('"a\tb"^^<urn:test:datatype>'))
      .toEqual({ kind: 'typed', value: 'a\tb', datatype: 'urn:test:datatype' });
  });

  it('rejects non-literal and malformed literal terms', () => {
    expect(parseRdfLiteralTerm('urn:test:not-a-literal')).toBeNull();
    expect(parseRdfLiteralTerm('"unterminated')).toBeNull();
    expect(parseRdfLiteralTerm('"x"@en^^<urn:test>')).toBeNull();
    expect(parseRdfLiteralTerm('"unknown:\\q"')).toBeNull();
    expect(parseRdfLiteralTerm('"bad-unicode:\\u00ZZ"')).toBeNull();
    expect(parseRdfLiteralTerm('"out-of-range:\\U00110000"')).toBeNull();
    expect(parseRdfLiteralTerm('"surrogate-short:\\uD800"')).toBeNull();
    expect(parseRdfLiteralTerm('"surrogate-long:\\U0000DFFF"')).toBeNull();
    expect(parseRdfLiteralTerm('"raw\nnewline"')).toBeNull();
  });

  it('shares the broad lexical boundary without weakening strict term parsing', () => {
    expect(parseRdfLiteralLexicalTerm('"v"^^urn:test:bare')).toEqual({
      body: 'v',
      suffix: { kind: 'datatype', datatype: 'urn:test:bare', syntax: 'bare' },
    });
    expect(parseRdfLiteralTerm('"v"^^urn:test:bare')).toBeNull();
    expect(parseRdfLiteralLexicalTerm('"unknown:\\q"')).toEqual({
      body: 'unknown:\\q',
      suffix: { kind: 'plain' },
    });
    expect(parseRdfLiteralTerm('"unknown:\\q"')).toBeNull();
  });

  it('makes strict and compatibility escape-decoding contracts explicit', () => {
    expect(decodeRdfLiteralBody('valid:\\t\\u00E9')).toBe('valid:\té');
    expect(decodeRdfLiteralBody('unknown:\\q')).toBeNull();
    expect(decodeRdfLiteralBody('unknown:\\q', { invalidEscape: 'preserve' }))
      .toBe('unknown:\\q');
    expect(decodeRdfLiteralBody('surrogate:\\uD800')).toBeNull();
    expect(decodeRdfLiteralBody('surrogate:\\uD800', {
      invalidEscape: 'preserve',
      allowSurrogateCodePoints: true,
    })).toBe('surrogate:\uD800');
  });

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
