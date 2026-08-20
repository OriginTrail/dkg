import {
  assertSafeIri,
} from '@origintrail-official/dkg-core';
import type {
  QueryOptions,
  TripleStore,
} from '@origintrail-official/dkg-storage';

export type MemoryLayerKey = 'wm' | 'swm' | 'vm';

export interface MemoryLayerBinding {
  s: string;
  p: string;
  o: string;
  g: string;
}

export interface MemoryLayerReadResult {
  bindings: MemoryLayerBinding[];
  ok: boolean;
  truncated: boolean;
}

export interface MemoryLayersSnapshot {
  layers: Record<MemoryLayerKey, MemoryLayerReadResult>;
}

export interface ContextGraphNamedGraphStats {
  graph: string;
  entityCount: number;
  tripleCount: number;
}

export const MEMORY_LAYER_LIMITS: Record<MemoryLayerKey, number> = {
  wm: 50_000,
  swm: 20_000,
  vm: 20_000,
};

// Keep each query-plan branch set deliberately small. Large VALUES lists bound
// to GRAPH variables make Oxigraph choose a CartesianProductJoinIterator and
// were the source of the multi-core query storm fixed by this module.
export const EXACT_GRAPH_QUERY_BATCH_SIZE = 8;

const LAYER_KEYS: readonly MemoryLayerKey[] = ['wm', 'swm', 'vm'];

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isScopedGraph(graph: string, root: string): boolean {
  return graph === root || graph.startsWith(`${root}/`);
}

/**
 * Classify one concrete named graph using the same layer rules previously
 * embedded in useMemoryEntities' three GRAPH-variable SPARQL queries.
 */
export function classifyMemoryGraph(
  graph: string,
  contextGraphId: string,
): MemoryLayerKey | undefined {
  const root = `did:dkg:context-graph:${contextGraphId}`;
  if (!isScopedGraph(graph, root)) return undefined;

  const isMeta = graph === `${root}/meta` || graph.includes('/meta/');
  if (
    graph.startsWith(`${root}/`)
    && (graph.includes('/assertion/') || graph.includes('/_working_memory/'))
    && !isMeta
    && !graph.endsWith('/_meta')
  ) {
    return 'wm';
  }

  if (
    (graph.endsWith('/_shared_memory') || graph.includes('/_shared_memory/'))
    && graph !== `${root}/meta/_shared_memory`
    && !isMeta
    && !graph.includes('/_shared_memory/staging/')
  ) {
    return 'swm';
  }

  if (
    !graph.includes('/assertion/')
    && !graph.includes('/_working_memory')
    && !graph.includes('/_shared_memory')
    && !graph.includes('_verifiable_memory_meta')
    && !graph.endsWith('/_meta')
    && !isMeta
    && !graph.includes('/_private')
    && !graph.includes('/_rules')
  ) {
    return 'vm';
  }

  return undefined;
}

async function listContextGraphNamedGraphs(
  store: TripleStore,
  contextGraphId: string,
  options?: QueryOptions,
): Promise<string[]> {
  const root = assertSafeIri(`did:dkg:context-graph:${contextGraphId}`);
  const graphs = store.listGraphsByPrefix
    ? await store.listGraphsByPrefix(root, options)
    : await store.listGraphs(options);
  return graphs
    .filter((graph) => isScopedGraph(graph, root))
    .map((graph) => assertSafeIri(graph))
    .sort();
}

function exactGraphUnion(graphs: readonly string[]): string {
  return graphs
    .map((graph) =>
      `{ GRAPH <${graph}> { ?s ?p ?o } BIND(<${graph}> AS ?g) }`)
    .join('\nUNION\n');
}

function buildLayerQuery(
  graphs: readonly string[],
  limit: number,
  layer: MemoryLayerKey,
): string {
  const predicateFilter = layer === 'swm'
    ? '\nFILTER(?p != <http://dkg.io/ontology/workspaceOwner>)'
    : '';
  return `SELECT ?s ?p ?o ?g WHERE {
${exactGraphUnion(graphs)}${predicateFilter}
}
LIMIT ${limit}`;
}

function buildStatsQuery(graphs: readonly string[]): string {
  return `SELECT ?g (COUNT(DISTINCT ?s) AS ?entities) (COUNT(*) AS ?triples)
WHERE {
${exactGraphUnion(graphs)}
}
GROUP BY ?g`;
}

