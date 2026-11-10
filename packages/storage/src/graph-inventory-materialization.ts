// SPDX-License-Identifier: Apache-2.0
import { assertMeasuredGraphCatalogWithinResponseLimit, measureGraphCatalogBytes } from './graph-catalog-response-limit.js';
import {
  assertGraphCatalogWithinInternalLimit,
  assertMeasuredGraphCatalogWithinInternalLimit,
  readCompleteGraphCatalog,
} from './graph-catalog-internal-limit.js';
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
  const complete = measureGraphInventory(await readCompleteGraphCatalog(options, internal => store.listGraphs(internal)));
  // A store may ignore byte options, so the ceiling also bounds what it returned.
  assertMeasuredGraphCatalogWithinInternalLimit(complete.materializedBytes);
  return boundGraphInventory(complete, options);
}
/** One complete inventory read as node work, bounded by the ceiling whatever the store did with byte options. */
export async function readCompleteGraphInventory(store: TripleStore, options?: QueryOptions): Promise<MeasuredGraphInventory> {
  const inventory = await readCompleteGraphCatalog(options, internal => readGraphInventory(store, internal));
  assertMeasuredGraphCatalogWithinInternalLimit(inventory.materializedBytes);
  return inventory;
}
export async function readGraphInventoryByPrefix(store: TripleStore, prefix: string, options?: QueryOptions): Promise<MeasuredGraphInventory> {
  if (store.readGraphInventory) return store.readGraphInventory(prefix, options);
  if (store.listGraphsByPrefix) return measureGraphInventory(await store.listGraphsByPrefix(prefix, options));
  // No prefix listing: the complete list is node work under the ceiling, even if the store ignores byte
  // options; the caller pays for, and is bounded by, its slice.
  const graphs = await readCompleteGraphCatalog(options, internal => store.listGraphs(internal));
  assertGraphCatalogWithinInternalLimit(graphs);
  return boundGraphInventory(measureGraphInventory(graphs.filter(graph => graph.startsWith(prefix))), options);
}
