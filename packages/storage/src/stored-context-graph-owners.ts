import { readGraphInventoryByPrefix } from './graph-inventory-materialization.js';
// SPDX-License-Identifier: Apache-2.0
import { contextGraphStorageOwnerCandidates, READ_GRAPH_SEGMENT } from '@origintrail-official/dkg-core';
import { isReadGraphPartitionGraph } from './graph-enumeration-visibility.js';
import type { QueryOptions, TripleStore } from './triple-store.js';
const CG_PREFIX = 'did:dkg:context-graph:';

/** Read and meter the complete inventory before projecting possible owners. */
export async function listStoredContextGraphOwnerCandidates(store: TripleStore, options: QueryOptions,
  materializationMeter?: { consumeBytes(bytes: number): void }): Promise<string[]> {
    options.signal?.throwIfAborted();
    const readOptions = { ...options, source: options.source ?? 'storage.contextGraphOwnerCandidates' };
    const graphUris = await readGraphInventoryByPrefix(store, CG_PREFIX, readOptions);
    // Charge the decoded inventory before filtering or deduplicating owners.
    // The fallback reads the whole inventory, so it charges that whole response.
    materializationMeter?.consumeBytes(graphUris.materializedBytes);
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

/** A graph in a read-graph partition is owned by the context graph whose partition holds it. */
function ownerStorageUri(graph: string): string {
  if (!isReadGraphPartitionGraph(graph)) return graph;
  const segments = graph.slice(CG_PREFIX.length).split('/');
  return CG_PREFIX + segments.slice(0, segments.indexOf(READ_GRAPH_SEGMENT, 1)).join('/');
}