function parseCount(value: unknown): number {
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'value' in value
      ? String((value as { value?: unknown }).value ?? '')
      : '';
  const match = raw.match(/^"?(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function readLayer(
  store: TripleStore,
  graphs: readonly string[],
  limit: number,
  layer: MemoryLayerKey,
  options: QueryOptions,
): Promise<MemoryLayerReadResult> {
  const bindings: MemoryLayerBinding[] = [];

  for (let offset = 0; offset < graphs.length; offset += EXACT_GRAPH_QUERY_BATCH_SIZE) {
    throwIfAborted(options.signal);
    const batch = graphs.slice(offset, offset + EXACT_GRAPH_QUERY_BATCH_SIZE);
    const remaining = limit - bindings.length;
    const result = await store.query(
      buildLayerQuery(batch, remaining + 1, layer),
      options,
    );
    if (result.type !== 'bindings') {
      throw new Error('Memory-layer read expected SELECT bindings');
    }

    for (const row of result.bindings) {
      if (
        typeof row.s !== 'string'
        || typeof row.p !== 'string'
        || typeof row.o !== 'string'
        || typeof row.g !== 'string'
      ) {
        throw new Error('Memory-layer read received an incomplete binding');
      }
      if (bindings.length === limit) {
        return { bindings, ok: true, truncated: true };
      }
      bindings.push({ s: row.s, p: row.p, o: row.o, g: row.g });
    }

    // Preserve the previous UI contract: reaching the fixed limit is a lower
    // bound even when the result happens to contain exactly that many rows.
    if (bindings.length === limit) {
      return { bindings, ok: true, truncated: true };
    }
  }

  return { bindings, ok: true, truncated: false };
}

/**
 * Read all three UI memory layers without ever binding a GRAPH variable.
 * Graph discovery is served by GraphSetIndexStore, then small UNION batches
 * target exact named graphs. Layers run serially so a single dashboard card
 * cannot occupy three external-store scheduler slots at once.
 */
export async function readMemoryLayers(
  store: TripleStore,
  contextGraphId: string,
  options: QueryOptions = {},
): Promise<MemoryLayersSnapshot> {
  const queryOptions: QueryOptions = {
    ...options,
    priority: options.priority ?? 'normal',
    source: options.source ?? 'node-ui.memory-layers',
  };
  const graphs = await listContextGraphNamedGraphs(store, contextGraphId, queryOptions);
  const byLayer: Record<MemoryLayerKey, string[]> = { wm: [], swm: [], vm: [] };
  for (const graph of graphs) {
    const layer = classifyMemoryGraph(graph, contextGraphId);
    if (layer) byLayer[layer].push(graph);
  }

  const layers = {} as Record<MemoryLayerKey, MemoryLayerReadResult>;
  for (const layer of LAYER_KEYS) {
    try {
      layers[layer] = await readLayer(
        store,
        byLayer[layer],
        MEMORY_LAYER_LIMITS[layer],
        layer,
        { ...queryOptions, source: `node-ui.memory-layers.${layer}` },
      );
    } catch (error) {
      if (isAborted(options.signal)) throw error;
      layers[layer] = { bindings: [], ok: false, truncated: false };
    }
  }
  return { layers };
}

/**
 * Compute the legacy per-named-graph subgraph counts with exact GRAPH IRIs.
 * This preserves the response semantics while avoiding one context-wide
 * GRAPH-variable aggregate and its giant query-engine VALUES allow-list.
 */
export async function readContextGraphNamedGraphStats(
  store: TripleStore,
  contextGraphId: string,
  options: QueryOptions = {},
): Promise<ContextGraphNamedGraphStats[]> {
  const queryOptions: QueryOptions = {
    ...options,
    priority: options.priority ?? 'normal',
    source: options.source ?? 'node-ui.sub-graph-stats',
  };
  const graphs = await listContextGraphNamedGraphs(store, contextGraphId, queryOptions);
  const stats: ContextGraphNamedGraphStats[] = [];

  for (let offset = 0; offset < graphs.length; offset += EXACT_GRAPH_QUERY_BATCH_SIZE) {
    throwIfAborted(queryOptions.signal);
    const batch = graphs.slice(offset, offset + EXACT_GRAPH_QUERY_BATCH_SIZE);
    const result = await store.query(buildStatsQuery(batch), queryOptions);
    if (result.type !== 'bindings') {
      throw new Error('Context-graph stats read expected SELECT bindings');
    }
    for (const row of result.bindings) {
      if (typeof row.g !== 'string' || !isScopedGraph(row.g, `did:dkg:context-graph:${contextGraphId}`)) {
        continue;
      }
      stats.push({
        graph: row.g,
        entityCount: parseCount(row.entities),
        tripleCount: parseCount(row.triples),
      });
    }
  }

  return stats;
}
