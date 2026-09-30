import { describe, expect, it } from 'vitest';
import * as rdfUtils from '../src/index.js';

describe('rdf-utils package façade', () => {
  it('keeps lexical implementation helpers out of the root export', () => {
    expect(rdfUtils).not.toHaveProperty('parseRdfLiteralLexicalTermWith');
    expect(rdfUtils).not.toHaveProperty('isRdfLanguageTag');
    expect(rdfUtils).not.toHaveProperty('isRdfBlankNodeTerm');
  });

  it('retains the intentional canonical RDF and TSV APIs', () => {
    expect(rdfUtils).toMatchObject({
      parseRdfLiteralLexicalTerm: expect.any(Function),
      parseSparqlTsvResultTerm: expect.any(Function),
      canonicalizeSparqlTsvResultTerm: expect.any(Function),
      parseSparqlTsvHeaderVariable: expect.any(Function),
    });
  });
});
