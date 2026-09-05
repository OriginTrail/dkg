import { beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeSparqlOperation,
  classifySparqlOperation,
} from '../src/sparql-operation.js';
import { sparqlAnalysisCacheTesting } from '../src/sparql-analysis-cache.js';
import {
  BoundedLruCache,
} from '../src/bounded-lru-cache.js';

describe('analyzeSparqlOperation memoization', () => {
  it.each([
    'PREFIX foaf.core: <http://xmlns.com/foaf/0.1/> SELECT ?s WHERE { ?s foaf.core:name ?n }',
    'PREFIX café: <https://example.com/> SELECT ?s WHERE { ?s café:name ?n }',
    'PREFIX δοκιμή: <https://example.com/> SELECT ?s WHERE { ?s δοκιμή:name ?n }',
    'BASE <https://example.com/> SELECT ?s WHERE { ?s ?p ?o }',
    'BASE<https://example.com/>SELECT ?s WHERE { ?s ?p ?o }',
    String.raw`PREFIX \u0065x: <https://example.com/> SELECT ?s WHERE { ?s ex:name ?n }`,
  ])('classifies a valid PN_PREFIX/BASE prologue: %s', (sparql) => {
    expect(classifySparqlOperation(sparql)).toEqual({ kind: 'read', form: 'SELECT' });
  });

  it('returns isolated mutable analyses while reusing the internal classification', () => {
    const sparql = `
      SELECT ?g WHERE {
        VALUES ?g { <urn:graph:1> <urn:graph:2> }
        GRAPH ?g { ?s ?p ?o }
      }
    `;

    const first = analyzeSparqlOperation(sparql);
    const second = analyzeSparqlOperation(sparql);

    expect(second).not.toBe(first);
    expect(second.operation).not.toBe(first.operation);
    expect(Object.isFrozen(first)).toBe(false);
    expect(Object.isFrozen(first.operation)).toBe(false);
    expect(second).toEqual({
      operation: { kind: 'read', form: 'SELECT' },
      mutatingKeyword: null,
    });

    first.operation = { kind: 'update' };
    first.mutatingKeyword = 'DELETE';
    expect(analyzeSparqlOperation(sparql)).toEqual(second);

    const classification = classifySparqlOperation(sparql);
    expect(() => { classification.kind = 'unknown'; }).not.toThrow();
    expect(classifySparqlOperation(sparql)).toEqual({ kind: 'read', form: 'SELECT' });
  });

  it('keeps oversized one-off query results isolated', () => {
    const sparql = `SELECT * WHERE { ?s ?p ?o } # ${'x'.repeat(64 * 1024)}`;

    const first = analyzeSparqlOperation(sparql);
    first.operation = { kind: 'unknown' };
    expect(analyzeSparqlOperation(sparql).operation).toEqual({ kind: 'read', form: 'SELECT' });
  });

  it('preserves a real mutating keyword on a cache hit', () => {
    const sparql = 'SELECT * WHERE {} INSERT DATA { <urn:a> <urn:b> <urn:c> }';
    expect(analyzeSparqlOperation(sparql).mutatingKeyword).toBe('INSERT');
    expect(analyzeSparqlOperation(sparql).mutatingKeyword).toBe('INSERT');
  });

  it('detects mutation from word tokens while preserving source spelling', () => {
    expect(analyzeSparqlOperation('SELECT * WHERE {} dElEtE DATA {}').mutatingKeyword)
      .toBe('dElEtE');
    expect(analyzeSparqlOperation(String.raw`SELECT * WHERE {} \u0044ELETE DATA {}`).mutatingKeyword)
      .toBe(String.raw`\u0044ELETE`);
    expect(analyzeSparqlOperation('SELECT * WHERE { ?s ex:DELETE ?o }').mutatingKeyword)
      .toBeNull();
    expect(analyzeSparqlOperation(String.raw`SELECT * WHERE {} \u0023 DELETE
`).mutatingKeyword).toBeNull();
  });

  it.each([
    String.raw`PREFIX \u00G0x: <https://example.com/> SELECT * WHERE {}`,
    String.raw`PREFIX \U00110000x: <https://example.com/> SELECT * WHERE {}`,
  ])('does not classify through a malformed escaped prefix: %s', (sparql) => {
    expect(classifySparqlOperation(sparql)).toEqual({ kind: 'unknown' });
  });
});

