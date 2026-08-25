import { beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeSparqlOperation,
  classifySparqlOperation,
  sparqlAnalysisCacheTestHooks,
} from '../src/sparql-operation.js';

describe('analyzeSparqlOperation memoization', () => {
  beforeEach(() => sparqlAnalysisCacheTestHooks.reset());

  it('returns isolated mutable analyses while reusing the internal classification', () => {
    const sparql = `
      SELECT ?g WHERE {
        VALUES ?g { <urn:graph:1> <urn:graph:2> }
        GRAPH ?g { ?s ?p ?o }
      }
    `;

    const first = analyzeSparqlOperation(sparql);
    const second = analyzeSparqlOperation(sparql);

    expect(sparqlAnalysisCacheTestHooks.snapshot()).toEqual({
      keys: [sparql],
      hits: 1,
      misses: 1,
      bypasses: 0,
    });

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
    expect(sparqlAnalysisCacheTestHooks.snapshot()).toEqual({
      keys: [],
      hits: 0,
      misses: 0,
      bypasses: 2,
    });
  });

  it('refreshes LRU recency and evicts the oldest entry at the 256-entry cap', () => {
    const query = (i: number) => `SELECT * WHERE { <urn:query:${i}> ?p ?o }`;
    for (let i = 0; i < 256; i += 1) {
      analyzeSparqlOperation(query(i));
    }
    expect(sparqlAnalysisCacheTestHooks.snapshot().keys).toHaveLength(256);

    // A hit refreshes query 0 from the LRU head to the MRU tail.
    analyzeSparqlOperation(query(0));
    let snapshot = sparqlAnalysisCacheTestHooks.snapshot();
    expect(snapshot.keys[0]).toBe(query(1));
    expect(snapshot.keys.at(-1)).toBe(query(0));
    expect(snapshot.hits).toBe(1);

    // The 257th distinct query evicts query 1, not the refreshed query 0.
    analyzeSparqlOperation(query(256));
    snapshot = sparqlAnalysisCacheTestHooks.snapshot();
    expect(snapshot.keys).toHaveLength(256);
    expect(snapshot.keys).not.toContain(query(1));
    expect(snapshot.keys).toContain(query(0));
    expect(snapshot.keys.at(-1)).toBe(query(256));
    expect(snapshot.misses).toBe(257);
  });
});
