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

  it('the deprecated delete shim returns the canonical update and reports nothing', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const valid = [{ subject: '_:b0', predicate: 'http://ex/p', object: '"v"', graph: 'http://ex/g' }];
      const invalid = [{ subject: '_:b0', predicate: 'http://ex/p q', object: '"v"', graph: 'http://ex/g' }];
      const shimmed = [valid, invalid].map((quads) => sparqlHttp.buildBlankNodeSafeDelete(quads));
      // The shim, like the function it replaces, reports nothing.
      expect(observed.counted).toEqual([]);
      // The adapters' factory builds the same updates, and reports the invalid term once.
      expect([valid, invalid].map((quads) => sparqlStatements('sparql-http').deleteData(quads)!.update))
        .toEqual(shimmed);
      expect(observed.counted.map((point) => [point.operation, point.position])).toEqual([['delete', 'predicate']]);
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
    // A blank node used to be rendered as the invalid IRI <_:b0>; it now throws.
    expect(() => atomicGraphReplace.formatObject('_:b0')).toThrow(/object cannot be a blank node/);
    expect(atomicGraphReplace.unwrapIri('<urn:x>')).toBe('urn:x');
  });
});
