import { describe, expect, it } from 'vitest';
import * as sparqlHttp from '../src/adapters/sparql-http.js';
import * as atomicGraphReplace from '../src/atomic-graph-replace.js';
import { sparqlStatements } from '../src/adapters/sparql-statements.js';
import { observeInvalidSparqlTerms } from './helpers/invalid-sparql-term-observer.js';

// These helpers moved, but `dist/adapters/sparql-http.js` and
// `dist/atomic-graph-replace.js` are public package paths, so the old modules
// keep exporting them. former-module-dist-paths.test.ts imports the built paths.
describe('exports kept at their former module paths', () => {
  it('adapters/sparql-http still exports the blank-node delete helpers', () => {
    expect(sparqlHttp.isBlankNodeTerm('_:b0')).toBe(true);
    expect(sparqlHttp.isBlankNodeTerm('http://ex/s')).toBe(false);
    expect(sparqlHttp.buildBlankNodeSafeDelete([])).toBeNull();
    expect(sparqlHttp.buildBlankNodeSafeDelete([
      { subject: 'http://ex/s', predicate: 'http://ex/p', object: '"v"', graph: 'http://ex/g' },
      { subject: '_:b0', predicate: 'http://ex/p', object: '"w"', graph: 'http://ex/g' },
    ])).toBe(
      'DELETE DATA {\nGRAPH <http://ex/g> { <http://ex/s> <http://ex/p> "v" . }\n};\n' +
      'DELETE { GRAPH <http://ex/g> {\n    ?b0 <http://ex/p> "w" .\n  } } ' +
      'WHERE { GRAPH <http://ex/g> {\n    ?b0 <http://ex/p> "w" .\n  } }',
    );
  });

  it('the deprecated delete shim returns the canonical update, while only the plan carries diagnostics', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const valid = [{ subject: '_:b0', predicate: 'http://ex/p', object: '"v"', graph: 'http://ex/g' }];
      const invalid = [{ subject: '_:b0', predicate: 'http://ex/p q', object: '"v"', graph: 'http://ex/g' }];
      for (const quads of [valid, invalid]) {
        const plan = sparqlStatements('sparql-http').deleteData(quads)!;
        expect(sparqlHttp.buildBlankNodeSafeDelete(quads)).toBe(plan.update);
      }
      expect(sparqlStatements('sparql-http').deleteData(valid)!.invalidTerms).toEqual([]);
      expect(sparqlStatements('sparql-http').deleteData(invalid)!.invalidTerms).toHaveLength(1);
      // The shim, like the function it replaces, reports nothing.
      expect(observed.counted).toEqual([]);
    } finally {
      observed.restore();
    }
  });

  it('atomic-graph-replace still exports formatObject and unwrapIri', () => {
    expect(atomicGraphReplace.formatObject('<urn:o>')).toBe('<urn:o>');
    expect(atomicGraphReplace.formatObject('"v"@en')).toBe('"v"@en');
    expect(atomicGraphReplace.formatObject('"42"^^http://www.w3.org/2001/XMLSchema#integer'))
      .toBe('"42"^^<http://www.w3.org/2001/XMLSchema#integer>');
    expect(() => atomicGraphReplace.formatObject('"x\ny"')).toThrow(/^Unsafe RDF term/);
    expect(atomicGraphReplace.unwrapIri('<urn:x>')).toBe('urn:x');
  });
});
