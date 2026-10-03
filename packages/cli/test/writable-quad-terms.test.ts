import { describe, expect, it } from 'vitest';
import { validateWritableQuads } from '../src/daemon/knowledge-asset-quad-validation.js';

// The blank-node label matrix written for JSON-LD ingestion, run against the
// one validator the Knowledge Asset write routes use.
const quad = (terms: Record<string, string>) => ({ subject: 'urn:s', predicate: 'urn:p', object: '"value"', ...terms });

const validLabels = ['_:b0', '_:0', '_:a.b', '_:b-1', '_:é', '_:节点', '_:a\u0300', '_:\u{10000}'];
const invalidLabels = ['_:', '_:-x', '_:.x', '_:x.', '_:a b', '_:a\n', '_:a<urn:p>', '_:a#comment', '_:a\\u0062', '_:\u0300', '_:\ud800', '_:\u{F0000}', ' _:b0', '_:b0 '];

describe.each(['subject', 'object'] as const)('writable RDF blank-node %s', (field) => {
  it.each(validLabels)('accepts the complete label %s', (term) => {
    expect(validateWritableQuads('quads', [quad({ [field]: term })])).toBeNull();
  });
  it.each(invalidLabels)('rejects malformed or injectable label %s', (term) => {
    expect(validateWritableQuads('quads', [quad({ [field]: term })])?.error).toContain(`quads[0].${field}`);
  });
});

it.each(['"literal"', 'urn:o', 'https://example.org/o'])('preserves ordinary RDF object %s', (object) => {
  expect(validateWritableQuads('quads', [quad({ object })])).toBeNull();
});
// N-Triples allows ':' inside a label. The write routes take the SPARQL 1.1
// form (rdf-utils), which does not, so the label stays writable in an update.
it.each(['subject', 'object'] as const)('rejects a colon in a blank-node %s label', (field) => {
  expect(validateWritableQuads('quads', [quad({ [field]: '_::x' })])?.error).toContain(`quads[0].${field}`);
});
it.each(['hello', '123', 'urn:o> . <urn:injected> <urn:p> <urn:o'])('rejects invalid RDF object %s', (object) => {
  expect(validateWritableQuads('quads', [quad({ object })])?.error).toContain('quads[0].object');
});
