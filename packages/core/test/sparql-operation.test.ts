import { describe, expect, it } from 'vitest';
import {
  analyzeSparqlOperation,
  classifySparqlOperation,
} from '../src/sparql-operation.js';

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

  it('preserves cold-query correctness when the bounded cache fills', () => {
    const cold = 'SELECT * WHERE { <urn:cold> ?p ?o }';
    expect(analyzeSparqlOperation(cold).operation).toEqual({ kind: 'read', form: 'SELECT' });
    for (let i = 0; i < 300; i += 1) {
      analyzeSparqlOperation(`SELECT * WHERE { <urn:hot:${i}> ?p ?o }`);
    }

    expect(analyzeSparqlOperation(cold).operation).toEqual({ kind: 'read', form: 'SELECT' });
  });
});
