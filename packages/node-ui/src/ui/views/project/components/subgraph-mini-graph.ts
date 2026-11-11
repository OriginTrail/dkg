/**
 * Graph options for the compact graph on each sub-graph overview card:
 * pared-down labels, smaller nodes, and the card's colour as the default so
 * each card reads as a distinct "island" at a glance. A pure builder over an
 * explicit `GraphPalette` (see graph-palette.ts).
 */
import type { GraphPalette } from '../../../graph-palette.js';
import { memoryGraphLabels } from '../../../lib/memoryLabels.js';
import { codeClassColors, codePredicateColors, neutraliseBuiltinNamespaces } from '../helpers.js';

export function subGraphMiniGraphOptions(
  palette: GraphPalette,
  cardColor: string,
  nodeColors: Record<string, string>,
) {
  return {
    labelMode: 'humanized' as const,
    renderer: '2d' as const,
    labels: memoryGraphLabels({ minZoomForLabels: 0.8 }), // Keep labels out of the way in the mini view.
    style: {
      classColors: codeClassColors(palette),
      predicateColors: codePredicateColors(palette),
      namespaceColors: neutraliseBuiltinNamespaces(cardColor),
      // Per-URI tints sit ABOVE classColors / namespaceColors in
      // the style-engine priority stack — the trust colour wins for
      // every entity in the card's scope (#3 polish).
      ...(Object.keys(nodeColors).length > 0 ? { nodeColors } : {}),
      defaultNodeColor: cardColor,
      defaultEdgeColor: palette.neutral.edge,
      edgeWidth: 1.0,
      fontSize: 12 /* px: the canvas renderer takes a number */,
      gradient: true,
      gradientIntensity: 0.35,
    },
    hexagon: { baseSize: 6, minSize: 5, maxSize: 16, scaleWithDegree: true },
    focus: { maxNodes: 5000, hops: 999 },
  };
}
