// SPDX-License-Identifier: Apache-2.0
import { measureGraphCatalogBytes } from './graph-catalog-response-limit.js';
import type { QueryOptions, TripleStore } from './triple-store.js';

// Enumeration returns arrays for compatibility. This evidence belongs to their
// exact identity, survives projections, and never retains discarded graph strings.
const materializedBytes = new WeakMap<readonly string[], number>();
export function graphInventoryMaterializationBytes(graphs: readonly string[]): number {
  return materializedBytes.get(graphs) ?? measureGraphCatalogBytes(graphs);
}
export function withGraphInventoryMaterialization<T extends readonly string[]>(graphs: T, bytes: number): T {
  materializedBytes.set(graphs, Math.max(bytes, measureGraphCatalogBytes(graphs)));
  return graphs;
}
export function filterGraphInventory(graphs: readonly string[], visible: (graph: string) => boolean): string[] {
  return withGraphInventoryMaterialization(graphs.filter(visible), graphInventoryMaterializationBytes(graphs));
}
/** Outer-store enumeration retains visibility and the cost of a complete fallback. */
export async function readGraphInventoryByPrefix(store: TripleStore, prefix: string, options?: QueryOptions): Promise<string[]> {
  return store.listGraphsByPrefix ? store.listGraphsByPrefix(prefix, options)
    : filterGraphInventory(await store.listGraphs(options), graph => graph.startsWith(prefix));
}
