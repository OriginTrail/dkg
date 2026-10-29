import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { assertSafeRdfTerm } from '@origintrail-official/dkg-core';
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
  const DEFAULT_GRAPH = 'did:dkg:context-graph:test';

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
      // Pin to parser-shaped error vocabulary. A bare `rejects.toThrow()` would
      // incorrectly pass if parseRdf started failing for unrelated reasons
      // (e.g. missing module, bad graph arg) — we want to prove the syntax
      // validator rejected the garbage input.
      await expect(parseRdf('not valid ntriples at all !!!', 'ntriples', DEFAULT_GRAPH))
        .rejects.toThrow(/parse|parsing|syntax|invalid|unexpected|expected|ntriples|n-triples|eof|token/i);
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

    it('escapes quotes, backslashes, line breaks and control characters in literal values', async () => {
      const ttl = [
        '@prefix ex: <urn:ex:> .',
        'ex:s ex:quote "say \\"hi\\"" ;',
        '  ex:path "C:\\\\new\\\\table" ;',
        '  ex:multi """line one',
        'line two\r""" ;',
        '  ex:lang "a \\"b\\""@en ;',
        '  ex:ctrl "\\u0001bell\\u007F\\b\\f" ;',
        '  ex:typed "x\\ny"^^<urn:dt> .',
      ].join('\n');
      const quads = await parseRdf(ttl, 'turtle', DEFAULT_GRAPH);
      expect(quads.map((q) => q.object)).toEqual([
        '"say \\"hi\\""',
        // Unescaped, `\n` and `\t` would read back as a newline and a tab.
        '"C:\\\\new\\\\table"',
        '"line one\\nline two\\r"',
        '"a \\"b\\""@en',
        // Other control characters use \uXXXX, or the short \b / \f escapes.
        '"\\u0001bell\\u007F\\b\\f"',
        '"x\\ny"^^<urn:dt>',
      ]);
    });

    it('produces literals that read back as the original values', async () => {
      const values = ['plain', 'say "hi"', 'C:\\new\\table', 'one\ntwo\r\n', 'tab\there', 'café Δ 😀', '\u0001bell\u007f'];
      const nt = values.map((value, i) => `<urn:s> <urn:p${i}> ${JSON.stringify(value)} .`).join('\n');
      const quads = await parseRdf(nt, 'ntriples', DEFAULT_GRAPH);
      const reparsed = new Parser({ format: 'N-Triples' }).parse(
        quads.map((q) => `<${q.subject}> <${q.predicate}> ${q.object} .`).join('\n'),
      );
      expect(reparsed.map((q) => q.object.value)).toEqual(values);
    });

    it('produces literals the storage layer accepts as SPARQL terms', async () => {
      const ttl = '<urn:s> <urn:p> """a "quoted" \\\\ value\nacross lines"""@en , "tab\\there" .';
      const quads = await parseRdf(ttl, 'turtle', DEFAULT_GRAPH);
      expect(quads).toHaveLength(2);
      for (const quad of quads) expect(() => assertSafeRdfTerm(quad.object)).not.toThrow();
    });
  });
});
