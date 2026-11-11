// Node environment on purpose: the memory layer graph's options come from an
// explicit GraphPalette, so building them needs no document or computed CSS.
import { describe, expect, it } from 'vitest';
import { graphOptions } from '../src/ui/views/memory-layer-graph-options.js';
import { dataSlotHex, graphPalette } from '../src/ui/graph-palette.js';
import { schemaTypeColors } from '../src/ui/views/schema-type-colors.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const triples = [
  { subject: 'urn:a', predicate: RDF_TYPE, object: 'http://schema.org/Person' },
  { subject: 'urn:b', predicate: RDF_TYPE, object: 'http://schema.org/Thing' },
];

describe('memory layer graph options', () => {
  it.each(['dark', 'light'] as const)('resolve %s colours from the palette alone', (theme) => {
    expect(typeof document).toBe('undefined');
    const palette = graphPalette(theme);
    const options = graphOptions(palette, schemaTypeColors(triples, slot => dataSlotHex(palette, slot), palette.neutral.node));
    expect(options.style.defaultNodeColor).toBe(palette.neutral.node);
    expect(options.style.defaultEdgeColor).toBe(palette.neutral.edge);
    expect(options.style.classColors).toEqual({
      'http://schema.org/Person': dataSlotHex(palette, 1),
      'http://schema.org/Thing': palette.neutral.node,
    });
  });

  it('gives the two themes different canvas colours', () => {
    const dark = graphOptions(graphPalette('dark'), {});
    const light = graphOptions(graphPalette('light'), {});
    expect(dark.style.defaultNodeColor).not.toBe(light.style.defaultNodeColor);
  });
});
