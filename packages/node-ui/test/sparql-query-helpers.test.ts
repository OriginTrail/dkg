import { describe, expect, it } from 'vitest';
import { metaGraphPrefixFilter } from '../src/ui/lib/sparql.js';

describe('SPARQL query helpers', () => {
  it('escapes every character that can break a graph-prefix string literal', () => {
    const contextGraphId = ['cg-"', '\\', '\n', '\r', '\t'].join('');
    const filter = metaGraphPrefixFilter(contextGraphId);

    expect(filter.startsWith('FILTER(strstarts(str(?g), "did:dkg:context-graph:')).toBe(true);
    expect(filter.endsWith('/meta"))')).toBe(true);
    expect(filter).toContain('\\"');
    expect(filter).toContain('\\\\');
    expect(filter).toContain('\\n');
    expect(filter).toContain('\\r');
    expect(filter).toContain('\\t');
    expect(filter).not.toContain('\n');
    expect(filter).not.toContain('\r');
    expect(filter).not.toContain('\t');
  });
});
