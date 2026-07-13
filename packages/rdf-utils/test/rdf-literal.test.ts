import { describe, expect, it } from 'vitest';
import {
  escapeRdfLiteral,
  formatRdfLiteralTerm,
  isRdfTerm,
  normalizeRdfObject,
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

describe('formatRdfLiteralTerm', () => {
  const value = 'café "quote" \\ tab:\t control:\u0001 del:\u007F';
  const body = 'café \\"quote\\" \\\\ tab:\\t control:\\u0001 del:\\u007F';

  it('owns plain, language-tagged, and typed binding formatting', () => {
    expect(formatRdfLiteralTerm({ value })).toBe(`"${body}"`);
    expect(formatRdfLiteralTerm({ value, language: 'en' })).toBe(`"${body}"@en`);
    expect(formatRdfLiteralTerm({ value, datatype: 'urn:test:datatype' }))
      .toBe(`"${body}"^^<urn:test:datatype>`);
    expect(formatRdfLiteralTerm({
      value,
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
    })).toBe(`"${body}"`);
  });
});
