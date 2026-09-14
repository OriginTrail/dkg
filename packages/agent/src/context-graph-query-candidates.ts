// SPDX-License-Identifier: Apache-2.0

import { contextGraphStorageOwnerCandidates } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

export type ContextGraphQueryStore = Pick<TripleStore, 'query' | 'listGraphs' | 'listGraphsByPrefix'>;

export const MAX_UNSCOPED_QUERY_OWNER_CANDIDATES = 512;
export const UNSCOPED_QUERY_ADMISSION_TIMEOUT_MS = 5_000;

/** Reject the whole request; never authorize a truncated inventory. */
export function assertUnscopedQueryCandidateLimit(count: number): void {
  if (count > MAX_UNSCOPED_QUERY_OWNER_CANDIDATES) {
    throw new Error('Cannot authorize unscoped query: owner candidate limit exceeded; specify contextGraphId');
  }
}

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
  for (const graph of graphUris) {
    opts.signal?.throwIfAborted();
    if (!graph.startsWith(prefix)) continue;
    const owners = contextGraphStorageOwnerCandidates(graph);
    if (owners === undefined) {
      throw new Error('Cannot authorize unscoped query: unrecognized stored Context Graph owner');
    }
    for (const id of owners) {
      candidates.add(id);
      assertUnscopedQueryCandidateLimit(candidates.size);
    }
  }
  opts.signal?.throwIfAborted();
  return [...candidates];
}
