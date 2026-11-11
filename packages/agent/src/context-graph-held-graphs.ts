// SPDX-License-Identifier: Apache-2.0
import { isSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/**
 * The partitions under `<root>/` that hold a context graph's own graphs whether or not it registers
 * anything: its reserved partitions (`_…`, such as asset graphs, `_meta` and read graphs), its
 * per-context-ID graphs and its working-memory assertion graphs. No new context graph id has a
 * segment that starts with "_", and no sub-graph is named `context` or `assertion`. A sub-graph's
 * graphs belong to the view only through `_meta`, which registers it.
 */
const OWN_PARTITIONS = ['_', 'context/', 'assertion/'] as const;

/**
 * Whether the store holds any graph of a context graph: its root graph, or a graph in one of the
 * partitions above. Context graph ids may contain "/", so another graph under `<root>/` may belong
 * to another context graph, such as a child. An id that cannot be written as an IRI holds nothing.
 */
export async function holdsContextGraphGraphs(
  store: Pick<TripleStore, 'hasGraph' | 'listGraphs' | 'listGraphsByPrefix'>,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const root = `did:dkg:context-graph:${contextGraphId}`;
  if (!isSafeIri(root)) return false;
  if (await store.hasGraph(root, { signal })) return true;
  const prefixes = OWN_PARTITIONS.map((partition) => `${root}/${partition}`);
  if (!store.listGraphsByPrefix) {
    return (await store.listGraphs({ signal })).some((graph) => prefixes.some((prefix) => graph.startsWith(prefix)));
  }
  for (const prefix of prefixes) {
    if ((await store.listGraphsByPrefix(prefix, { signal })).length > 0) return true;
  }
  return false;
}
