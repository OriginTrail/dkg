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

    for (const source of [
      '?DELETE',
      'ex:DELETE',
      'foo\\-DELETE',
      'DELETE:value',
      'ex:foo.DELETE',
    ]) {
      expect(readStandaloneSparqlWord(source, source.indexOf('DELETE'))).toBeNull();
    }
    expect(readStandaloneSparqlWord('drop.core:value', 0)).toBeNull();

    const dotSeparated = '?s ?p ?o.GRAPH <urn:outside> {}';
    const graphStart = dotSeparated.indexOf('GRAPH');
    expect(readStandaloneSparqlWord(dotSeparated, graphStart)).toEqual({
      word: 'GRAPH',
      start: graphStart,
      end: graphStart + 'GRAPH'.length,
    });

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

    const dotSeparatedMutation = 'SELECT * WHERE { ?s ?p ?o.DELETE WHERE { ?x ?y ?z } }';
    expect(analyzeSparqlOperation(dotSeparatedMutation).mutatingKeyword).toBe('DELETE');
    expect(recognizedReadOnlySparqlForm(analyzeSparqlOperation(dotSeparatedMutation))).toBeNull();

    const prefixedName = 'SELECT * WHERE { BIND(ex:foo.DELETE AS ?value) }';
    expect(analyzeSparqlOperation(prefixedName).mutatingKeyword).toBeNull();
    expect(recognizedReadOnlySparqlForm(analyzeSparqlOperation(prefixedName))).toBe('SELECT');

    for (const dottedPrefix of ['drop.core', 'graph.core', 'from.core']) {
      const query = `PREFIX ${dottedPrefix}: <urn:test:> SELECT * WHERE { ${dottedPrefix}:value ?p ?o }`;
      expect(analyzeSparqlOperation(query).mutatingKeyword).toBeNull();
      expect(recognizedReadOnlySparqlForm(analyzeSparqlOperation(query))).toBe('SELECT');
    }
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
