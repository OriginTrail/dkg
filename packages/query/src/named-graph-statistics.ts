// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { ContextGraphNamedGraphStats, ContextGraphPartitionRead, ContextGraphPartitionReadOptions } from './query-types.js';
import { createScopedContentGraphRoutePolicy } from './scoped-content-graph-policy.js';
import { authorizeExactContextGraphPartitions } from './exact-context-graph-partitions.js';
import { createQueryStoreReadContext } from './query-store-read-context.js';
import { ScopedQueryViolationError } from './scoped-query-error.js';

export const NAMED_GRAPH_STATS_BATCH_SIZE = 8;
export type NamedGraphStatsBatchGate = (admission: ContextGraphPartitionRead['admission'],
  read: () => Promise<ContextGraphNamedGraphStats[]>) => Promise<ContextGraphNamedGraphStats[]>;

/** Only generated aggregates reach this path: it accepts graph identities, not SPARQL. */
export async function readNamedGraphStatisticsBatch(store: TripleStore, contextGraphId: string,
  graphs: readonly string[], options: ContextGraphPartitionReadOptions = {}): Promise<ContextGraphNamedGraphStats[]> {
  options.signal?.throwIfAborted();
  if (graphs.length === 0) return [];
  if (graphs.length > NAMED_GRAPH_STATS_BATCH_SIZE) throw new Error('Statistics batch exceeds eight graphs');
  if ('includePrivate' in options && options.includePrivate) throw new Error('Named graph statistics only admit public partitions');
  const candidates = [...new Set(graphs)].map(graph => assertSafeIri(graph));
  const policy = createScopedContentGraphRoutePolicy(contextGraphId, options);
  const reads = createQueryStoreReadContext(store, options);
  const admission = await authorizeExactContextGraphPartitions(store, reads.catalog, policy, candidates);
  if (candidates.some(graph => !admission.allowed.includes(graph))) throw new ScopedQueryViolationError('Statistics graph is outside the current partition policy');
  admission.assertUnchanged();
  const result = await reads.query(`SELECT ?g (COUNT(DISTINCT ?s) AS ?entities) (COUNT(*) AS ?triples)
WHERE { ${candidates.map(graph => `{ GRAPH <${graph}> { ?s ?p ?o } BIND(<${graph}> AS ?g) }`).join(' UNION ')} } GROUP BY ?g`);
  options.signal?.throwIfAborted();
  admission.assertUnchanged();
  if (result.type !== 'bindings') throw new Error('Named graph statistics expected SELECT bindings');
  return result.bindings.filter(row => candidates.includes(row.g)).map(row => ({
    graph: row.g, entityCount: parseCount(row.entities), tripleCount: parseCount(row.triples),
  }));
}
function parseCount(value: string | undefined): number {
  const match = value?.match(/^"?(\d+)/);
  return match ? Number(match[1]) : 0;
}

export async function readPartitionStatistics(store: TripleStore, contextGraphId: string,
  partitions: readonly ContextGraphPartitionRead[], options: ContextGraphPartitionReadOptions,
  aroundBatch: NamedGraphStatsBatchGate = (_admission, read) => read()): Promise<ContextGraphNamedGraphStats[]> {
  const stats: ContextGraphNamedGraphStats[] = [];
  for (const admission of ['public', 'shared-memory'] as const) {
    const targets = partitions.filter(partition => partition.admission === admission).map(partition => partition.graph).sort();
    for (let offset = 0; offset < targets.length; offset += NAMED_GRAPH_STATS_BATCH_SIZE) {
      options.signal?.throwIfAborted();
      const batch = targets.slice(offset, offset + NAMED_GRAPH_STATS_BATCH_SIZE);
      stats.push(...await aroundBatch(admission, () => readNamedGraphStatisticsBatch(store, contextGraphId, batch,
        { ...options, source: `${options.source ?? 'query.named-graph-stats'}.${admission === 'public' ? 'public' : 'swm'}` })));
    }
  }
  return stats;
}
