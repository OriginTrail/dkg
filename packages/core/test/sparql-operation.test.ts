import { describe, expect, it } from 'vitest';
import {
  analyzeSparqlOperation,
  classifySparqlOperation,
} from '../src/sparql-operation.js';
import {
  BoundedLruCache,
  SPARQL_ANALYSIS_CACHE_MAX_ENTRIES,
  SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH,
} from '../src/bounded-lru-cache.js';

describe('analyzeSparqlOperation memoization', () => {
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
});

describe('bounded SPARQL analysis cache policy', () => {
  const createCache = () => new BoundedLruCache<string, object>(
    SPARQL_ANALYSIS_CACHE_MAX_ENTRIES,
    (source) => source.length <= SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH,
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
    const oversized = 'x'.repeat(SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH + 1);
    cache.set(oversized, {});
    expect(cache.size).toBe(0);
    expect(cache.has(oversized)).toBe(false);
  });
});
