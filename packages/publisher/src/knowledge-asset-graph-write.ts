// SPDX-License-Identifier: Apache-2.0
import { tryReplaceGraphAtomically, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

/** A complete KA graph must swap atomically, including an empty replacement. */
export async function replaceExactKnowledgeAssetGraph(
  store: TripleStore,
  graphUri: string,
  quads: readonly Quad[],
  operation: string,
): Promise<void> {
  const graphQuads = quads.map((quad) => ({ ...quad, graph: graphUri }));
  const replaced = await tryReplaceGraphAtomically(store, graphUri, graphQuads);
  if (!replaced) {
    throw Object.assign(
      new Error(
        `${operation} requires atomic complete-graph replacement, but the configured triple store does not support it`,
      ),
      { code: 'ATOMIC_GRAPH_REPLACE_UNSUPPORTED', graphUri },
    );
  }
}
