import { describe, expect, it } from 'vitest';
import { prepareSparql, prepareSparqlQuery, boundPreparedSelect } from '../src/sparql.js';

function query(source: string) {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error('fixture must be valid');
  return prepareSparqlQuery(prepared);
}

describe('outer SELECT solution modifiers', () => {
  it('ignores nested modifiers and preserves their source', () => {
    const source = 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } ORDER BY ?s LIMIT 3 OFFSET 1 } }';
    const prepared = query(source);
    expect(prepared.solutionModifiers).toEqual({ hasLimit: false, hasOffset: false, hasOrderBy: false, insertionOffset: source.length });
    expect(boundPreparedSelect(prepared, 5)).toBe(source + '\nLIMIT 5\n');
  });

  it('inserts before trailing VALUES and closes comments without rewriting them', () => {
    const source = 'SELECT ?s WHERE { } ORDER BY ?s # ordered\nVALUES ?s { <urn:a> } # tail';
    const prepared = query(source);
    expect(prepared.solutionModifiers.hasOrderBy).toBe(true);
    expect(boundPreparedSelect(prepared, 2, 7)).toBe(source.replace('VALUES', '\nLIMIT 2 OFFSET 7\nVALUES'));
    const commented = query('SELECT ?s WHERE { ?s ?p ?o } # VALUES LIMIT OFFSET ORDER BY');
    expect(boundPreparedSelect(commented, 2)).toBe(commented.source + '\nLIMIT 2\n');
  });

  it('uses logical tokens while retaining UCHAR source coordinates', () => {
    const source = String.raw`SELECT ?s WHERE \u007B ?s ?p ?o \u007D ORDER BY ?s \u0056ALUES ?s { <urn:a> }`;
    const prepared = query(source);
    expect(prepared.solutionModifiers.hasOrderBy).toBe(true);
    expect(boundPreparedSelect(prepared, 2)).toBe(source.replace(String.raw`\u0056ALUES`, '\nLIMIT 2\n' + String.raw`\u0056ALUES`));
  });

  it.each(['LIMIT 1', 'OFFSET 2'])('reports and rejects existing outer %s', modifier => {
    const prepared = query('SELECT ?s WHERE { ?s ?p ?o } ' + modifier);
    expect(prepared.solutionModifiers[modifier.startsWith('LIMIT') ? 'hasLimit' : 'hasOffset']).toBe(true);
    expect(() => boundPreparedSelect(prepared, 2)).toThrow('without outer LIMIT or OFFSET');
  });

  it('reports SERVICE syntax at any depth, excluding literals and comments', () => {
    expect(query('SELECT ?s WHERE { { SERVICE <urn:remote> { ?s ?p ?o } } }').hasServiceClause).toBe(true);
    expect(query('SELECT ?s WHERE { ?s <urn:p> "SERVICE" } # SERVICE').hasServiceClause).toBe(false);
  });

  it('rejects non-SELECT transforms', () => {
    expect(() => boundPreparedSelect(query('ASK { ?s ?p ?o }'), 2)).toThrow('Expected a SELECT query');
  });

  it.each([[0, 0], [1.5, 0], [2, -1], [2, Number.MAX_SAFE_INTEGER + 1]])('rejects invalid modifier values %s/%s', (limit, offset) => {
    expect(() => boundPreparedSelect(query('SELECT ?s WHERE { ?s ?p ?o }'), limit, offset)).toThrow('safe integer');
  });
});
