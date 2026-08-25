import { describe, expect, it } from 'vitest';
import { analyzeSparqlOperation } from '../src/sparql-operation.js';

describe('analyzeSparqlOperation memoization', () => {
  it('reuses one immutable analysis for an exact query across store layers', () => {
    const sparql = `
      SELECT ?g WHERE {
        VALUES ?g { <urn:graph:1> <urn:graph:2> }
        GRAPH ?g { ?s ?p ?o }
      }
    `;

    const first = analyzeSparqlOperation(sparql);
    const second = analyzeSparqlOperation(sparql);

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.operation)).toBe(true);
    expect(first).toEqual({
      operation: { kind: 'read', form: 'SELECT' },
      mutatingKeyword: null,
    });
  });

  it('does not retain oversized one-off query strings', () => {
    const sparql = `SELECT * WHERE { ?s ?p ?o } # ${'x'.repeat(64 * 1024)}`;

    expect(analyzeSparqlOperation(sparql)).not.toBe(analyzeSparqlOperation(sparql));
  });

  it('evicts cold entries when the bounded cache fills', () => {
    const cold = 'SELECT * WHERE { <urn:cold> ?p ?o }';
    const first = analyzeSparqlOperation(cold);
    for (let i = 0; i < 300; i += 1) {
      analyzeSparqlOperation(`SELECT * WHERE { <urn:hot:${i}> ?p ?o }`);
    }

    expect(analyzeSparqlOperation(cold)).not.toBe(first);
  });
});
