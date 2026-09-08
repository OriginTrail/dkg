import { describe, expect, it } from 'vitest';
import { validateWritableQuadTerms } from '../src/daemon/http-utils.js';

const validLabels = ['_:b0', '_:0', '_:a.b', '_:b-1', '_:é', '_:节点', '_:a\u0300', '_:\u{10000}', '_::x'];
const invalidLabels = ['_:', '_:-x', '_:.x', '_:x.', '_:a b', '_:a\n', '_:a<urn:p>', '_:a#comment', '_:a\\u0062', '_:\u0300', '_:\ud800', '_:\u{F0000}', ' _:b0', '_:b0 '];

describe.each(['subject', 'object'] as const)('writable RDF blank-node %s', (field) => {
  it.each(validLabels)('accepts the complete label %s', (term) => {
    expect(validateWritableQuadTerms('quads', [{ subject: 'urn:s', object: '"value"', [field]: term }])).toBeNull();
  });
  it.each(invalidLabels)('rejects malformed or injectable label %s', (term) => {
    expect(validateWritableQuadTerms('quads', [{ subject: 'urn:s', object: '"value"', [field]: term }])).toContain(`quads[0].${field}`);
  });
});

it.each(['"literal"', 'urn:o', 'https://example.org/o'])('preserves ordinary RDF object %s', (object) => {
  expect(validateWritableQuadTerms('quads', [{ subject: 'urn:s', object }])).toBeNull();
});
it.each(['hello', '123', 'urn:o> . <urn:injected> <urn:p> <urn:o'])('rejects invalid RDF object %s', (object) => {
  expect(validateWritableQuadTerms('quads', [{ subject: 'urn:s', object }])).toContain('quads[0].object');
});
