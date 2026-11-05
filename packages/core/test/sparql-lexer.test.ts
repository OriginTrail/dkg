import { describe, expect, it } from 'vitest';
import * as root from '@origintrail-official/dkg-core';
import * as publicLexer from '@origintrail-official/dkg-core/sparql-lexer';
import { stripSparqlLiteralsAndComments as legacyMask } from '@origintrail-official/dkg-core/dist/sparql-operation.js';
import { stripSparqlLiteralsAndComments as sourceLegacyMask } from '../src/sparql-operation.js';
import {
  prepareSparql,
  stripSparqlLiteralsAndComments,
} from '../src/sparql-lexer.js';

describe('Core SPARQL lexer boundary', () => {
  it('preserves masking through the published root, lexer, and legacy operation entry points', () => {
    const source = 'ASK { ?s ?p "x" } # c';
    const expected = 'ASK { ?s ?p     }    ';
    for (const mask of [root.stripSparqlLiteralsAndComments, publicLexer.stripSparqlLiteralsAndComments,
      legacyMask, sourceLegacyMask, stripSparqlLiteralsAndComments]) {
      expect(mask(source)).toBe(expected);
    }
    expect(root.prepareSparql(source).masked).toBe(expected);
    expect(publicLexer.prepareSparql(source).masked).toBe(expected);
  });

  it('keeps opaque strings, IRIs, and comments out of structural masking', () => {
    const source = String.raw`SELECT ?s WHERE {
      ?s <https://example.test/a#b> "literal { not a group }" . # comment { }
    }`;
    const prepared = prepareSparql(source);

    expect(prepared.status).toBe('valid');
    expect(prepared.masked).toHaveLength(source.length);
    expect(stripSparqlLiteralsAndComments(source)).toBe(prepared.masked);
    expect(prepared.masked).toContain('SELECT');
    expect(prepared.masked).toContain('{');
    expect(prepared.masked).not.toContain('https://example.test/a#b');
    expect(prepared.masked).not.toContain('literal { not a group }');
    expect(prepared.masked).not.toContain('comment { }');
    expect(prepared.tokens.filter((token) => token.kind === 'iri')).toHaveLength(1);
    expect(prepared.tokens.filter((token) => token.kind === 'string')).toHaveLength(1);
  });
});
