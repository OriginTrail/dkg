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
/**
 * Every read below bounds what the store returned, whether or not the store honoured the byte
 * options: a complete list by the internal ceiling, and anything returned by the caller's limit.
 */
export async function readGraphInventory(store: TripleStore, options?: QueryOptions): Promise<MeasuredGraphInventory> {
  const complete = store.readGraphInventory
    ? await store.readGraphInventory(undefined, options)
    // Without a visibility boundary the complete list is read as node work.
    : measureGraphInventory(await readCompleteGraphCatalog(options, internal => store.listGraphs(internal)));
  assertMeasuredGraphCatalogWithinInternalLimit(complete.materializedBytes);
  return boundGraphInventory(complete, options);
}
/** One complete inventory read as node work: the internal ceiling is its only byte limit. */
export async function readCompleteGraphInventory(store: TripleStore, options?: QueryOptions): Promise<MeasuredGraphInventory> {
  return readCompleteGraphCatalog(options, internal => readGraphInventory(store, internal));
}
export async function readGraphInventoryByPrefix(store: TripleStore, prefix: string, options?: QueryOptions): Promise<MeasuredGraphInventory> {
  if (store.readGraphInventory) return boundGraphInventory(await store.readGraphInventory(prefix, options), options);
  if (store.listGraphsByPrefix) return boundGraphInventory(measureGraphInventory(await store.listGraphsByPrefix(prefix, options)), options);
  // No prefix listing: the complete list is node work under the ceiling; the caller pays for, and is
  // bounded by, its slice.
  const graphs = await readCompleteGraphCatalog(options, internal => store.listGraphs(internal));
  assertGraphCatalogWithinInternalLimit(graphs);
  return boundGraphInventory(measureGraphInventory(graphs.filter(graph => graph.startsWith(prefix))), options);
}
