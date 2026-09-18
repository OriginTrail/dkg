import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Parser } from 'n3';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { detectFormat, supportedExtensions, parseRdf, parseRdfInput } from '../src/rdf-parser.js';

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
    it('expands a local context into RDF and applies the default graph', async () => {
      const content = JSON.stringify({
        '@context': { name: 'https://schema.org/name' }, '@id': 'urn:person:alice', name: 'Alice',
      });
      expect(await parseRdf(content, 'jsonld', DEFAULT_GRAPH)).toEqual([
        { subject: 'urn:person:alice', predicate: 'https://schema.org/name', object: '"Alice"', graph: DEFAULT_GRAPH },
      ]);
    });

    it('reports syntax provenance while preserving named graphs independently of lifecycle policy', async () => {
      const quads = [{ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph: 'urn:g' }];
      const document = { '@id': 'urn:g', '@graph': [{ '@id': 'urn:s', 'urn:p': 'v' }] };
      expect(await parseRdfInput(JSON.stringify(document), 'jsonld', DEFAULT_GRAPH))
        .toEqual({ sourceKind: 'jsonld', quads });
      expect(await parseRdfInput(JSON.stringify(quads), 'jsonld', DEFAULT_GRAPH))
        .toEqual({ sourceKind: 'legacy-quads', quads });
      expect(await parseRdfInput('<urn:s> <urn:p> "v" <urn:g> .', 'nquads', DEFAULT_GRAPH))
        .toEqual({ sourceKind: 'rdf', quads });
    });

    it('preserves named graphs, language/datatype literals and nested blank-node links', async () => {
      const content = JSON.stringify({
        '@context': { ex: 'https://example.org/', label: 'ex:label', count: 'ex:count', detail: 'ex:detail' },
        '@id': 'urn:named-graph',
        '@graph': [{ '@id': 'urn:event', label: { '@value': 'Dobar dan', '@language': 'sr' }, count: 7,
          detail: { label: 'Nested' } }],
      });
      const quads = await parseRdf(content, 'jsonld', DEFAULT_GRAPH);
      expect(quads).toHaveLength(4);
      expect(quads.every((q) => q.graph === 'urn:named-graph')).toBe(true);
      expect(quads).toContainEqual({ subject: 'urn:event', predicate: 'https://example.org/label', object: '"Dobar dan"@sr', graph: 'urn:named-graph' });
      expect(quads).toContainEqual({ subject: 'urn:event', predicate: 'https://example.org/count', object: '"7"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: 'urn:named-graph' });
      const detail = quads.find((q) => q.predicate === 'https://example.org/detail')!.object;
      expect(detail).toMatch(/^_:/);
      expect(quads).toContainEqual({ subject: detail, predicate: 'https://example.org/label', object: '"Nested"', graph: 'urn:named-graph' });
    });

    it('preserves list order and plain JSON-LD arrays', async () => {
      const quads = await parseRdf(JSON.stringify([
        { '@id': 'urn:list', 'https://example.org/items': { '@list': [{ '@id': 'urn:first' }, { '@id': 'urn:second' }] } },
        { '@id': 'urn:other', 'https://example.org/label': 'Other' },
      ]), 'jsonld', DEFAULT_GRAPH);
      const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
      const head = quads.find((q) => q.subject === 'urn:list')!.object;
      const tail = quads.find((q) => q.subject === head && q.predicate === `${rdf}rest`)!.object;
      expect(quads).toContainEqual({ subject: head, predicate: `${rdf}first`, object: 'urn:first', graph: DEFAULT_GRAPH });
      expect(quads).toContainEqual({ subject: tail, predicate: `${rdf}first`, object: 'urn:second', graph: DEFAULT_GRAPH });
      expect(quads).toContainEqual({ subject: tail, predicate: `${rdf}rest`, object: `${rdf}nil`, graph: DEFAULT_GRAPH });
      expect(quads).toContainEqual({ subject: 'urn:other', predicate: 'https://example.org/label', object: '"Other"', graph: DEFAULT_GRAPH });
    });

    it.each(['context', 'import'])('rejects remote %s loading without requesting the local endpoint', async (kind) => {
      let requests = 0;
      const server = createServer((_req, res) => {
        requests++;
        res.writeHead(200, { 'Content-Type': 'application/ld+json' });
        res.end(JSON.stringify({ '@context': { label: 'https://example.org/label' } }));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      try {
        const context = `http://127.0.0.1:${address.port}/context`;
        const input = { '@context': kind === 'context' ? context : { '@import': context }, '@id': 'urn:event', label: 'Remote context' };
        await expect(parseRdf(JSON.stringify(input), 'jsonld', DEFAULT_GRAPH)).rejects.toThrow(/Remote JSON-LD contexts are disabled/);
        expect(requests).toBe(0);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      }
    });

    it('round-trips escaped text through actual storage', async () => {
      const text = 'He said "hello".\nPath C:\\temp\tŽ';
      const quads = await parseRdf(JSON.stringify({ '@id': 'urn:event', 'https://example.org/text': text }), 'jsonld', DEFAULT_GRAPH);
      const store = new OxigraphStore();
      try {
        await store.insert(quads);
        const result = await store.query(`SELECT ?text WHERE { GRAPH <${DEFAULT_GRAPH}> { <urn:event> <https://example.org/text> ?text } }`);
        expect(result).toMatchObject({ type: 'bindings', bindings: [{ text: quads[0].object }] });
        if (result.type !== 'bindings') throw new Error('Expected literal bindings');
        const stored = new Parser({ format: 'N-Triples' }).parse(`<urn:event> <https://example.org/text> ${result.bindings[0].text} .`);
        expect(stored[0].object.value).toBe(text);
        // The canonical lexical form escapes once; it remains valid N-Quads.
        expect(await parseRdf(`<urn:event> <https://example.org/text> ${quads[0].object} .`, 'ntriples', DEFAULT_GRAPH)).toEqual(quads);
      } finally {
        await store.close();
      }
    });

    it('honors an inline base for document-relative identifiers', async () => {
      const input = { '@context': { '@base': 'https://example.org/data/', name: 'https://schema.org/name' }, '@id': 'asset/1', name: 'Alice' };
      expect(await parseRdf(JSON.stringify(input), 'jsonld', DEFAULT_GRAPH, 'file:///tmp/input.jsonld')).toEqual([
        { subject: 'https://example.org/data/asset/1', predicate: 'https://schema.org/name', object: '"Alice"', graph: DEFAULT_GRAPH },
      ]);
    });

    it.each(['null', '42', '"https://example.org/not-a-document"'])('rejects scalar JSON-LD %s', async (content) => {
      await expect(parseRdf(content, 'jsonld', DEFAULT_GRAPH)).rejects.toThrow('JSON-LD input must be an object or array');
    });

    it.each([
      { '@id': 'asset/1', 'https://schema.org/name': 'Alice' },
      { '@id': 'urn:event', name: 'Unmapped property' },
    ])('rejects lossy JSON-LD conversion without silently omitting statements', async (input) => {
      await expect(parseRdf(JSON.stringify(input), 'jsonld', DEFAULT_GRAPH)).rejects.toThrow(/Safe mode validation/);
    });

    it('rejects malformed JSON-LD contexts', async () => {
      await expect(parseRdf('{"@context":42,"@id":"urn:event"}', 'jsonld', DEFAULT_GRAPH))
        .rejects.toThrow(/context/i);
    });

    it('accepts an empty JSON-LD array as an empty dataset', async () => {
      expect(await parseRdf('[]', 'jsonld', DEFAULT_GRAPH)).toEqual([]);
    });

    it('does not mistake contextual JSON-LD fields for a legacy quad', async () => {
      const content = [{
        '@context': { '@vocab': 'https://example.org/' }, '@id': 'urn:event',
        subject: 'Subject', predicate: 'Predicate', object: 'Object',
      }];
      const quads = await parseRdf(JSON.stringify(content), 'jsonld', DEFAULT_GRAPH);
      expect(quads).toHaveLength(3);
      expect(quads.every((q) => q.subject === 'urn:event')).toBe(true);
      expect(quads.map((q) => q.predicate).sort()).toEqual([
        'https://example.org/object', 'https://example.org/predicate', 'https://example.org/subject',
      ]);
    });

    it.each(['urn:event', 'asset/1'])('loads a JSON-LD file with identifier %s through the CLI input boundary', async (id) => {
      const { loadQuadsFromInput } = await import('../src/cli-helpers.js');
      const directory = await mkdtemp(join(tmpdir(), 'dkg-jsonld-ingest-'));
      try {
        const file = join(directory, 'event.jsonld');
        await writeFile(file, JSON.stringify({ '@context': { name: 'https://schema.org/name' }, '@id': id, name: 'CLI input' }));
        expect(await loadQuadsFromInput({ file }, DEFAULT_GRAPH)).toEqual([
          { subject: new URL(id, pathToFileURL(file)).href, predicate: 'https://schema.org/name', object: '"CLI input"', graph: DEFAULT_GRAPH },
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it.each([undefined, '', 'urn:named'])('keeps legacy JSON and JSON-LD graph handling identical (%s)', async (graph) => {
      const content = JSON.stringify([{ subject: 'urn:a', predicate: 'urn:p', object: '"val"', graph }]);
      const expected = [{ subject: 'urn:a', predicate: 'urn:p', object: '"val"', graph: graph || DEFAULT_GRAPH }];
      expect(await parseRdf(content, 'jsonld', DEFAULT_GRAPH)).toEqual(expected);
      expect(await parseRdf(content, 'json', DEFAULT_GRAPH)).toEqual(expected);
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
  });
});
