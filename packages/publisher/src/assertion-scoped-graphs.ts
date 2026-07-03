import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ASSERTION_NAMED_GRAPH_PREFIX } from '@origintrail-official/dkg-core';

export {
  ASSERTION_NAMED_GRAPH_PREFIX,
  encodeAssertionNamedGraph,
  decodeAssertionNamedGraph,
  assertionScopedGraphUri,
  assertionOriginalGraph,
  isAssertionScopedChildGraph,
} from '@origintrail-official/dkg-core';

export type AssertionScopedGraphRootMode = 'if-present' | 'always' | 'named-only';

export async function listGraphsByPrefix(store: TripleStore, prefix: string): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix)
    : (await store.listGraphs()).filter((graph) => graph.startsWith(prefix));
}

export async function listAssertionScopedGraphUris(
  store: TripleStore,
  wmGraphUri: string,
  rootMode: AssertionScopedGraphRootMode = 'if-present',
): Promise<string[]> {
  const namedGraphs = (await listGraphsByPrefix(store, `${wmGraphUri}${ASSERTION_NAMED_GRAPH_PREFIX}`)).sort();
  if (rootMode === 'named-only') return namedGraphs;
  if (rootMode === 'always') return [wmGraphUri, ...namedGraphs];
  return (await store.hasGraph(wmGraphUri))
    ? [wmGraphUri, ...namedGraphs]
    : namedGraphs;
}
