import { describe, expect, it } from 'vitest';
import { assertSafeGraphIriForSparql, intLit, lit, rdfLiteralLexicalValue } from '../src/metadata-rdf-terms.js';

describe('publisher metadata RDF compatibility', () => {
  it('retains existing wire bytes, including raw tabs and escaped quotes, slashes and line breaks', () => {
    expect(lit('peer\t"a"\\b\n\r')).toBe('"peer\t\\"a\\"\\\\b\\n\\r"');
    expect(intLit(9007199254740993n)).toBe('"9007199254740993"^^<http://www.w3.org/2001/XMLSchema#integer>');
  });

  it.each(['', '@en', '^^<http://www.w3.org/2001/XMLSchema#string>'])(
    'decodes the same escaped lexical value with suffix %s', suffix => {
      expect(rdfLiteralLexicalValue('"peer\\"a\\\\b\\n\\r\\t\\u263A"' + suffix)).toBe('peer"a\\b\n\r\t☺');
    },
  );

  it.each(['urn:peer:a', '"unterminated', '"bad\\q"', '"raw\ttab"'])(
    'retains the existing refusal for a non-JSON lexical term %s', term => {
      expect(rdfLiteralLexicalValue(term)).toBeUndefined();
    },
  );

  it.each(['', 'relative', 'urn:peer:a', 'urn:peer:\u0001'])(
    'preserves the existing graph-IRI accepted form %s', iri => {
      expect(() => assertSafeGraphIriForSparql(iri)).not.toThrow();
    },
  );

  it.each(['urn:peer: space', 'urn:peer:\t', 'urn:peer:>', 'urn:peer:"', 'urn:peer:}'])(
    'still rejects unsafe graph-IRI delimiters %s', iri => {
      expect(() => assertSafeGraphIriForSparql(iri)).toThrow('Unsafe graph IRI for SPARQL query');
    },
  );
});
