import { describe, expect, it } from 'vitest';
import {
  escapeRdfLiteral,
  formatRdfLiteralBinding,
  formatRdfLiteralTerm,
  formatSparqlJsonBindings,
  formatSparqlJsonTerm,
  isRdfTerm,
  normalizeRdfObject,
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

describe('RDF literal term codec', () => {
  const value = 'café 😀 "quote" \\ tab:\t control:\u0001 del:\u007F slash-n:\\n';
  const body = 'café 😀 \\"quote\\" \\\\ tab:\\t control:\\u0001 del:\\u007F slash-n:\\\\n';

  it('owns plain, language-tagged, and typed binding formatting', () => {
    expect(formatRdfLiteralTerm({ kind: 'plain', value })).toBe(`"${body}"`);
    expect(formatRdfLiteralTerm({ kind: 'language', value, language: 'en' })).toBe(`"${body}"@en`);
    expect(formatRdfLiteralTerm({ kind: 'typed', value, datatype: 'urn:test:datatype' }))
      .toBe(`"${body}"^^<urn:test:datatype>`);
    expect(formatRdfLiteralTerm({
      kind: 'typed',
      value,
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
    })).toBe(`"${body}"`);
  });

  it('selects the canonical literal kind from SPARQL binding metadata', () => {
    expect(formatRdfLiteralBinding({ value })).toBe(`"${body}"`);
    expect(formatRdfLiteralBinding({ value, language: 'en' })).toBe(`"${body}"@en`);
    expect(formatRdfLiteralBinding({ value, datatype: 'urn:test:datatype' }))
      .toBe(`"${body}"^^<urn:test:datatype>`);
    expect(formatRdfLiteralBinding({
      value,
      language: 'en',
      datatype: 'urn:test:ignored-when-language-is-present',
    })).toBe(`"${body}"@en`);
  });

  it('owns complete SPARQL JSON term conversion', () => {
    expect(formatSparqlJsonTerm({ type: 'uri', value: 'urn:test:entity' }))
      .toBe('urn:test:entity');
    expect(formatSparqlJsonTerm({ type: 'bnode', value: 'blank' })).toBe('_:blank');
    expect(formatSparqlJsonTerm({ type: 'literal', value })).toBe(`"${body}"`);
    expect(formatSparqlJsonTerm({ type: 'literal', value, 'xml:lang': 'en' }))
      .toBe(`"${body}"@en`);
    expect(formatSparqlJsonTerm({
      type: 'typed-literal',
      value,
      datatype: 'urn:test:datatype',
    })).toBe(`"${body}"^^<urn:test:datatype>`);
    expect(formatSparqlJsonTerm({
      type: 'typed-literal',
      value,
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
    })).toBe(`"${body}"`);
  });

  it('owns complete SPARQL JSON SELECT binding conversion', () => {
    expect(formatSparqlJsonBindings({
      head: { vars: ['uri', 'missing', 'language', 'typed'] },
      results: {
        bindings: [{
          uri: { type: 'uri', value: 'urn:test:entity' },
          language: { type: 'literal', value, 'xml:lang': 'en' },
          typed: { type: 'typed-literal', value, datatype: 'urn:test:datatype' },
        }],
      },
    })).toEqual([{
      uri: 'urn:test:entity',
      language: `"${body}"@en`,
      typed: `"${body}"^^<urn:test:datatype>`,
    }]);
    expect(formatSparqlJsonBindings({})).toEqual([]);
  });

  it.each<RdfLiteralTerm>([
    { kind: 'plain', value },
    { kind: 'language', value, language: 'sr-Latn' },
    { kind: 'typed', value, datatype: 'urn:test:datatype' },
  ])('round-trips $kind literals through the canonical formatter and parser', (literal) => {
    const formatted = formatRdfLiteralTerm(literal);
    expect(parseRdfLiteralTerm(formatted)).toEqual(literal);
    expect(formatRdfLiteralTerm(parseRdfLiteralTerm(formatted)!)).toBe(formatted);
  });

  it('round-trips the complete escaped C0 and DEL control range', () => {
    const controls = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('')
      + '\u007F';
    const literal: RdfLiteralTerm = { kind: 'plain', value: controls };
    expect(parseRdfLiteralTerm(formatRdfLiteralTerm(literal))).toEqual(literal);
  });

  it('keeps XSD string elision in the typed formatting path', () => {
    const typed: RdfLiteralTerm = {
      kind: 'typed',
      value,
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
    };
    const formatted = formatRdfLiteralTerm(typed);
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
    expect(parseRdfLiteralTerm('"raw\nnewline"')).toBeNull();
  });
});
