import { contextGraphDataUri, isSafeIri } from '@origintrail-official/dkg-core';
import type { QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';

const CONTEXT_GRAPH_PREFIX = contextGraphDataUri('');
const SWM_META_SUFFIX = '/_shared_memory_meta';

export async function listStoredContextGraphUris(store: TripleStore, options: QueryOptions): Promise<string[]> {
  const graphs = store.listGraphsByPrefix
    ? await store.listGraphsByPrefix(CONTEXT_GRAPH_PREFIX, options)
    : await store.listGraphs(options);
  return graphs.filter((graph) => graph.startsWith(CONTEXT_GRAPH_PREFIX));
}

/**
 * Possible policy IDs, never authoritative identities. Only an accepted policy
 * can distinguish an owner/name CG from a parent/subgraph address. Include all
 * ancestors so policy lookup also covers stores containing only descendant data.
 */
export function storedContextGraphPolicyCandidates(graphs: Iterable<string>): Set<string> {
  const candidates = new Set<string>();
  for (const graph of graphs) {
    if (!graph.startsWith(CONTEXT_GRAPH_PREFIX)) continue;
    let candidate = graph.slice(CONTEXT_GRAPH_PREFIX.length);
    while (candidate) {
      candidates.add(candidate);
      const slash = candidate.lastIndexOf('/');
      if (slash < 0) break;
      candidate = candidate.slice(0, slash);
    }
  }
  return candidates;
}

/** Physical SWM families survive declaration loss; no CG/subgraph split is inferred. */
export function storedSharedMemoryFamilies(graphs: Iterable<string>): Array<{
  scopeUri: string;
  dataGraph: string;
  metaGraph: string;
}> {
  const families = [];
  for (const graph of new Set(graphs)) {
    if (!graph.startsWith(CONTEXT_GRAPH_PREFIX) || !graph.endsWith(SWM_META_SUFFIX) || !isSafeIri(graph)) continue;
    const scopeUri = graph.slice(0, -SWM_META_SUFFIX.length);
    if (scopeUri.length <= CONTEXT_GRAPH_PREFIX.length) continue;
    families.push({ scopeUri, dataGraph: graph.slice(0, -'_meta'.length), metaGraph: graph });
  }
  return families;
}
