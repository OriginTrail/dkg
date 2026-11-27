import { readGraphInventoryByPrefix } from './graph-inventory-materialization.js';
import { readCompleteGraphCatalog } from './graph-catalog-internal-limit.js';
import type { CurrentGraphCatalogReadOptions } from './graph-set-refresh.js';
// SPDX-License-Identifier: Apache-2.0
import { contextGraphStorageOwnerCandidates } from '@origintrail-official/dkg-core';
import { readGraphPartitionOwner } from './graph-enumeration-visibility.js';
import type { QueryOptions, TripleStore } from './triple-store.js';
const CG_PREFIX = 'did:dkg:context-graph:';

/**
 * Every possible owner of a stored graph, for unscoped query admission. The inventory
 * read is node work: it runs under the internal catalog ceiling, never a caller's byte
 * limit, and nothing is charged to the caller. It reads a current catalog.
 */
export async function listStoredContextGraphOwnerCandidates(store: TripleStore, options: QueryOptions): Promise<string[]> {
    options.signal?.throwIfAborted();
    const readOptions = { ...options, source: options.source ?? 'storage.contextGraphOwnerCandidates' };
    // The internal options keep only the caller's lane, label and cancellation, so the current-catalog request goes on them.
    const current: CurrentGraphCatalogReadOptions = { currentCatalog: true };
    const graphUris = await readCompleteGraphCatalog(readOptions,
      internal => readGraphInventoryByPrefix(store, CG_PREFIX, { ...internal, ...current }));
    const candidates = new Set<string>();
    let visited = 0;
    for (const graph of graphUris.graphs) {
      // Preserve cancellation responsiveness without imposing a cardinality
      // limit: ordinary per-KA graph growth can legitimately be large.
      if (visited++ % 512 === 511) await new Promise<void>((resolve) => setImmediate(resolve));
      options.signal?.throwIfAborted();
      if (!graph.startsWith(CG_PREFIX)) continue;
      const owners = contextGraphStorageOwnerCandidates(ownerStorageUri(graph));
      if (owners === undefined) {
        throw new Error('Cannot authorize unscoped query: unrecognized stored Context Graph owner');
      }
      for (const id of owners) candidates.add(id);
    }
    options.signal?.throwIfAborted();
    return [...candidates];
}

/** A read graph or state graph is owned by the context graph whose partition holds it. */
function ownerStorageUri(graph: string): string {
  const owner = readGraphPartitionOwner(graph);
  return owner === undefined ? graph : CG_PREFIX + owner;
}
