import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  contextGraphLayerUri,
  parseDeterministicKnowledgeAssetUal,
} from '@origintrail-official/dkg-core';

const ROOTLESS_LAYERS = new Set<string>(Object.values(MemoryLayer));

/**
 * A rootless lifecycle's physical graph is deterministic from its reserved UAL,
 * memory layer and optional subgraph.  Derive that canonical
 * graph at read time instead of trusting a stale name-keyed assertionGraph row
 * that an older gossip/SWM bootstrap may have inserted before the final KA
 * identity was known.
 *
 * Legacy/root-scoped records do not carry contentScopeVersion=2 and therefore
 * retain their persisted assertionGraph unchanged.
 */
export function canonicalRootlessLifecycleGraph(params: {
  readonly contextGraphId: string;
  readonly contentScopeVersion?: string;
  readonly reservedUal?: string;
  readonly memoryLayer?: string;
  readonly subGraphName?: string;
  readonly persistedGraph: string;
}): string {
  if (
    params.contentScopeVersion !== String(GRAPH_KA_CONTENT_SCOPE_VERSION)
    || !params.reservedUal
    || !params.memoryLayer
    || !ROOTLESS_LAYERS.has(params.memoryLayer)
  ) {
    return params.persistedGraph;
  }

  try {
    const identity = parseDeterministicKnowledgeAssetUal(params.reservedUal);
    return contextGraphLayerUri(
      params.contextGraphId,
      params.memoryLayer as MemoryLayer,
      identity.agentAddress,
      identity.kaNumber,
      params.subGraphName,
    );
  } catch {
    // A malformed or non-deterministic legacy UAL must not make history reads
    // fail.  The persisted pointer remains the compatibility fallback.
    return params.persistedGraph;
  }
}
