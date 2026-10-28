import type { ContextGraphPartitionRead } from '@origintrail-official/dkg-agent';
// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { QueryOptions, QueryResult } from '@origintrail-official/dkg-storage';

/** Both operations belong to one admitted, caller-bound partition reader. */
export interface ContextGraphReader {
  listPartitions(options: QueryOptions): Promise<ContextGraphPartitionRead[]>;
  query(sparql: string, options: QueryOptions, admission: ContextGraphPartitionRead['admission']): Promise<QueryResult>;
}

export interface ContextGraphNamedGraphStats {
  graph: string;
  entityCount: number;
  tripleCount: number;
}


export const EXACT_GRAPH_QUERY_BATCH_SIZE = 8;


function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }
}


function isScopedGraph(graph: string, root: string): boolean {
  return graph === root || graph.startsWith(`${root}/`);
}


export function planDiagnosticGraphReads(partitions: readonly ContextGraphPartitionRead[], contextGraphId: string) {
  const root = `did:dkg:context-graph:${contextGraphId}`;
  return [...partitions].sort((a, b) => a.graph.localeCompare(b.graph))
    .filter(partition => isScopedGraph(partition.graph, root))
    .map(partition => ({ ...partition, graph: assertSafeIri(partition.graph) }));
}

function buildStatsQuery(targets: readonly { graph: string }[]): string {
  return `SELECT ?g (COUNT(DISTINCT ?s) AS ?entities) (COUNT(*) AS ?triples)
WHERE {
${targets.map(({ graph }) => `{ GRAPH <${graph}> { ?s ?p ?o } BIND(<${graph}> AS ?g) }`).join(" UNION ")}
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

export async function readContextGraphNamedGraphStats(
  reader: ContextGraphReader,
  contextGraphId: string,
  options: QueryOptions = {},
): Promise<ContextGraphNamedGraphStats[]> {
  const queryOptions: QueryOptions = {
    ...options,
    priority: options.priority ?? 'background',
    source: options.source ?? 'node-ui.sub-graph-stats',
  };
  const discovered = await reader.listPartitions(queryOptions);
  const targets = planDiagnosticGraphReads(discovered, contextGraphId);
  const stats: ContextGraphNamedGraphStats[] = [];
  const groups = [targets.filter(target => target.admission === 'public'), targets.filter(target => target.admission === 'shared-memory')];
  for (const [index, group] of groups.entries()) {
    for (let offset = 0; offset < group.length; offset += EXACT_GRAPH_QUERY_BATCH_SIZE) {
      throwIfAborted(queryOptions.signal);
      const batch = group.slice(offset, offset + EXACT_GRAPH_QUERY_BATCH_SIZE);
      const result = await reader.query(buildStatsQuery(batch), { ...queryOptions, source: `${queryOptions.source}.${index === 1 ? 'swm' : 'public'}` }, batch[0].admission);
      if (result.type !== 'bindings') {
        throw new Error('Context-graph stats read expected SELECT bindings');
      }
      for (const row of result.bindings) {
        const term: unknown = row.g;
        const graph = typeof term === 'string' ? term : term && typeof term === 'object' && 'value' in term ? String(term.value) : '';
        if (!isScopedGraph(graph, `did:dkg:context-graph:${contextGraphId}`)) {
          continue;
        }
        stats.push({
          graph,
          entityCount: parseCount(row.entities),
          tripleCount: parseCount(row.triples),
        });
      }
    }

  }
  return stats;
}
