import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { describe, expect, it, vi } from 'vitest';
import type {
  QueryOptions,
  QueryResult,
} from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
import { QueryMethods } from '../../agent/src/dkg-agent-query.js';
import {
  EXACT_GRAPH_QUERY_BATCH_SIZE,
  type ContextGraphReader,
  readContextGraphNamedGraphStats,
} from '../src/daemon/context-graph-read-model.js';

const CG = 'large-cg';
const ROOT = `did:dkg:context-graph:${CG}`;

function exactGraphs(sparql: string): string[] {
  return [...sparql.matchAll(/GRAPH <([^>]+)>/g)].map((match) => match[1]);
}

function mockReader(
  graphs: string[],
  queryImpl: (sparql: string, options?: QueryOptions) => Promise<QueryResult>,
): ContextGraphReader {
  return {
    listPartitions: vi.fn(async () => graphs.map(graph => ({ graph, admission: 'public' as const }))),
    query: vi.fn(queryImpl),
  };
}

describe('context-graph exact stats read model', () => {
  it.each([false, true])('gates catalog SWM graph counts through canonical shared-memory authority (%s)', async allowed => {
    const store = new OxigraphStore();
    const catalogGraph = `${ROOT}/meta/_shared_memory/0xabc/1`;
    try {
      await store.insert([
        { subject: `${ROOT}/meta`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${ROOT}/_meta` },
        { subject: `${ROOT}/meta`, predicate: 'http://schema.org/name', object: '"meta"', graph: `${ROOT}/_meta` },
        { subject: 'urn:catalog', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/profile/QueryCatalog', graph: catalogGraph },
        { subject: 'urn:ordinary', predicate: 'urn:p', object: 'urn:o', graph: ROOT },
      ]);
      const queryEngine = new DKGQueryEngine(store);
      const sharedGate = vi.fn(async () => ({ outcome: allowed ? 'allowed' : 'denied' }));
      const agent = { store, log: { info() {} }, queryEngine,
        resolveContextGraphReadAuthority: async () => ({ outcome: 'allowed' }),
        resolveSharedMemoryReadAdmission: sharedGate };
      const stats = await readContextGraphNamedGraphStats({
        listPartitions: options => queryEngine.listContextGraphQueryPartitionReads(CG, options),
        query: async (sparql, options, admission) => {
          const result = await QueryMethods.prototype.query.call(agent as never, sparql, {
            ...options, contextGraphId: CG, includeContextGraphPartitions: true,
            exactContextGraphPartitions: true, includeSharedMemory: admission === 'shared-memory',
            callerAgentAddress: '0xpublic-reader',
          });
          return { type: 'bindings', bindings: result.bindings };
        },
      }, CG, { source: 'changed-diagnostic-label' });
      expect(stats.find(row => row.graph === ROOT)).toMatchObject({ tripleCount: 1 });
      expect(sharedGate).toHaveBeenCalled();
      expect(stats.find(row => row.graph === catalogGraph)?.tripleCount ?? 0).toBe(allowed ? 1 : 0);
    } finally { await store.close(); }
  });

  it('computes subgraph stats in exact-IRI batches', async () => {
    const graphs = Array.from(
      { length: EXACT_GRAPH_QUERY_BATCH_SIZE + 1 },
      (_, index) => `${ROOT}/sg-${index}`,
    );
    const queries: string[] = [];
    const reader = mockReader(graphs, async (sparql) => {
      queries.push(sparql);
      return {
        type: 'bindings',
        bindings: exactGraphs(sparql).map((graph) => ({
          g: graph,
          entities: '"2"^^http://www.w3.org/2001/XMLSchema#integer',
          triples: '"3"^^http://www.w3.org/2001/XMLSchema#integer',
        })),
      };
    });

    const stats = await readContextGraphNamedGraphStats(reader, CG);

    expect(stats).toHaveLength(graphs.length);
    expect(stats[0]).toEqual({ graph: graphs[0], entityCount: 2, tripleCount: 3 });
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).not.toMatch(/GRAPH\s+\?g/i);
      expect(query).not.toMatch(/\bVALUES\b/i);
      expect(exactGraphs(query).length).toBeLessThanOrEqual(EXACT_GRAPH_QUERY_BATCH_SIZE);
    }
  });

});
