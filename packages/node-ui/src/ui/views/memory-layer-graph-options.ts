/**
 * Graph options for the memory layer pages' graph view. A pure builder over
 * an explicit `GraphPalette` (graph-palette.ts): the caller gets the palette
 * with `useGraphPalette()`, so the options rebuild when the theme changes and
 * need no document to resolve.
 */
import type { GraphPalette } from '../graph-palette.js';
import { memoryGraphLabels } from '../lib/memoryLabels.js';

export function graphOptions(palette: GraphPalette, classColors: Record<string, string>) {
  return {
    labelMode: 'humanized' as const,
    renderer: '2d' as const,
    labels: memoryGraphLabels({ extraPredicates: ['http://schema.org/text'] }),
    style: {
      classColors,
      defaultNodeColor: palette.neutral.node,
      defaultEdgeColor: palette.neutral.edge,
      edgeWidth: 0.9,
    },
    hexagon: { baseSize: 9, minSize: 8, maxSize: 13, scaleWithDegree: true },
    focus: { maxNodes: 3000, hops: 999 },
  };
}
