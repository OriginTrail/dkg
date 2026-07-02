import type { TripleStore } from '@origintrail-official/dkg-storage';

export const ASSERTION_NAMED_GRAPH_PREFIX = '/_named_graph/';

export type AssertionScopedGraphRootMode = 'if-present' | 'always' | 'named-only';

export async function listGraphsByPrefix(store: TripleStore, prefix: string): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix)
    : (await store.listGraphs()).filter((graph) => graph.startsWith(prefix));
}

export function encodeAssertionNamedGraph(graph: string): string {
  return Buffer.from(graph, 'utf8').toString('base64url');
}

export function decodeAssertionNamedGraph(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

export function assertionScopedGraphUri(wmGraphUri: string, graph: string | undefined): string {
  const sourceGraph = graph ?? '';
  return sourceGraph === ''
    ? wmGraphUri
    : `${wmGraphUri}${ASSERTION_NAMED_GRAPH_PREFIX}${encodeAssertionNamedGraph(sourceGraph)}`;
}

export function assertionOriginalGraph(wmGraphUri: string, scopedGraphUri: string): string {
  const prefix = `${wmGraphUri}${ASSERTION_NAMED_GRAPH_PREFIX}`;
  if (!scopedGraphUri.startsWith(prefix)) return '';
  return decodeAssertionNamedGraph(scopedGraphUri.slice(prefix.length));
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
