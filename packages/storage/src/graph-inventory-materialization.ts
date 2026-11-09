// SPDX-License-Identifier: Apache-2.0
import { measureGraphCatalogBytes } from './graph-catalog-response-limit.js';
import type { QueryOptions, TripleStore } from './triple-store.js';

/** Cost of the decoded source inventory, retained across visibility projections. */
export interface MeasuredGraphInventory<T extends readonly string[] = readonly string[]> {
  readonly graphs: T;
  readonly materializedBytes: number;
}
export function measureGraphInventory<T extends readonly string[]>(graphs: T): MeasuredGraphInventory<T> {
  return { graphs, materializedBytes: measureGraphCatalogBytes(graphs) };
}
export function filterGraphInventory(inventory: MeasuredGraphInventory, visible: (graph: string) => boolean): MeasuredGraphInventory<string[]> {
  return { graphs: inventory.graphs.filter(visible), materializedBytes: inventory.materializedBytes };
}
/** Use the outer visibility boundary; measure a complete fallback before filtering. */
export async function readGraphInventory(store: TripleStore, options?: QueryOptions): Promise<MeasuredGraphInventory> {
  return store.readGraphInventory ? store.readGraphInventory(undefined, options) : measureGraphInventory(await store.listGraphs(options));
}
export async function readGraphInventoryByPrefix(store: TripleStore, prefix: string, options?: QueryOptions): Promise<MeasuredGraphInventory> {
  if (store.readGraphInventory) return store.readGraphInventory(prefix, options);
  if (store.listGraphsByPrefix) return measureGraphInventory(await store.listGraphsByPrefix(prefix, options));
  return filterGraphInventory(await readGraphInventory(store, options), graph => graph.startsWith(prefix));
}
