import { describe, expect, it } from 'vitest';
import { formatCanonicalRdfTerm } from '../src/index.js';

describe('formatCanonicalRdfTerm', () => {
  const XSD = 'http://www.w3.org/2001/XMLSchema#';
  it.each([
    ['a named node', { termType: 'NamedNode', value: 'urn:x' }, 'urn:x'],
    ['a blank node', { termType: 'BlankNode', value: 'b0' }, '_:b0'],
    ['the default graph', { termType: 'DefaultGraph', value: '' }, ''],
    ['a plain literal', { termType: 'Literal', value: 'say "hi"\n', language: '' }, '"say \\"hi\\"\\n"'],
    [
      'an xsd:string literal as plain',
      { termType: 'Literal', value: 'v', language: '', datatype: { value: `${XSD}string` } },
      '"v"',
    ],
    [
      'a typed literal',
      { termType: 'Literal', value: '42', language: '', datatype: { value: `${XSD}integer` } },
      `"42"^^<${XSD}integer>`,
    ],
    [
      'a language-tagged literal',
      { termType: 'Literal', value: 'hallo', language: 'de', datatype: { value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString' } },
      '"hallo"@de',
    ],
  ])('renders %s', (_name, term, expected) => {
    expect(formatCanonicalRdfTerm(term)).toBe(expected);
  });
});
