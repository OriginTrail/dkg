import { describe, expect, it } from 'vitest';
import * as rdfUtils from '../src/index.js';

describe('rdf-utils package façade', () => {
  it('keeps lexical implementation helpers out of the root export', () => {
    expect(rdfUtils).not.toHaveProperty('parseRdfLiteralLexicalTermWith');
    expect(rdfUtils).not.toHaveProperty('isRdfLanguageTag');
  });

  it('exposes one blank-node label validator', () => {
    expect(Object.keys(rdfUtils).filter((name) => /blank.?node/i.test(name))).toEqual(['isRdfBlankNodeLabel']);
  });

  it('retains the semantic RDF and TSV parser APIs', () => {
    expect(rdfUtils).toMatchObject({
      parseRdfLiteralLexicalTerm: expect.any(Function),
      parseSparqlTsvResultTerm: expect.any(Function),
      parseSparqlTsvHeaderVariable: expect.any(Function),
    });
  });
});
