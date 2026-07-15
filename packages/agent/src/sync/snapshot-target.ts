export type SnapshotTarget =
  | { readonly kind: 'storeRef'; readonly ref: string }
  | { readonly kind: 'graphBacked'; readonly graph: string };

const GRAPH_BACKED_SNAPSHOT_PREFIX = 'did:dkg:context-graph:';

/**
 * Parse snapshot intent once at the request boundary. `snapshotGraph` is the
 * explicit current wire field; URI-shaped `snapshotRef` remains accepted for
 * rolling compatibility with older graph-backed requesters.
 */
export function parseSnapshotTarget(input: {
  readonly snapshotRef?: string;
  readonly snapshotGraph?: string;
}): SnapshotTarget | undefined {
  const snapshotRef = input.snapshotRef?.trim();
  const snapshotGraph = input.snapshotGraph?.trim();
  if (snapshotGraph) {
    if (snapshotRef && snapshotRef !== snapshotGraph) return undefined;
    return { kind: 'graphBacked', graph: snapshotGraph };
  }
  if (!snapshotRef) return undefined;
  if (snapshotRef.startsWith(GRAPH_BACKED_SNAPSHOT_PREFIX)) {
    return { kind: 'graphBacked', graph: snapshotRef };
  }
  return { kind: 'storeRef', ref: snapshotRef };
}
