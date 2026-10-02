import { expect, it } from 'vitest';
// The package exports `./dist/*`, so an external consumer can import these
// built module paths directly. Import them the same way.
import * as sparqlHttp from '@origintrail-official/dkg-storage/dist/adapters/sparql-http.js';
import * as atomicGraphReplace from '@origintrail-official/dkg-storage/dist/atomic-graph-replace.js';

it('keeps the moved helpers importable from their former dist paths', () => {
  expect(sparqlHttp.isBlankNodeTerm('_:b0')).toBe(true);
  expect(sparqlHttp.buildBlankNodeSafeDelete([
    { subject: 'http://ex/s', predicate: 'http://ex/p', object: '"v"', graph: 'http://ex/g' },
  ])).toBe('DELETE DATA {\nGRAPH <http://ex/g> { <http://ex/s> <http://ex/p> "v" . }\n}');
  expect(atomicGraphReplace.formatObject('<urn:o>')).toBe('<urn:o>');
  expect(() => atomicGraphReplace.formatObject('_:b0')).toThrow(/object cannot be a blank node/);
  expect(atomicGraphReplace.unwrapIri('<urn:x>')).toBe('urn:x');
});
