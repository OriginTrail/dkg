import { describe, it, expect } from 'vitest';
import { parseNTriples, parseNQuads } from '../src/parsers/ntriples.js';
import { parseTurtle } from '../src/parsers/turtle.js';
import { parseJsonLd } from '../src/parsers/jsonld.js';

describe('parseNTriples', () => {
  it('parses a simple triple', () => {
    const input = '<http://example.org/alice> <http://schema.org/name> "Alice" .';
    const triples = parseNTriples(input);
    expect(triples).toHaveLength(1);
    expect(triples[0].subject).toBe('http://example.org/alice');
    expect(triples[0].predicate).toBe('http://schema.org/name');
    expect(triples[0].object).toBe('Alice');
  });

  it('preserves literal datatypes', () => {
    const input = '<urn:s> <urn:p> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .';
    const triples = parseNTriples(input);
    expect(triples[0].datatype).toBe('http://www.w3.org/2001/XMLSchema#integer');
  });

  it('preserves language tags', () => {
    const input = '<urn:s> <urn:p> "bonjour"@fr .';
    const triples = parseNTriples(input);
    expect(triples[0].language).toBe('fr');
  });

  it('handles URI objects', () => {
    const input = '<urn:s> <urn:p> <urn:o> .';
    const triples = parseNTriples(input);
    expect(triples[0].object).toBe('urn:o');
  });

  it('handles blank nodes', () => {
    const input = '_:b0 <urn:p> "val" .';
    const triples = parseNTriples(input);
    expect(triples[0].subject).toMatch(/b0/);
  });

  it('parses multiple lines', () => {
    const input = [
      '<urn:a> <urn:p1> "v1" .',
      '<urn:a> <urn:p2> "v2" .',
      '<urn:b> <urn:p1> "v3" .',
    ].join('\n');
    const triples = parseNTriples(input);
    expect(triples).toHaveLength(3);
  });
});

describe('parseNQuads', () => {
  it('parses quads with named graphs', () => {
    const input = '<urn:s> <urn:p> "val" <urn:graph1> .';
    const triples = parseNQuads(input);
    expect(triples).toHaveLength(1);
    expect(triples[0].graph).toBe('urn:graph1');
  });

  it('handles default graph (no graph component)', () => {
    const input = '<urn:s> <urn:p> "val" .';
    const triples = parseNQuads(input);
    expect(triples).toHaveLength(1);
    expect(triples[0].graph).toBeUndefined();
  });

  it('parses multiple quads with different graphs', () => {
    const input = [
      '<urn:s> <urn:p> "a" <urn:g1> .',
      '<urn:s> <urn:p> "b" <urn:g2> .',
    ].join('\n');
    const triples = parseNQuads(input);
    expect(triples).toHaveLength(2);
    expect(triples[0].graph).toBe('urn:g1');
    expect(triples[1].graph).toBe('urn:g2');
  });
});

describe('parseTurtle', () => {
  it('parses prefixed Turtle and returns prefix map', () => {
    const ttl = `
      @prefix schema: <https://schema.org/> .
      @prefix ex: <http://example.org/> .
      ex:alice schema:name "Alice" .
    `;
    const { triples, prefixes } = parseTurtle(ttl);

    expect(triples).toHaveLength(1);
    expect(triples[0].subject).toBe('http://example.org/alice');
    expect(triples[0].predicate).toBe('https://schema.org/name');
    expect(triples[0].object).toBe('Alice');

    expect(prefixes['schema']).toBe('https://schema.org/');
    expect(prefixes['ex']).toBe('http://example.org/');
  });

  it('handles literals with language tags', () => {
    const ttl = `
      @prefix ex: <http://example.org/> .
      ex:item ex:label "hola"@es .
    `;
    const { triples } = parseTurtle(ttl);
    expect(triples[0].language).toBe('es');
  });

  it('handles literals with datatypes', () => {
    const ttl = `
      @prefix ex: <http://example.org/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      ex:item ex:count "5"^^xsd:integer .
    `;
    const { triples } = parseTurtle(ttl);
    expect(triples[0].datatype).toBe('http://www.w3.org/2001/XMLSchema#integer');
  });

  it('handles multiple triples with same subject', () => {
    const ttl = `
      @prefix ex: <http://example.org/> .
      ex:alice ex:name "Alice" ;
               ex:age "30" .
    `;
    const { triples } = parseTurtle(ttl);
    expect(triples).toHaveLength(2);
  });

  it('returns empty prefix map when no prefixes declared', () => {
    const ttl = '<http://example.org/s> <http://example.org/p> "val" .';
    const { prefixes } = parseTurtle(ttl);
    expect(Object.keys(prefixes).length).toBe(0);
  });
});

describe('parseJsonLd', () => {
  it('extracts triples from flat JSON-LD with @id and @type', async () => {
    const doc = {
      '@id': 'http://example.org/alice',
      '@type': 'http://schema.org/Person',
      'http://schema.org/name': 'Alice',
    };
    const triples = await parseJsonLd(doc);

    expect(triples.length).toBeGreaterThanOrEqual(2);
    const subjects = triples.map(t => t.subject);
    expect(subjects.every(s => s === 'http://example.org/alice')).toBe(true);

    const typeTriple = triples.find(t => t.predicate.includes('type'));
    expect(typeTriple).toBeDefined();
  });

  it('handles @graph array', async () => {
    const doc = {
      '@graph': [
        { '@id': 'urn:a', 'http://ex.org/name': 'A' },
        { '@id': 'urn:b', 'http://ex.org/name': 'B' },
      ],
    };
    const triples = await parseJsonLd(doc);
    const subjects = new Set(triples.map(t => t.subject));
    expect(subjects.has('urn:a')).toBe(true);
    expect(subjects.has('urn:b')).toBe(true);
  });

  it('handles @value objects', async () => {
    const doc = {
      '@id': 'urn:x',
      'http://ex.org/count': { '@value': '42', '@type': 'http://www.w3.org/2001/XMLSchema#integer' },
    };
    const triples = await parseJsonLd(doc);
    const countTriple = triples.find(t => t.predicate === 'http://ex.org/count');
    expect(countTriple).toBeDefined();
    expect(countTriple!.object).toBe('42');
    expect(countTriple!.datatype).toBe('http://www.w3.org/2001/XMLSchema#integer');
  });

  it('handles string input (parses JSON)', async () => {
    const json = JSON.stringify({ '@id': 'urn:s', 'http://ex.org/p': 'val' });
    const triples = await parseJsonLd(json);
    expect(triples.length).toBeGreaterThanOrEqual(1);
  });

  it('handles object references via @id', async () => {
    const doc = {
      '@id': 'urn:parent',
      'http://ex.org/child': { '@id': 'urn:child' },
    };
    const triples = await parseJsonLd(doc);
    const refTriple = triples.find(t => t.predicate === 'http://ex.org/child');
    expect(refTriple).toBeDefined();
    expect(refTriple!.object).toBe('urn:child');
  });
});
