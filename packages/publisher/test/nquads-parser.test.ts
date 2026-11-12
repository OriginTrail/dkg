import { describe, it, expect } from 'vitest';
import { SparqlTermValidationError } from '@origintrail-official/dkg-core';
import { parseSimpleNQuads } from '../src/publish-handler.js';
import { assertWritableQuadTerms, findMalformedQuadTerm } from '../src/validation.js';

describe('parseSimpleNQuads', () => {
  it('parses a standard N-Quad with datatype', () => {
    const text = '<urn:s> <urn:p> "42"^^<http://www.w3.org/2001/XMLSchema#integer> <urn:g> .';
    const quads = parseSimpleNQuads(text);
    expect(quads).toHaveLength(1);
    expect(quads[0].subject).toBe('urn:s');
    expect(quads[0].object).toBe('"42"^^<http://www.w3.org/2001/XMLSchema#integer>');
  });

  it('does not hang on malformed datatype IRI (no closing angle bracket)', () => {
    const quads = parseSimpleNQuads('"val"^^<http://broken-no-close');
    expect(quads).toEqual([]);
  });

  it('does not hang on datatype IRI where only a later term has a closing bracket', () => {
    const quads = parseSimpleNQuads('"val"^^<http://broken "rest" .');
    expect(quads).toEqual([]);
  });

  it('parses language-tagged literals', () => {
    const text = '<urn:s> <urn:p> "hello"@en <urn:g> .';
    const quads = parseSimpleNQuads(text);
    expect(quads).toHaveLength(1);
    expect(quads[0].object).toContain('"hello"@en');
  });

  it('parses plain literals', () => {
    const text = '<urn:s> <urn:p> "just text" <urn:g> .';
    const quads = parseSimpleNQuads(text);
    expect(quads).toHaveLength(1);
    expect(quads[0].object).toBe('"just text"');
  });

  it.each([
    ['a language tag with a character a tag may not hold', '<urn:s> <urn:p> "x"@en_GB <urn:g> .', 'object'],
    ['a blank-node label with a character a label may not hold', '_:node!refused <urn:p> "x" <urn:g> .', 'subject'],
  ])('keeps %s as received, and the received-quad term check refuses it', (_label, line, position) => {
    const quads = parseSimpleNQuads(line);
    expect(quads).toHaveLength(1);
    expect(findMalformedQuadTerm(quads)?.message).toMatch(new RegExp(`^Invalid RDF ${position} in quad 0:`));
    expect(() => assertWritableQuadTerms(quads)).toThrow(SparqlTermValidationError);
  });

  it('handles empty input', () => {
    expect(parseSimpleNQuads('')).toEqual([]);
    expect(parseSimpleNQuads('\n\n')).toEqual([]);
  });
});
