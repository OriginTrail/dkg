import type { TripleStore } from './triple-store.js';

/** Only known complete decorator chains may project raw query inventories. */
export function composeGraphEnumerationVisibility(inner: TripleStore, visible: (graph: string) => boolean) {
  const innerVisible = inner.graphEnumerationVisibility?.bind(inner);
  return innerVisible ? (graph: string) => innerVisible(graph) && visible(graph) : undefined;
}
