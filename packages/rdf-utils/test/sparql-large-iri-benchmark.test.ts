import { describe, expect, it } from 'vitest';
import { prepareSparql } from '../src/sparql-lexical-scanner.js';
import { scanSparqlIriRef } from '../src/sparql-lexical-primitives.js';

describe('large raw IRI scanner regression', () => {
  it('preserves the primitive scan coordinates and logical value in the prepared token', () => {
    const body = `urn:large:${'segment/'.repeat(32_768)}tail`;
    const source = `SELECT * WHERE { GRAPH <${body}> { ?s ?p ?o } }`;
    const iriStart = source.indexOf('<');
    const primitive = scanSparqlIriRef(source, iriStart);
    const prepared = prepareSparql(source);
    expect(primitive).not.toBeNull();
    expect(prepared.status).toBe('valid');
    if (primitive === null || prepared.status !== 'valid') return;
    expect(prepared.tokens.find((token) => token.kind === 'iri')).toMatchObject({
      kind: 'iri',
      logicalValue: body,
      start: iriStart,
      end: primitive.end,
    });
    expect(primitive.logicalValue).toBe(body);
  });
});
