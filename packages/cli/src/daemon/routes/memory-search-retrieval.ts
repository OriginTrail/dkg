// SPDX-License-Identifier: Apache-2.0
import { escapeSparqlLiteral } from '@origintrail-official/dkg-core';
import type { RequestActor, RequestContext } from './context.js';
import { memorySearchPlans, memorySearchVectorScope } from './memory-search-scope.js';
import { createStoreQueryRequestLifecycle, isApiQueryCallerDisconnected } from '../store-query-lifecycle.js';

type Layer = 'wm' | 'swm' | 'vm';
interface SearchResult {
  entityUri: string;
  label: string | null;
  sources: string[];
  similarity: number | null;
  sourceFile: string | null;
  snippet: string | null;
  memoryLayer: Layer;
}
const TEXT_READ_CONCURRENCY = 4;
const layersByView = {
  'working-memory': 'wm', 'shared-working-memory': 'swm', 'verifiable-memory': 'vm',
} as const;

function compare(a: SearchResult, b: SearchResult): number {
  return (b.similarity ?? -1) - (a.similarity ?? -1);
}

/** Keep at most `limit` candidates per layer regardless of local-agent count. */
class LayerCandidates {
  private readonly rows: Map<Layer, Map<string, SearchResult>>;
  constructor(private readonly layers: readonly Layer[], private readonly limit: number) {
    this.rows = new Map(layers.map(layer => [layer, new Map()]));
  }
  add(row: SearchResult): void {
    const rows = this.rows.get(row.memoryLayer)!;
    const previous = rows.get(row.entityUri);
    if (previous) {
      const preferred = compare(previous, row) <= 0 ? previous : row;
      rows.set(row.entityUri, { ...preferred, sources: [...new Set([...previous.sources, ...row.sources])] });
    } else {
      rows.set(row.entityUri, row);
    }
    if (rows.size > this.limit) {
      // Stable ordering retains earlier equal-ranked results, independent of completion order.
      const ranked = [...rows.values()].sort(compare);
      rows.delete(ranked[ranked.length - 1].entityUri);
    }
  }
  finish(): SearchResult[] {
    const queues = this.layers.map(layer => [...this.rows.get(layer)!.values()].sort(compare));
    const selected = new Map<string, SearchResult>();
    // Round-robin gives every nonempty requested layer a slot when the budget permits.
    // Vector relevance orders results WITHIN each layer; it cannot erase another layer.
    while (selected.size < this.limit && queues.some(queue => queue.length > 0)) {
      for (const queue of queues) {
        let row = queue.shift();
        while (row && selected.has(row.entityUri)) row = queue.shift();
        if (!row) continue;
        selected.set(row.entityUri, row);
        if (selected.size === this.limit) break;
      }
    }
    for (const [uri, selectedRow] of selected) {
      for (const rows of this.rows.values()) {
        const other = rows.get(uri);
        if (other) selectedRow.sources = [...new Set([...selectedRow.sources, ...other.sources])];
      }
    }
    return [...selected.values()];
  }
}

/** Query the guarded agent views; graph discovery and caller isolation remain engine-owned. */
export async function retrieveMemorySearch(
  ctx: RequestContext, actor: RequestActor,
  input: { query: string; contextGraphId: string; memoryLayers: Layer[]; resultLimit: number },
): Promise<SearchResult[]> {
  const { agent, embeddingProvider, vectorStore } = ctx;
  const { query, contextGraphId, memoryLayers, resultLimit } = input;
  const lifecycle = createStoreQueryRequestLifecycle(ctx.req, ctx.res, 'api.memory.search');
  const candidates = new LayerCandidates(memoryLayers, resultLimit);
  try {
    lifecycle.signal.throwIfAborted();
    if (embeddingProvider && memoryLayers.length > 0) {
      try {
        const embedding = await embeddingProvider.embed(query);
        lifecycle.signal.throwIfAborted();
        // Each requested layer gets its own bounded vector budget. A global top-N
        // otherwise loses lower-scoring SWM/VM matches before fair merging can see them.
        for (const layer of memoryLayers) {
          lifecycle.signal.throwIfAborted();
          const rows = await vectorStore.search(embedding, {
            contextGraphId, memoryLayers: [layer], limit: resultLimit, minSimilarity: 0.3,
            workingMemoryScope: memorySearchVectorScope(agent, actor),
          });
          for (const row of rows) {
            if (row.memoryLayer !== layer) continue;
            candidates.add({ entityUri: row.entityUri, label: row.label ?? null,
              sources: ['vector'], similarity: Math.round(row.similarity * 1000) / 1000,
              sourceFile: row.sourceUri, snippet: row.snippet ?? null, memoryLayer: layer });
          }
        }
      } catch (error) {
        lifecycle.signal.throwIfAborted();
        if (isApiQueryCallerDisconnected(error)) throw error;
        // A failed optional vector provider does not prevent text retrieval.
      }
    }
    const escapedQuery = escapeSparqlLiteral(query.toLowerCase());
    const sparql = `SELECT DISTINCT ?entity ?name ?desc WHERE {
      GRAPH ?g {
        ?entity <http://schema.org/name>|<https://schema.org/name>|<http://www.w3.org/2000/01/rdf-schema#label> ?name .
        OPTIONAL { ?entity <http://schema.org/description>|<https://schema.org/description> ?desc }
      }
      FILTER(CONTAINS(LCASE(STR(?name)), "${escapedQuery}")
        || (BOUND(?desc) && CONTAINS(LCASE(STR(?desc)), "${escapedQuery}")))
    } LIMIT ${resultLimit}`;
    const plans = memorySearchPlans(memoryLayers, actor, () => agent.listLocalAgents());
    // A fixed-width batch bounds store pressure and retained replies. Merge in plan
    // order, so a fast co-tenant cannot change which equal-ranked matches survive.
    // All local agents remain eligible; no silent agent-count truncation is applied.
    for (let offset = 0; offset < plans.length; offset += TEXT_READ_CONCURRENCY) {
      lifecycle.signal.throwIfAborted();
      const batch = plans.slice(offset, offset + TEXT_READ_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(async plan => {
        lifecycle.signal.throwIfAborted();
        try {
          const result = await agent.query(sparql, {
            contextGraphId, view: plan.view, agentAddress: plan.agentAddress,
            callerAgentAddress: actor.authenticatedAgentAddress,
            signal: lifecycle.signal, priority: lifecycle.priority, source: lifecycle.source,
          });
          return result.bindings ?? [];
        } catch (error) {
          if (isApiQueryCallerDisconnected(error)) throw error;
          // One unavailable view remains non-fatal, as in the previous route.
          return [];
        }
      }));
      lifecycle.signal.throwIfAborted();
      for (const [index, reply] of settled.entries()) {
        if (reply.status === 'rejected') throw reply.reason;
        const rows = reply.value;
        for (const binding of rows) {
          if (!binding.entity) continue;
          candidates.add({ entityUri: binding.entity, label: binding.name ?? null,
            sources: ['sparql'], similarity: null, sourceFile: null, snippet: binding.desc ?? null,
            memoryLayer: layersByView[batch[index].view] });
        }
      }
    }
    return candidates.finish();
  } finally {
    lifecycle.dispose();
  }
}
