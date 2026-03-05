import { describe, it, expect } from 'vitest';
import { detectFormat, supportedExtensions, parseRdf } from '../src/rdf-parser.js';

describe('detectFormat', () => {
  it.each([
    ['/data/graph.nq', 'nquads'],
    ['/data/graph.nt', 'ntriples'],
    ['/data/graph.ttl', 'turtle'],
    ['/data/graph.trig', 'trig'],
    ['/data/graph.json', 'json'],
    ['/data/graph.jsonld', 'jsonld'],
  ] as const)('detects %s → %s', (path, expected) => {
    expect(detectFormat(path)).toBe(expected);
  });

  it('defaults to json for unknown extensions', () => {
    expect(detectFormat('data.csv')).toBe('json');
    expect(detectFormat('data.txt')).toBe('json');
    expect(detectFormat('data')).toBe('json');
  });

  it('is case-insensitive for extensions', () => {
    expect(detectFormat('GRAPH.NQ')).toBe('nquads');
    expect(detectFormat('GRAPH.TTL')).toBe('turtle');
  });
});

describe('supportedExtensions', () => {
  it('returns all six expected extensions', () => {
    const exts = supportedExtensions();
    expect(exts).toContain('.nq');
    expect(exts).toContain('.nt');
    expect(exts).toContain('.ttl');
    expect(exts).toContain('.trig');
    expect(exts).toContain('.json');
    expect(exts).toContain('.jsonld');
    expect(exts).toHaveLength(6);
  });
});

describe('parseRdf', () => {
  const DEFAULT_GRAPH = 'did:dkg:paranet:test';

  describe('json format', () => {
    it('parses an array of quads', async () => {
      const content = JSON.stringify([
        { subject: 'urn:a', predicate: 'urn:p', object: '"hello"', graph: 'urn:g' },
      ]);
      const quads = await parseRdf(content, 'json', DEFAULT_GRAPH);
      expect(quads).toHaveLength(1);
      expect(quads[0].subject).toBe('urn:a');
      expect(quads[0].graph).toBe('urn:g');
    });

    it('parses { quads: [...] } wrapper format', async () => {
      const content = JSON.stringify({
        quads: [
          { subject: 'urn:x', predicate: 'urn:y', object: '"z"' },
        ],
      });
      const quads = await parseRdf(content, 'json', DEFAULT_GRAPH);
      expect(quads).toHaveLength(1);
      expect(quads[0].subject).toBe('urn:x');
    });

    it('uses defaultGraph when quad.graph is missing', async () => {
      const content = JSON.stringify([
        { subject: 'urn:a', predicate: 'urn:p', object: '"v"' },
      ]);
      const quads = await parseRdf(content, 'json', DEFAULT_GRAPH);
      expect(quads[0].graph).toBe(DEFAULT_GRAPH);
    });
  });

  describe('nquads format', () => {
    it('parses valid N-Quads content', async () => {
      const nq = '<urn:s> <urn:p> "hello" <urn:g> .\n<urn:s> <urn:p2> <urn:o> <urn:g> .';
      const quads = await parseRdf(nq, 'nquads', DEFAULT_GRAPH);
      expect(quads).toHaveLength(2);
      expect(quads[0].subject).toBe('urn:s');
      expect(quads[0].object).toBe('"hello"');
      expect(quads[1].object).toBe('urn:o');
    });
  });

  describe('ntriples format', () => {
    it('parses valid N-Triples and assigns defaultGraph', async () => {
      const nt = '<urn:s> <urn:p> "world" .';
      const quads = await parseRdf(nt, 'ntriples', DEFAULT_GRAPH);
      expect(quads).toHaveLength(1);
      expect(quads[0].graph).toBe(DEFAULT_GRAPH);
    });
  });

  describe('turtle format', () => {
    it('parses prefixed Turtle content', async () => {
      const ttl = `
        @prefix schema: <https://schema.org/> .
        <urn:alice> schema:name "Alice" .
      `;
      const quads = await parseRdf(ttl, 'turtle', DEFAULT_GRAPH);
      expect(quads).toHaveLength(1);
      expect(quads[0].predicate).toBe('https://schema.org/name');
      expect(quads[0].object).toBe('"Alice"');
    });
  });

  describe('jsonld format', () => {
    it('throws for @context-based JSON-LD (unsupported)', async () => {
      const jsonld = JSON.stringify({
        '@context': 'https://schema.org/',
        '@id': 'urn:x',
        name: 'Test',
      });
      await expect(parseRdf(jsonld, 'jsonld', DEFAULT_GRAPH)).rejects.toThrow(
        /JSON-LD with @context/,
      );
    });

    it('accepts JSON-LD that has subject/predicate/object shape', async () => {
      const content = JSON.stringify([
        { subject: 'urn:a', predicate: 'urn:p', object: '"val"' },
      ]);
      const quads = await parseRdf(content, 'jsonld', DEFAULT_GRAPH);
      expect(quads).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('rejects on invalid N-Triples content', async () => {
      await expect(parseRdf('not valid ntriples at all !!!', 'ntriples', DEFAULT_GRAPH))
        .rejects.toThrow();
    });
  });

  describe('literal serialization', () => {
    it('handles literals with language tags', async () => {
      const nt = '<urn:s> <urn:p> "bonjour"@fr .';
      const quads = await parseRdf(nt, 'ntriples', DEFAULT_GRAPH);
      expect(quads[0].object).toContain('@fr');
    });

    it('handles literals with datatypes', async () => {
      const nt = '<urn:s> <urn:p> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .';
      const quads = await parseRdf(nt, 'ntriples', DEFAULT_GRAPH);
      expect(quads[0].object).toContain('^^');
    });

    it('handles blank nodes', async () => {
      const nt = '_:b0 <urn:p> "val" .';
      const quads = await parseRdf(nt, 'ntriples', DEFAULT_GRAPH);
      expect(quads[0].subject).toContain('_:');
    });
  });
});