describe('bounded SPARQL analysis cache policy', () => {
  const maxEntries = 256;
  const maxSourceLength = 64 * 1024;
  const createCache = () => new BoundedLruCache<string, object>(
    maxEntries,
    (source) => source.length <= maxSourceLength,
  );

  it('returns a cached value and refreshes it before bounded eviction', () => {
    const cache = createCache();
    const values = Array.from({ length: 257 }, () => ({}));
    for (let i = 0; i < 256; i += 1) cache.set(`query-${i}`, values[i]);

    expect(cache.get('query-0')).toBe(values[0]);
    cache.set('query-256', values[256]);

    expect(cache.size).toBe(256);
    expect(cache.has('query-0')).toBe(true);
    expect(cache.has('query-1')).toBe(false);
    expect(cache.has('query-256')).toBe(true);
  });

  it('does not admit a source over 64 KiB', () => {
    const cache = createCache();
    const oversized = 'x'.repeat(maxSourceLength + 1);
    cache.set(oversized, {});
    expect(cache.size).toBe(0);
    expect(cache.has(oversized)).toBe(false);
  });

  it('evicts an undefined least-recently-used key without exceeding its bound', () => {
    const cache = new BoundedLruCache<string | undefined, number>(1);

    cache.set(undefined, 1);
    cache.set('a', 2);
    expect(cache.size).toBe(1);
    expect(cache.has(undefined)).toBe(false);
    expect(cache.get('a')).toBe(2);

    cache.set('b', 3);
    expect(cache.size).toBe(1);
    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe(3);
  });

  beforeEach(() => sparqlAnalysisCacheTesting.reset());

  const largeQuery = (suffix: string, padding = sparqlAnalysisCacheTesting.smallMaxSourceLength) => (
    `SELECT * WHERE { <urn:${suffix}> ?p ?o } # ${'x'.repeat(padding)}`
  );

  it('reuses a valid large query through the real analyzer integration', () => {
    const query = largeQuery('valid');

    expect(analyzeSparqlOperation(query).operation).toEqual({ kind: 'read', form: 'SELECT' });
    expect(sparqlAnalysisCacheTesting.has(query)).toBe(true);
    expect(sparqlAnalysisCacheTesting.snapshot()).toMatchObject({
      largeSize: 1,
      largeHits: 0,
      largeMisses: 1,
    });

    expect(analyzeSparqlOperation(query).operation).toEqual({ kind: 'read', form: 'SELECT' });
    expect(sparqlAnalysisCacheTesting.snapshot()).toMatchObject({
      largeSize: 1,
      largeHits: 1,
      largeMisses: 1,
    });
  });

  it('keeps small UNKNOWN reuse while malformed large input misses repeatedly', () => {
    const shortUnknown = String.raw`PREFIX \u00G0x: <https://example.com/> SELECT * WHERE {}`;
    analyzeSparqlOperation(shortUnknown);
    analyzeSparqlOperation(shortUnknown);
    expect(sparqlAnalysisCacheTesting.snapshot()).toMatchObject({
      smallSize: 1,
      smallHits: 1,
      smallMisses: 1,
    });

    const incomplete = `SELECT * WHERE { # ${'x'.repeat(
      sparqlAnalysisCacheTesting.smallMaxSourceLength,
    )}`;
    analyzeSparqlOperation(incomplete);
    analyzeSparqlOperation(incomplete);
    expect(sparqlAnalysisCacheTesting.has(incomplete)).toBe(false);
    expect(sparqlAnalysisCacheTesting.snapshot()).toMatchObject({
      largeSize: 0,
      largeHits: 0,
      largeMisses: 2,
    });
  });

  it('evicts the large tier at four entries and rejects over-limit input', () => {
    const first = largeQuery('first');
    analyzeSparqlOperation(first);
    for (let index = 0; index < 4; index++) {
      analyzeSparqlOperation(largeQuery(`next-${index}`));
    }
    expect(sparqlAnalysisCacheTesting.snapshot().largeSize).toBe(4);
    expect(sparqlAnalysisCacheTesting.has(first)).toBe(false);

    const overLimit = largeQuery('over-limit', sparqlAnalysisCacheTesting.largeMaxSourceLength);
    analyzeSparqlOperation(overLimit);
    expect(sparqlAnalysisCacheTesting.has(overLimit)).toBe(false);
    expect(sparqlAnalysisCacheTesting.snapshot().largeSize).toBe(4);
  });
});
