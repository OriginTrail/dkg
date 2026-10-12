import {
  assertSafeIri,
} from '@origintrail-official/dkg-core';
import type {
  PublicMemoryLayerBinding,
  PublicMemoryLayerKey,
  PublicMemoryLayerResult,
  PublicMemoryLayersResponse,
} from '@origintrail-official/dkg-core/memory-layer-result';
import type {
  QueryOptions,
  QueryResult,
} from '@origintrail-official/dkg-storage';

export interface MemoryReadOptions extends QueryOptions {
  includeQueryCatalog?: boolean;
}

export interface ContextGraphBatchPolicy {
  includeSharedMemory: boolean;
}

/** Both operations belong to one admitted, caller-bound partition reader. */
export interface ContextGraphReader {
  listGraphs(options: QueryOptions): Promise<string[]>;
  query(sparql: string, options: QueryOptions, policy: ContextGraphBatchPolicy): Promise<QueryResult>;
}

export type MemoryLayerKey = PublicMemoryLayerKey;
export type MemoryLayerBinding = PublicMemoryLayerBinding;
export type MemoryLayerReadResult = PublicMemoryLayerResult;
export type MemoryLayersSnapshot = Pick<PublicMemoryLayersResponse, 'layers'>;

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

/** One admitted graph's complete read plan; builders never reclassify its URI. */
export interface ContextGraphReadTarget {
  graph: string;
  layer: MemoryLayerKey | undefined;
  catalogQualification: 'query-catalog' | 'unqualified';
}

interface GraphReadPlanningOptions {
  purpose?: 'memory-layers' | 'named-graph-stats';
  includeQueryCatalog?: boolean;
}

/** Catalog visibility and qualification are selected together with the layer. */
export function classifyMemoryGraph(
  graph: string,
  contextGraphId: string,
  options: GraphReadPlanningOptions = {},
): ContextGraphReadTarget | undefined {
  const root = `did:dkg:context-graph:${contextGraphId}`;
  if (!isScopedGraph(graph, root)) return undefined;
  const stats = options.purpose === 'named-graph-stats';
  const isMeta = graph === `${root}/meta` || graph.includes('/meta/');
  const isSharedMemory = graph.endsWith('/_shared_memory') || graph.includes('/_shared_memory/');
  const catalogTail = graph.startsWith(`${root}/meta/`) ? graph.slice(`${root}/meta/`.length) : '';
  const catalogLayer = catalogTail.startsWith('assertion/') || catalogTail.startsWith('_working_memory/')
    ? 'wm' : catalogTail.startsWith('_shared_memory/') && !catalogTail.includes('/staging/') ? 'swm' : undefined;
  let layer: MemoryLayerKey | undefined;
  let catalogQualification: ContextGraphReadTarget['catalogQualification'] = 'unqualified';
  if (isMeta) {
    if (stats) layer = isSharedMemory ? 'swm' : catalogLayer;
    else if (options.includeQueryCatalog && catalogLayer) {
      layer = catalogLayer;
      catalogQualification = 'query-catalog';
    }
  } else if (graph.startsWith(`${root}/`)
    && (graph.includes('/assertion/') || graph.includes('/_working_memory/'))
    && !graph.endsWith('/_meta')) {
    layer = 'wm';
  } else if (isSharedMemory && !graph.includes('/_shared_memory/staging/')) {
    layer = 'swm';
  } else if (!graph.includes('/assertion/') && !graph.includes('/_working_memory')
    && !graph.includes('/_shared_memory') && !graph.includes('_verifiable_memory_meta')
    && !graph.endsWith('/_meta') && !graph.includes('/_private') && !graph.includes('/_rules')) {
    layer = 'vm';
  }
  // Diagnostic counts include every admitted graph; even hidden catalog SWM
  // counts retain the same shared-memory authority requirement as layer reads.
  if (stats && isSharedMemory) layer = 'swm';
  if (!stats && layer === undefined) return undefined;
  return { graph: assertSafeIri(graph), layer, catalogQualification };
}

function planGraphReads(graphs: readonly string[], contextGraphId: string, options: GraphReadPlanningOptions): ContextGraphReadTarget[] {
  return [...new Set(graphs)].sort().flatMap(graph => {
    const target = classifyMemoryGraph(graph, contextGraphId, options);
    return target ? [target] : [];
  });
}

