import { describe, expect, it } from 'vitest';
import {
  analyzeSparqlOperation,
  readStandaloneSparqlWord,
  recognizedReadOnlySparqlForm,
} from '../src/sparql-operation.js';

describe('canonical standalone SPARQL word scanner', () => {
  it('recognizes standalone words and rejects legal name adjacency', () => {
    const standalone = '  SELECT ?s WHERE { ?s ?p ?o }';
    expect(readStandaloneSparqlWord(standalone, standalone.indexOf('SELECT'))).toEqual({
      word: 'SELECT',
      start: 2,
      end: 8,
    });

    for (const source of ['?DELETE', 'ex:DELETE', 'foo\\-DELETE', 'DELETE:value']) {
      expect(readStandaloneSparqlWord(source, source.indexOf('DELETE'))).toBeNull();
    }

    expect(readStandaloneSparqlWord('GRAPH?g{}', 0)).toEqual({
      word: 'GRAPH',
      start: 0,
      end: 5,
    });
    expect(analyzeSparqlOperation('SELECT * WHERE {}; DELETE?subject {}').mutatingKeyword)
      .toBe('DELETE');
  });

  it('shares the same boundary model with operation admission', () => {
    const read = 'SELECT * WHERE { BIND(ex:foo\\-DELETE AS ?value) }';
    expect(recognizedReadOnlySparqlForm(analyzeSparqlOperation(read))).toBe('SELECT');

    const mixed = `${read}; DELETE WHERE { ?s ?p ?o }`;
    expect(recognizedReadOnlySparqlForm(analyzeSparqlOperation(mixed))).toBeNull();
  });

  it('has no shared regex or cursor state across interleaved calls', () => {
    const update = 'SELECT * WHERE { ?s ?p ?o }; DROP ALL';
    const read = 'ASK { ?s ?p ?o }';
    for (let iteration = 0; iteration < 20; iteration++) {
      expect(analyzeSparqlOperation(update).mutatingKeyword).toBe('DROP');
      expect(recognizedReadOnlySparqlForm(analyzeSparqlOperation(read))).toBe('ASK');
    }
  });
});
