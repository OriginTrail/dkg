import { describe, it, expect } from 'vitest';
import { parseSimpleNQuads } from '../src/publish-handler.js';

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

  it('handles empty input', () => {
    expect(parseSimpleNQuads('')).toEqual([]);
    expect(parseSimpleNQuads('\n\n')).toEqual([]);
  });
});