function exactGraphUnion(targets: readonly ContextGraphReadTarget[]): string {
  return targets.map(({ graph, catalogQualification }) => {
    const qualification = catalogQualification === 'query-catalog'
      ? '?catalog a <http://dkg.io/ontology/profile/QueryCatalog> . ' : '';
    return `{ GRAPH <${graph}> { ${qualification}?s ?p ?o } BIND(<${graph}> AS ?g) }`;
  }).join('\nUNION\n');
}

function buildLayerQuery(targets: readonly ContextGraphReadTarget[], limit: number, layer: MemoryLayerKey): string {
  const predicateFilter = layer === 'swm'
    ? '\nFILTER(?p != <http://dkg.io/ontology/workspaceOwner>)' : '';
  return `SELECT ?s ?p ?o ?g WHERE {
${exactGraphUnion(targets)}${predicateFilter}
}
LIMIT ${limit}`;
}

function buildStatsQuery(targets: readonly ContextGraphReadTarget[]): string {
  return `SELECT ?g (COUNT(DISTINCT ?s) AS ?entities) (COUNT(*) AS ?triples)
WHERE {
${exactGraphUnion(targets)}
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
  targets: readonly ContextGraphReadTarget[],
  limit: number,
  layer: MemoryLayerKey,
  options: QueryOptions,
  query: ContextGraphReader['query'],
): Promise<MemoryLayerReadResult> {
  const bindings: MemoryLayerBinding[] = [];

  for (let offset = 0; offset < targets.length; offset += EXACT_GRAPH_QUERY_BATCH_SIZE) {
    throwIfAborted(options.signal);
    const batch = targets.slice(offset, offset + EXACT_GRAPH_QUERY_BATCH_SIZE);
    const remaining = limit - bindings.length;
    const result = await query(
      buildLayerQuery(batch, remaining + 1, layer),
      options,
      { includeSharedMemory: layer === 'swm' },
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
  reader: ContextGraphReader,
  contextGraphId: string,
  options: MemoryReadOptions = {},
): Promise<MemoryLayersSnapshot> {
  const { includeQueryCatalog: _catalog, ...storeOptions } = options;
  const queryOptions: QueryOptions = {
    ...storeOptions,
    priority: options.priority ?? 'background',
    source: options.source ?? 'node-ui.memory-layers',
  };
  const discovered = await reader.listGraphs(queryOptions);
  const targets = planGraphReads(discovered, contextGraphId, { includeQueryCatalog: options.includeQueryCatalog });
  const byLayer: Record<MemoryLayerKey, ContextGraphReadTarget[]> = { wm: [], swm: [], vm: [] };
  for (const target of targets) if (target.layer) byLayer[target.layer].push(target);

  const layers = {} as Record<MemoryLayerKey, MemoryLayerReadResult>;
  for (const layer of LAYER_KEYS) {
    try {
      layers[layer] = await readLayer(
        byLayer[layer],
        MEMORY_LAYER_LIMITS[layer],
        layer,
        { ...queryOptions, source: `node-ui.memory-layers.${layer}` },
        reader.query.bind(reader),
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
  reader: ContextGraphReader,
  contextGraphId: string,
  options: MemoryReadOptions = {},
): Promise<ContextGraphNamedGraphStats[]> {
  const { includeQueryCatalog: _catalog, ...storeOptions } = options;
  const queryOptions: QueryOptions = {
    ...storeOptions,
    priority: options.priority ?? 'background',
    source: options.source ?? 'node-ui.sub-graph-stats',
  };
  const discovered = await reader.listGraphs(queryOptions);
  const targets = planGraphReads(discovered, contextGraphId, { purpose: 'named-graph-stats' });
  const stats: ContextGraphNamedGraphStats[] = [];
  const groups = [targets.filter(target => target.layer !== 'swm'), targets.filter(target => target.layer === 'swm')];
  for (const [index, group] of groups.entries()) {
    for (let offset = 0; offset < group.length; offset += EXACT_GRAPH_QUERY_BATCH_SIZE) {
      throwIfAborted(queryOptions.signal);
      const batch = group.slice(offset, offset + EXACT_GRAPH_QUERY_BATCH_SIZE);
      const result = await reader.query(buildStatsQuery(batch), { ...queryOptions, source: `${queryOptions.source}.${index === 1 ? 'swm' : 'public'}` }, { includeSharedMemory: index === 1 });
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

  }
  return stats;
}
