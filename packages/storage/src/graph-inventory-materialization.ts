// SPDX-License-Identifier: Apache-2.0
import { assertMeasuredGraphCatalogWithinResponseLimit, measureGraphCatalogBytes } from './graph-catalog-response-limit.js';
import { readCompleteGraphCatalog } from './graph-catalog-internal-limit.js';
import type { QueryOptions, TripleStore } from './triple-store.js';

/** The graphs a caller receives, with the measured size of exactly those graphs. */
export interface MeasuredGraphInventory<T extends readonly string[] = readonly string[]> {
  readonly graphs: T;
  readonly materializedBytes: number;
}
export function measureGraphInventory<T extends readonly string[]>(graphs: T): MeasuredGraphInventory<T> {
  return { graphs, materializedBytes: measureGraphCatalogBytes(graphs) };
}
/** A projection costs what it keeps, not the list it was cut from. */
export function filterGraphInventory(inventory: MeasuredGraphInventory, visible: (graph: string) => boolean): MeasuredGraphInventory<string[]> {
  return measureGraphInventory(inventory.graphs.filter(visible));
}
/** A caller's byte limit bounds only what it receives: its slice, or the complete list without a prefix. */
export function boundGraphInventory<T extends readonly string[]>(inventory: MeasuredGraphInventory<T>, options?: QueryOptions): MeasuredGraphInventory<T> {
  if (options?.maxResponseBytes !== undefined) assertMeasuredGraphCatalogWithinResponseLimit(inventory.materializedBytes, options.maxResponseBytes);
  return inventory;
}
/** Use the outer visibility boundary; without one, the complete list is read as node work. */
export async function readGraphInventory(store: TripleStore, options?: QueryOptions): Promise<MeasuredGraphInventory> {
  if (store.readGraphInventory) return store.readGraphInventory(undefined, options);
  return boundGraphInventory(measureGraphInventory(await readCompleteGraphCatalog(options, internal => store.listGraphs(internal))), options);
}
export async function readGraphInventoryByPrefix(store: TripleStore, prefix: string, options?: QueryOptions): Promise<MeasuredGraphInventory> {
  if (store.readGraphInventory) return store.readGraphInventory(prefix, options);
  if (store.listGraphsByPrefix) return measureGraphInventory(await store.listGraphsByPrefix(prefix, options));
  // No prefix listing: the complete list is node work; the caller pays for, and is bounded by, its slice.
  const graphs = await readCompleteGraphCatalog(options, internal => store.listGraphs(internal));
  return boundGraphInventory(measureGraphInventory(graphs.filter(graph => graph.startsWith(prefix))), options);
}
