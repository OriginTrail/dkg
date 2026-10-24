export const ASSERTION_NAMED_GRAPH_PREFIX = '/_named_graph/';

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

/** Exact parent inverse of a named child produced by assertionScopedGraphUri. */
export function assertionScopedGraphParentUri(scopedGraphUri: string): string | undefined {
  const boundary = scopedGraphUri.lastIndexOf(ASSERTION_NAMED_GRAPH_PREFIX);
  if (boundary < 0) return undefined;
  const encoded = scopedGraphUri.slice(boundary + ASSERTION_NAMED_GRAPH_PREFIX.length);
  if (encoded.length === 0 || encodeAssertionNamedGraph(decodeAssertionNamedGraph(encoded)) !== encoded) {
    return undefined;
  }
  return scopedGraphUri.slice(0, boundary);
}

export function assertionOriginalGraph(wmGraphUri: string, scopedGraphUri: string): string {
  const prefix = `${wmGraphUri}${ASSERTION_NAMED_GRAPH_PREFIX}`;
  if (!scopedGraphUri.startsWith(prefix)) return '';
  return decodeAssertionNamedGraph(scopedGraphUri.slice(prefix.length));
}

export function isAssertionScopedChildGraph(graphUri: string, wmGraphUri: string): boolean {
  return graphUri.startsWith(`${wmGraphUri}${ASSERTION_NAMED_GRAPH_PREFIX}`);
}
