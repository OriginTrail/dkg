// SPDX-License-Identifier: Apache-2.0

import { contextGraphStorageOwnerCandidates } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

export type ContextGraphQueryStore = Pick<TripleStore, 'query' | 'listGraphs' | 'listGraphsByPrefix'>;

export const UNSCOPED_QUERY_ADMISSION_TIMEOUT_MS = 5_000;

/**
 * Possible persisted owners for unscoped admission, not declared CGs or grants.
 * Missing metadata cannot rule out a legacy owner of an ambiguous graph name.
 */
export async function listStoredContextGraphQueryCandidates(
  store: ContextGraphQueryStore,
  opts: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const prefix = 'did:dkg:context-graph:';
  const options = { source: 'agent.query.rfc64RuntimePrivateGraphs', ...opts };
  opts.signal?.throwIfAborted();
  const graphUris = store.listGraphsByPrefix
    ? await store.listGraphsByPrefix(prefix, options)
    : (await store.listGraphs(options)).filter((uri) => uri.startsWith(prefix));
  const candidates = new Set<string>();
  let visited = 0;
  for (const graph of graphUris) {
    // Let caller cancellation and the admission deadline interrupt a large
    // local inventory too; a cardinality cutoff would reject ordinary KA growth.
    if (visited++ % 512 === 511) await new Promise<void>((resolve) => setImmediate(resolve));
    opts.signal?.throwIfAborted();
    if (!graph.startsWith(prefix)) continue;
    const owners = contextGraphStorageOwnerCandidates(graph);
    if (owners === undefined) {
      throw new Error('Cannot authorize unscoped query: unrecognized stored Context Graph owner');
    }
    for (const id of owners) {
      candidates.add(id);
    }
  }
  opts.signal?.throwIfAborted();
  return [...candidates];
}
