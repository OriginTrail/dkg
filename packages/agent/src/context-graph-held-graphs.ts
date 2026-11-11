// SPDX-License-Identifier: Apache-2.0
import { isSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/**
 * Whether the store holds any graph of a context graph: its root graph, or any graph under
 * `<root>/`, such as an asset graph. The trailing "/" keeps a context graph whose id merely
 * extends this one from counting. An id that cannot be written as an IRI holds nothing.
 */
export async function holdsContextGraphGraphs(
  store: Pick<TripleStore, 'hasGraph' | 'listGraphs' | 'listGraphsByPrefix'>,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const root = `did:dkg:context-graph:${contextGraphId}`;
  if (!isSafeIri(root)) return false;
  if (await store.hasGraph(root, { signal })) return true;
  const prefix = `${root}/`;
  const graphs = store.listGraphsByPrefix
    ? await store.listGraphsByPrefix(prefix, { signal })
    : (await store.listGraphs({ signal })).filter((graph) => graph.startsWith(prefix));
  return graphs.length > 0;
}
