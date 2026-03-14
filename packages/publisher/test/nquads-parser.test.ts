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

  it('does not hang on malformed datatype IRI (unclosed angle bracket)', () => {
    const text = '<urn:s> <urn:p> "val"^^<http://broken <urn:g> .';
    const start = Date.now();
    const quads = parseSimpleNQuads(text);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(quads.length).toBeLessThanOrEqual(1);
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
