// SPDX-License-Identifier: Apache-2.0
import { isSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/**
 * Whether the store holds any graph of a context graph: its root graph, or any graph in one of its
 * reserved partitions (`<root>/_…`), such as its asset graphs, `_meta` or read graphs. No context
 * graph id has a segment that starts with "_", so a reserved partition belongs to this context graph
 * alone. Other graphs under `<root>/` are not counted: a child context graph may own them, with
 * names that match this context graph's own layouts exactly (a child `<id>/context/7` and the
 * per-context-ID graph `<root>/context/7` are one IRI). An id that cannot be written as an IRI
 * holds nothing.
 */
export async function holdsContextGraphGraphs(
  store: Pick<TripleStore, 'hasGraph' | 'listGraphs' | 'listGraphsByPrefix'>,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const root = `did:dkg:context-graph:${contextGraphId}`;
  if (!isSafeIri(root)) return false;
  if (await store.hasGraph(root, { signal })) return true;
  const prefix = `${root}/_`;
  const graphs = store.listGraphsByPrefix
    ? await store.listGraphsByPrefix(prefix, { signal })
    : (await store.listGraphs({ signal })).filter((graph) => graph.startsWith(prefix));
  return graphs.length > 0;
}
