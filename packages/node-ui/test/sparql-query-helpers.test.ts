import { describe, expect, it } from 'vitest';
import { metaGraphPrefixFilter } from '../src/ui/lib/sparql.js';

describe('SPARQL query helpers', () => {
  it('serializes a hostile graph id as exactly one round-trippable literal', () => {
    const contextGraphId = ['cg-', '\\', '"', '\n', '\r', '\t', '") } UNION { ?s ?p ?o } #'].join('');
    const prefix = `did:dkg:context-graph:${contextGraphId}/meta`;
    const filter = metaGraphPrefixFilter(contextGraphId);

    expect(filter).toBe(`FILTER(strstarts(str(?g), ${JSON.stringify(prefix)}))`);
    const serializedLiteral = filter.slice('FILTER(strstarts(str(?g), '.length, -2);
    expect(JSON.parse(serializedLiteral)).toBe(prefix);
  });
});
