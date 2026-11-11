// SPDX-License-Identifier: Apache-2.0
import { isSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/**
 * Whether the store holds any graph of a context graph: its root graph, or any graph in one of its
 * reserved partitions (`<root>/_…`), such as its asset graphs or read graphs. Context graph ids may
 * contain "/", so a graph elsewhere under `<root>/` may belong to another context graph, such as a
 * child; no context graph id has a segment that starts with "_", so a reserved partition belongs to
 * this one alone. An id that cannot be written as an IRI holds nothing.
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
