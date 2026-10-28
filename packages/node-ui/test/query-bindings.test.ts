import { describe, expect, it } from 'vitest';
import { bindingLexicalValue, bindingRdfTerm } from '../src/ui/query-bindings.js';

describe('query binding codec across daemon and SPARQL JSON responses', () => {
  it.each([
    { lexical: '"quoted"', rdf: '"\\"quoted\\""', json: { type: 'literal', value: '"quoted"' } },
    { lexical: 'hello', rdf: '"hello"@en', json: { type: 'literal', value: 'hello', 'xml:lang': 'en' } },
    { lexical: '7', rdf: '"7"^^<urn:integer>', json: { type: 'typed-literal', value: '7', datatype: 'urn:integer' } },
    { lexical: 'line\nnext', rdf: '"line\\nnext"', json: { type: 'literal', value: 'line\nnext' } },
    { lexical: 'urn:resource', rdf: 'urn:resource', json: { type: 'uri', value: 'urn:resource' } },
  ])('preserves the lexical value and RDF identity of $rdf', ({ lexical, rdf, json }) => {
    expect(bindingLexicalValue(json)).toBe(lexical);
    expect(bindingLexicalValue(rdf)).toBe(lexical);
    expect(bindingRdfTerm(json)).toBe(rdf);
    expect(bindingRdfTerm(rdf)).toBe(rdf);
  });
  it('handles blank labels, bare compatibility values, absent terms and wrapped IRIs at the boundary', () => {
    expect(bindingRdfTerm({ type: 'bnode', value: 'child' })).toBe('_:child');
    expect(bindingRdfTerm('_:child')).toBe('_:child');
    expect(bindingLexicalValue({ value: 'legacy' })).toBe('legacy');
    expect(bindingLexicalValue('<urn:resource>')).toBe('urn:resource');
    expect(bindingLexicalValue(undefined)).toBeUndefined();
    expect(bindingRdfTerm(null)).toBeUndefined();
  });
});
