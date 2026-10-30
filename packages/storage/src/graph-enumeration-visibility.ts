import { isAtomicGraphReplaceStagingGraph } from './atomic-graph-replace.js';
import type { TripleStore } from './triple-store.js';

/** Only known complete decorator chains may project raw query inventories. */
export function composeGraphEnumerationVisibility(inner: TripleStore, visible: (graph: string) => boolean) {
  const innerVisible = inner.graphEnumerationVisibility?.bind(inner);
  return innerVisible ? (graph: string) => innerVisible(graph) && visible(graph) : undefined;
}

/** The same named-graph visibility policy is exposed by embedded and worker Oxigraph. */
export const oxigraphGraphEnumerationVisibility = (graph: string): boolean => Boolean(graph) && !isAtomicGraphReplaceStagingGraph(graph);
