// SPDX-License-Identifier: Apache-2.0

import { parseContextGraphStorageUri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/**
 * Possible persisted owners for unscoped admission, not declared CGs or grants.
 * Missing metadata cannot rule out a legacy owner of an ambiguous graph name.
 */
export async function listStoredContextGraphQueryCandidates(store: TripleStore): Promise<string[]> {
  const prefix = 'did:dkg:context-graph:';
  const options = { source: 'agent.query.rfc64RuntimePrivateGraphs' };
  const graphUris = store.listGraphsByPrefix
    ? await store.listGraphsByPrefix(prefix, options)
    : (await store.listGraphs(options)).filter((uri) => uri.startsWith(prefix));
  const candidates = new Set<string>();
  for (const graph of graphUris) {
    for (const id of parseContextGraphStorageUri(graph)?.ownerContextGraphIds ?? []) {
      candidates.add(id);
    }
  }
  return [...candidates];
}
