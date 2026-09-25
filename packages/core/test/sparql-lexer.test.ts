import { describe, expect, it } from 'vitest';
import {
  prepareSparql,
  stripSparqlLiteralsAndComments,
} from '../src/sparql-lexer.js';

describe('Core SPARQL lexer boundary', () => {
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
